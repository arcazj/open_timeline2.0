import test from 'node:test';
import assert from 'node:assert/strict';
import { filterFieldLabel, filterOperator, changeFilterOperator } from '../../client/src/ui/filter-editor-state.js';
import { compileExpression } from '../../client/src/data/filter-expression.js';

test('friendly field labels retain JSON-pointer segments without evaluating them', () => {
  assert.equal(filterFieldLabel('/title'), 'Title'); assert.equal(filterFieldLabel('/data/namespace'), 'Namespace');
  assert.equal(filterFieldLabel('/data/custom~1field/recordStatus'), 'Custom/field / Record Status');
  assert.equal(filterFieldLabel('/data/~0value'), '~value');
  assert.equal(filterFieldLabel('/data/constructor'), 'Constructor');
});

test('null, missing and value selectors preserve three-valued filter semantics', () => {
  const records = [{ data: {} }, { data: { status: null } }, { data: { status: '' } }, { data: { status: 'ready' } }];
  for (const [operator, expected] of [['isNull', [false, true, false, false]], ['isMissing', [true, false, false, false]], ['hasValue', [false, false, true, true]]]) {
    const node = { op: 'contains', field: '/data/status', value: 'old', caseSensitive: true, ruleId: 'status-rule' };
    changeFilterOperator(node, operator, 'string');
    assert.equal(filterOperator(node), operator); assert.equal(node.ruleId, 'status-rule');
    assert.equal(Object.hasOwn(node, 'caseSensitive'), false);
    assert.deepEqual(records.map(compileExpression({ version: 2, root: node })), expected);
  }
});

test('changing between regex and ordinary predicates removes incompatible options but keeps rule identity', () => {
  const node = { op: 'eq', field: '/title', value: 'old', ruleId: 'title-rule' };
  changeFilterOperator(node, 'regex', 'string');
  assert.deepEqual(node, { field: '/title', ruleId: 'title-rule', op: 'regex', pattern: '', flags: [], matchMode: 'search', dialect: 're2-common-v1' });
  node.pattern = '^Event'; changeFilterOperator(node, 'in', 'string');
  assert.deepEqual(node, { field: '/title', ruleId: 'title-rule', op: 'in', values: [] });
  changeFilterOperator(node, 'overlaps', 'date'); assert.equal(Object.hasOwn(node, 'field'), false); assert.equal(node.ruleId, 'title-rule');
});
