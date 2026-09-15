import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function collectHelpContent(root) {
  const inputs = {};
  const read = async file => {
    const data = await readFile(path.join(root, file));
    inputs[file] = createHash('sha256').update(data).digest('hex');
    return data.toString('utf8');
  };
  const names = {
    'README.md': 'README', 'docs/release-history.md': 'Release history',
    'docs/third-party-notices.md': 'Licenses', 'docs/api.md': 'API guide',
    'docs/api-contract.md': 'OpenAPI contract', 'docs/local-source-paths.md': 'Server YAML and sources',
    'docs/local-scaling.md': 'Local scaling', 'docs/standalone-mode.md': 'Standalone mode',
    'docs/implementation-status.md': 'Implementation status', 'docs/testing.md': 'Testing',
    'docs/help-and-sharing.md': 'Help and sharing',
    'docs/calendar-navigation.md': 'Calendar and navigation',
    'docs/on-demand-loading.md': 'On-demand server loading',
    'docs/local-test-data.md': 'Local test datasets',
    'docs/sorting-filtering/implementation-status.md': 'Sorting, filtering and descriptors',
    'docs/sorting-filtering/legacy-preferences.md': 'Read-only source preferences',
    'docs/sorting-filtering/regex-qualification.md': 'Safe regular expressions',
  };
  const documents = {};
  for (const [file, title] of Object.entries(names)) documents[file] = { title, markdown: await read(file) };
  const metadata = JSON.parse(await read('package.json'));
  const spec = JSON.parse(await read('shared/openapi.json'));
  const swagger = { js: await read('node_modules/swagger-ui-dist/swagger-ui-bundle.js'), css: await read('node_modules/swagger-ui-dist/swagger-ui.css') };
  return { inputs, document: { version: metadata.version, projectUrl: 'https://github.com/arcazj/open_timeline2.0', documents, spec, swagger } };
}
