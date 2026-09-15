import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordTableView } from '../../client/src/ui/record-table-view.js';

test('saved views freeze initial table columns and preserve authored column definitions', () => {
  const table = Object.create(RecordTableView.prototype);
  table.element = { querySelectorAll: () => [] };
  table.configure();
  const columns = table.captureColumns();
  assert.deepEqual(columns.map(column => column.field), ['/title', '/kind', '/start', '/end', '/sourceId', '/data/status']);
  assert.ok(columns.every(column => column.visible && column.width >= 44 && column.width <= 2000));
  table.configure({ columns, table: { scope: 'window', projection: 'matches', limit: 25 } });
  assert.deepEqual(table.captureColumns(), columns);
  assert.notEqual(table.captureColumns(), table.columns);
  assert.equal(table.scope, 'window'); assert.equal(table.projection, 'matches'); assert.equal(table.limit, 25);
  table.configure(); assert.equal(table.scope, 'all'); assert.equal(table.projection, 'context'); assert.equal(table.limit, 100);
});
