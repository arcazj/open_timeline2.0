import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const noticeName = /^(licen[cs]e|copying|notice)([._-].*)?$/i;
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));

export function embeddedJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export async function collectThirdPartyNotices(root) {
  const lock = await json(path.join(root, 'package-lock.json'));
  if (lock.lockfileVersion !== 3) throw new Error('Notice collection requires package-lock version 3');
  const packages = [], inputs = {};
  const textFile = async relative => {
    const bytes = await readFile(path.join(root, relative));
    if (!bytes.length || bytes.length > 1024 * 1024) throw new Error(`License text is empty or too large: ${relative}`);
    inputs[relative] = hash(bytes);
    return { path: relative, sha256: inputs[relative], text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  };
  for (const [directory, locked] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (!directory || locked.dev) continue;
    if (!directory.startsWith('node_modules/') || directory.includes('\\') || directory.split('/').some(part => part === '..' || !part)) throw new Error('Unsafe package directory in lockfile');
    const metadataPath = `${directory}/package.json`, metadata = await json(path.join(root, metadataPath));
    if (metadata.version !== locked.version || typeof metadata.name !== 'string') throw new Error(`Installed dependency differs from lockfile: ${directory}`);
    const license = typeof metadata.license === 'string' ? metadata.license : metadata.license?.type;
    if (!license) throw new Error(`Dependency requires reviewed license metadata: ${directory}`);
    const names = (await readdir(path.join(root, directory), { withFileTypes: true })).filter(entry => entry.isFile() && noticeName.test(entry.name)).map(entry => entry.name).sort();
    if (!names.some(name => /^(licen[cs]e|copying)/i.test(name))) throw new Error(`Dependency lacks a bundled license: ${directory}`);
    const notices = [];
    for (const name of names) notices.push(await textFile(`${directory}/${name}`));
    inputs[metadataPath] = hash(await readFile(path.join(root, metadataPath)));
    packages.push({ name: metadata.name, version: metadata.version, license, directory, integrity: locked.integrity ?? null, notices });
  }
  const assets = [
    { name: 'Unmodified legacy hazard PNG icons', license: 'GPL-3.0-or-later', source: 'https://github.com/arcazj/openbexi_timeline', notices: [await textFile('client/assets/legacy-hazards/LEGACY-LICENSE.txt')] },
    { name: 'Embedded Noto Sans font files and derived measurement tables', license: 'OFL-1.1', notices: [await textFile('client/assets/FONT-LICENSE.txt')] },
    { name: 'Unicode 15.1 case-folding data and derived lookup tables', license: 'Unicode-3.0', source: 'https://www.unicode.org/license.txt', notices: [await textFile('docs/licenses/UNICODE-LICENSE.txt')] },
  ];
  const document = { format: 'openbexi-third-party-notices', formatVersion: 1, scope: 'Standalone runtime dependencies and embedded data/assets; not a project source-code license', packages, assets };
  return { document, inputs };
}

export function assertNoticesCoverInputs(document, inputPaths) {
  for (const input of inputPaths) {
    if (!input.startsWith('node_modules/')) continue;
    const directory = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1];
    const owner = document.packages.find(item => item.directory === directory);
    if (!owner) throw new Error(`Bundled dependency has no license notice: ${input}`);
  }
}
