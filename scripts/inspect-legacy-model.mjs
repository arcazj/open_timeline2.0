import { readFile, open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { dryRunLegacyVisualModel } from '../client/src/data/legacy-visual-adapter.js';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, output: { type: 'string' },
  'source-label': { type: 'string' }, 'source-commit': { type: 'string' },
}, strict: true });
if (!values.input || !values.output) throw new Error('Required: --input <legacy.json> --output <new-report.json>');
const input = path.resolve(values.input), output = path.resolve(values.output);
if (input === output) throw new Error('The report must not replace its input.');
const original = await readFile(input, 'utf8');
const report = await dryRunLegacyVisualModel(original, {
  sourcePath: values['source-label'] || path.basename(input),
  sourceCommit: values['source-commit'],
});
await mkdir(path.dirname(output), { recursive: true });
const file = await open(output, 'wx');
try {
  await file.writeFile(JSON.stringify(report, null, 2) + '\n', 'utf8');
  await file.sync();
} finally { await file.close(); }
console.log(`Dry-run report written to ${output}. No catalog changes were made. Conversion allowed: ${report.canCreate}.`);
