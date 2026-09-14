import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildStandalone } from './build-standalone.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts/demo');
const files = ['index.html', 'THIRD-PARTY-NOTICES.json'];
await mkdir(output, { recursive: true });
// Never publish an old export or an accidentally copied runtime directory.
for (const entry of await readdir(output)) {
  if (![...files, '.nojekyll'].includes(entry)) throw new Error(`Unexpected demo artifact: ${entry}. Review this directory before publishing.`);
}
const manifest = await buildStandalone();
for (const file of files) await copyFile(path.join(root, 'dist', file), path.join(output, file));
await writeFile(path.join(output, '.nojekyll'), '');
console.log(`Prepared artifacts/demo: ${manifest.htmlBytes} HTML bytes, SHA-256 ${manifest.htmlSha256}.`);
console.log('Includes all six bundled datasets. Review redistribution rights before public deployment.');
