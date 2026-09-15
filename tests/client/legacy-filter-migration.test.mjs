import test from 'node:test';
import assert from 'node:assert/strict';
import cases from '../../shared/fixtures/legacy-filter-migration-cases.json' with { type: 'json' };
import { migrateLegacyFilter } from '../../client/src/data/legacy-filter-migration.js';
for (const entry of cases.cases) test(`legacy filter migration: ${entry.id}`, () => {
  const before = JSON.stringify(entry.input), result = migrateLegacyFilter(entry.input);
  assert.equal(result.classification, entry.classification); assert.equal(result.publishable, entry.publishable);
  if (entry.classification === 'blocked') assert.equal(result.draft, null);
  else assert.equal(result.draft.expression?.root.op ?? null, entry.root);
  assert.equal(JSON.stringify(entry.input), before);
});
