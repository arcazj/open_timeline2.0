import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = (await build({ entryPoints: ['client/src/ui/active-conditions.js'], bundle: true, format: 'esm', write: false, loader: { '.css': 'empty' } })).outputFiles[0].text;
const { activeConditionEntries, removeActiveCondition } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`);
const leaf = value => ({ op: 'eq', field: '/title', value });

test('condition chips split only the top-level conjunction and remove exact subtrees', () => {
  const or = { op: 'or', args: [leaf('A'), leaf('B')] }, not = { op: 'not', arg: leaf('C') };
  const expression = { version: 2, root: { op: 'and', ruleId: 'root', args: [or, not, leaf('D')] } }, before = structuredClone(expression);
  assert.deepEqual(activeConditionEntries(expression).map(entry => entry.label), ['Any of 2 conditions', 'Not (Title = "C")', 'Title = "D"']);
  assert.deepEqual(removeActiveCondition(expression, 1), { version: 2, root: { op: 'and', ruleId: 'root', args: [or, leaf('D')] } });
  assert.deepEqual(removeActiveCondition({ version: 1, root: { op: 'and', args: [or, not] } }, 1), { version: 1, root: or });
  assert.deepEqual(expression, before);
  assert.equal(activeConditionEntries({ version: 2, root: or }).length, 1);
  assert.equal(removeActiveCondition({ version: 2, root: or }, 0), null);
  assert.throws(() => removeActiveCondition(expression, 5), /no longer/);
});
