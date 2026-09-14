import test from 'node:test';
import assert from 'node:assert/strict';
import { compileExpression, compileSearch, fieldValue } from '../../client/src/data/filter-expression.js';

const expression = node => ({ version: 1, root: node });
const fieldTypes = { '/data/approved': 'boolean', '/data/a~1b/~0key': 'number', '/data/label': 'string' };
test('schema-scoped predicates support boolean semantics and escaped JSON pointers', () => {
  const record = { data: { approved: false, 'a/b': { '~key': 42 } } };
  assert.equal(fieldValue(record, '/data/a~1b/~0key'), 42);
  assert.equal(compileExpression(expression({ op: 'eq', field: '/data/approved', value: false }), { fieldTypes })(record), true);
  assert.equal(compileExpression(expression({ op: 'in', field: '/data/approved', values: [true, null] }), { fieldTypes })(record), false);
  assert.equal(compileExpression(expression({ op: 'gte', field: '/data/a~1b/~0key', value: 42 }), { fieldTypes })(record), true);
  assert.throws(() => compileExpression(expression({ op: 'gt', field: '/data/approved', value: false }), { fieldTypes }), /Boolean/);
  assert.throws(() => compileExpression(expression({ op: 'eq', field: '/data/approved', value: false })), /undeclared/);
  assert.throws(() => compileExpression(expression({ op: 'eq', field: '/data/approved', value: 0 }), { fieldTypes }), /incompatible/);
});
test('scoped search accepts declared scalar fields but never broadens the default registry', () => {
  const input = { search: 'false', searchFields: ['/data/approved'] };
  assert.equal(compileSearch(input, { fieldTypes }).matches({ data: { approved: false } }), true);
  assert.equal(compileSearch(input, { fieldTypes }).matches({ data: {} }), false);
  assert.throws(() => compileSearch(input), /declared/);
});
