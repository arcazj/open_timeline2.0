import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { collectThirdPartyNotices, assertNoticesCoverInputs, embeddedJson } from './third-party-notices.mjs';
import { collectHelpContent } from './help-content.mjs';
import { instantFormat } from '../client/src/timeline/time-scale.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));

export async function buildStandalone({ datasetPath = 'data/default-dataset.json' } = {}) {
  const notices = await collectThirdPartyNotices(root);
  const help = await collectHelpContent(root);
  const dataset = await json(datasetPath);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addFormat('timeline-instant', instantFormat);
  ajv.addSchema(await json('shared/schemas/record-render.schema.json'));
  ajv.addSchema(await json('shared/schemas/presentation.schema.json'));
  ajv.addSchema(await json('shared/schemas/record.schema.json'));
  ajv.addSchema(await json('shared/schemas/visual-definition.schema.json'));
  ajv.addSchema(await json('shared/schemas/visual-model.schema.json'));
  ajv.addSchema(await json('shared/schemas/configuration-definition.schema.json'));
  ajv.addSchema(await json('shared/schemas/configuration-resource.schema.json'));
  ajv.addSchema(await json('shared/schemas/configuration-state.schema.json'));
  const validate = ajv.compile(await json('shared/schemas/snapshot.schema.json'));
  if (!validate(dataset)) throw new Error(`Invalid embedded snapshot: ${ajv.errorsText(validate.errors)}`);
  if (dataset.records.length !== dataset.manifest.recordCount || new Set(dataset.records.map(r => r.id)).size !== dataset.records.length) {
    throw new Error('Embedded snapshot counts or identities are inconsistent');
  }
  const catalog = await json('data/catalog.json');
  const testDatasets = [], libraryInputs = ['data/catalog.json'];
  for (const entry of catalog.datasets) {
    const snapshot = await json(entry.file), report = await json(entry.report);
    if (!validate(snapshot) || snapshot.manifest.recordCount !== snapshot.records.length || new Set(snapshot.records.map(record => record.id)).size !== snapshot.records.length) throw new Error(`Invalid test dataset ${entry.id}: ${ajv.errorsText(validate.errors)}`);
    const referenceImage = entry.reference ? `data:image/png;base64,${(await readFile(path.join(root, entry.reference))).toString('base64')}` : null;
    testDatasets.push({ id: entry.id, title: entry.title, yaml: entry.yaml, report, referenceImage, snapshot: JSON.stringify(snapshot) });
    libraryInputs.push(entry.file, entry.report, entry.yaml, ...(entry.reference ? [entry.reference] : []));
  }
  const worker = await build({
    absWorkingDir: root, entryPoints: ['client/src/data/local-worker.js'], bundle: true,
    outfile: 'dist/local-worker.js', write: false, format: 'iife', platform: 'browser',
    target: ['chrome120', 'firefox121'], minify: true, legalComments: 'eof',
    charset: 'ascii', metafile: true, sourcemap: false,
  });
  const workerSource = worker.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  if (!workerSource) throw new Error('No Local worker JavaScript produced');
  const result = await build({
    absWorkingDir: root, entryPoints: ['client/src/app.js'], bundle: true,
    outfile: 'dist/application.js', write: false, format: 'iife', platform: 'browser',
    target: ['chrome120', 'firefox121'], minify: true, legalComments: 'eof',
    charset: 'ascii', metafile: true, sourcemap: false,
    define: { __OPENBEXI_LOCAL_WORKER_SOURCE__: JSON.stringify(workerSource) },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
  });
  const external = [...Object.values(result.metafile.outputs), ...Object.values(worker.metafile.outputs)].flatMap(output => output.imports).filter(item => item.external);
  if (external.length) throw new Error(`Standalone build has external imports: ${JSON.stringify(external)}`);
  const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
  if (!js) throw new Error('No application JavaScript produced');
  const template = await readFile(path.join(root, 'client/index.template.html'), 'utf8');
  for (const marker of ['<!-- APP_DATA -->', '<!-- APP_STYLES -->', '<!-- APP_SCRIPT -->', '<!-- APP_LICENSES -->', '<!-- APP_HELP -->', '<!-- APP_TEST_DATA -->']) {
    if (!template.includes(marker)) throw new Error(`Template missing ${marker}`);
  }
  const encoded = JSON.stringify(dataset).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = template.replace('<!-- APP_DATA -->', () => encoded)
    .replace('<!-- APP_TEST_DATA -->', () => embeddedJson(testDatasets))
    .replace('<!-- APP_LICENSES -->', () => embeddedJson(notices.document))
    .replace('<!-- APP_HELP -->', () => embeddedJson(help.document))
    .replace('<!-- APP_STYLES -->', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace('<!-- APP_SCRIPT -->', () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist/index.html'), html);
  const packages = await json('package.json');
  const inputs = {};
  for (const name of [...new Set([...Object.keys(result.metafile.inputs), ...Object.keys(worker.metafile.inputs)])].sort()) inputs[name] = hash(await readFile(path.join(root, name)));
  assertNoticesCoverInputs(notices.document, Object.keys(inputs));
  Object.assign(inputs, notices.inputs);
  Object.assign(inputs, help.inputs);
  for (const name of ['client/index.template.html', datasetPath, 'scripts/build-standalone.mjs', 'scripts/third-party-notices.mjs', 'scripts/help-content.mjs', ...libraryInputs]) inputs[name] = hash(await readFile(path.join(root, name)));
  const manifest = {
    version: packages.version, format: 'standalone-build-v1', htmlSha256: hash(html),
    htmlBytes: Buffer.byteLength(html), datasetSha256: hash(JSON.stringify(dataset)),
    recordCount: dataset.records.length, externalRuntimeImports: external,
    testDatasets: testDatasets.map(entry => ({ id: entry.id, recordCount: entry.report.outputRecords, referenceStatus: entry.report.referenceStatus })),
    localWorker: { format: 'embedded-classic-blob', sourceSha256: hash(workerSource), sourceBytes: Buffer.byteLength(workerSource), externalRuntimeImports: [] },
    packageLockSha256: hash(await readFile(path.join(root, 'package-lock.json'))),
    dependencies: packages.dependencies, inputs,
    thirdPartyNotices: { embedded: true, sha256: hash(embeddedJson(notices.document)), packages: notices.document.packages.length, assets: notices.document.assets.length },
    help: { embedded: true, sha256: hash(embeddedJson(help.document)), documents: Object.keys(help.document.documents).length, swaggerVersion: packages.dependencies['swagger-ui-dist'] },
  };
  await writeFile(path.join(root, 'dist/THIRD-PARTY-NOTICES.json'), JSON.stringify(notices.document, null, 2) + '\n');
  await writeFile(path.join(root, 'dist/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(root, 'dist/dependency-graph.json'), JSON.stringify({ ...result.metafile, localWorker: worker.metafile }, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildStandalone();
  console.log(`Built dist/index.html: ${(manifest.htmlBytes / 1024).toFixed(0)} KiB, ${manifest.recordCount} complete initial records, no external runtime imports.`);
}
