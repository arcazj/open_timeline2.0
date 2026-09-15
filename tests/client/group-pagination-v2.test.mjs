import test from 'node:test';
import assert from 'node:assert/strict';
import { collapsedGroupKeys, paginateGroupRows } from '../../client/src/timeline/group-pagination.js';

function layout(sizes, collapsed = []) {
  const rows = [], items = [], enclosures = [];
  let row = 0;
  for (const [index, count] of sizes.entries()) {
    const key = `string:SOURCE${index + 1}`;
    const hidden = collapsed.includes(key);
    rows.push({ row: row++, type: 'group', key, name: key.slice(7), collapsed: hidden, recordCount: count, matchCount: count });
    const start = row;
    if (!hidden) for (let item = 0; item < count; item++) items.push({ row: row++, record: { id: `${index}:${item}` } });
    if (!hidden && count > 1) enclosures.push({ parentId: items.at(-count).record.id, startRow: start, endRow: row });
  }
  return { rows, items, enclosures, totalRows: row };
}

test('continuation slots reserve readable header space and never orphan an expanded header', () => {
  const original = layout([5, 1, 2]);
  const result = paginateGroupRows(structuredClone(original), 3);
  assert.equal(result.totalRows, 15);
  assert.deepEqual(result.items.map(item => item.row), [1, 2, 4, 5, 7, 10, 13, 14]);
  assert.deepEqual(result.rows.map(row => [row.row, row.continuation]), [[0, false], [3, true], [6, true], [9, false], [12, false]]);
  assert.equal(result.logicalGroupTotal, 3); assert.equal(result.hiddenItemTotal, 0);
  assert.deepEqual(result.enclosures.map(item => [item.startRow, item.endRow]), [[1, 8], [13, 15]]);
  assert.equal(new Set(result.items.map(item => item.record.id)).size, original.items.length);
  for (let start = 0; start < result.totalRows; start += 3) {
    assert.ok(result.items.some(item => item.row >= start && item.row < start + 3));
    for (const row of result.rows.filter(item => item.row >= start && item.row < start + 3)) assert.ok(row.row % 3 < 2);
  }
});

test('collapse is keyed by exact typed identity and keeps hidden counts separate', () => {
  const result = paginateGroupRows(layout([5, 1, 2], ['string:SOURCE1']), 2);
  assert.equal(result.logicalGroupTotal, 3); assert.equal(result.collapsedGroupTotal, 1); assert.equal(result.hiddenItemTotal, 5);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map(item => item.row), [3, 5, 7]);
  assert.deepEqual([...collapsedGroupKeys(['string:(missing)', 'missing:'], 2)], ['string:(missing)', 'missing:']);
  assert.equal(paginateGroupRows(layout([5, 2], ['string:SOURCE1', 'string:SOURCE2']), 1).totalRows, 2);
  for (const value of [null, ['SOURCE1'], ['string:A', 'string:A'], ['string:e\u0301', 'string:\u00e9']]) assert.throws(() => collapsedGroupKeys(value, 2), { code: 'invalid_group' });
  assert.throws(() => collapsedGroupKeys(['string:A'], 1), { code: 'invalid_group' });
  assert.throws(() => paginateGroupRows(layout([1]), 1), { code: 'row_height_limit' });
});

test('all supported grouped page capacities progress with exact unique record traversal', () => {
  for (const capacity of [2, 3, 4, 7, 32, 100]) for (const sizes of [[1], [1, 1, 1], [201, 1, 15], [5, 8, 3, 1]]) {
    const source = layout(sizes), result = paginateGroupRows(structuredClone(source), capacity), seen = [];
    for (let start = 0; start < result.totalRows; start += capacity) {
      const items = result.items.filter(item => start <= item.row && item.row < start + capacity);
      assert.ok(items.length > 0, `capacity ${capacity}, page ${start}`);
      seen.push(...items.map(item => item.record.id));
      assert.ok(result.rows.some(row => row.row >= start && row.row < start + capacity));
    }
    assert.deepEqual(seen, source.items.map(item => item.record.id));
  }
});
