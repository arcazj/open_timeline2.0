import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { documentationProblems } from './check-repository.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(new URL('../' + file, import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = JSON.parse(await read('docs/sorting-filtering/cases.json'));
const evidence = JSON.parse(await read('docs/sorting-filtering/evidence.json'));
assert.equal(evidence.status, 'passed');
assert.equal(evidence.caseCount, 20);
assert.equal(evidence.caseSha256, hash(await read('docs/sorting-filtering/cases.json')));
assert.equal(evidence.legacyResults.length, 14);
assert.equal(cases.filters.length + cases.searches.length + 1, 14);
for (const test of cases.filters) {
  const result = evidence.legacyResults.find(item => item.id === test.id);
  if (test.expectedError) assert.equal(result.error, test.expectedError);
  else assert.deepEqual(result.ids, test.expectedIds);
}
for (const test of cases.searches) {
  const result = evidence.legacyResults.find(item => item.id === test.id);
  assert.deepEqual(result.ids, test.expectedIds);
  assert.deepEqual(result.yellowIds, test.expectedYellowIds);
}
assert.deepEqual(evidence.legacyResults.at(-1).ids, cases.dates.expectedLegacyIds);
for (const [file, expected] of Object.entries(evidence.currentSources)) assert.equal(hash(await read(file)), expected, `Reviewed current source changed: ${file}`);
const images = JSON.parse(await read('docs/sorting-filtering/ui-proposals.json'));
assert.equal(images.implementationVerified, false);
assert.equal(images.captures.length, 3);
for (const image of images.captures) {
  assert.equal(hash(await read('docs/sorting-filtering/' + image.file)), image.sha256);
  assert.equal(image.documentOverflow, false);
  assert.equal(image.clippedControls, 0);
}
const names = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean));
const docs = ['OpenBEXI_Timeline_Sorting_Filtering_Prompt.md', 'docs/filters-and-search.md', ...(await readdir(new URL('../docs/sorting-filtering/', import.meta.url))).filter(name => name.endsWith('.md')).map(name => 'docs/sorting-filtering/' + name)];
for (const file of docs) assert.deepEqual(documentationProblems(file, (await read(file)).toString(), names), [], file);
const prompt = (await read(docs[0])).toString();
for (let index = 1; index <= 11; index++) assert(prompt.includes(`## R${index}. `), `Missing R${index}`);
assert(prompt.includes('Version-1 requests remain unchanged'));
console.log('Specification links, R1-R11 coverage, 14 recorded Java cases, reviewed source hashes and three proposal hashes verified. Future features are not certified.');
