import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordTableView } from '../../client/src/ui/record-table-view.js';

const tick = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
function fixture(beforeRead) {
  const calls = [], errors = [], context = { provider: { identity: 'server', queryRecords: async (...args) => { calls.push(args); return { items: [], total: 0 }; } }, query: { queryId: 'query', definitionVersion: 1 } };
  const view = new RecordTableView({ element: { addEventListener() {} }, context: () => context,
    onChange() {}, onError: error => errors.push(error), beforeRead });
  view.render = () => {}; view.visible = true;
  return { view, context, calls, errors };
}

test('table rows await foreground admission and release it after reading', async () => {
  let admit, released = 0;
  const { view, calls } = fixture(() => new Promise(resolve => { admit = resolve; }));
  const pending = view.sync(); await tick(); assert.equal(calls.length, 0);
  admit(() => { released++; }); await pending;
  assert.equal(calls.length, 1); assert.equal(released, 1); assert.equal(view.pending, false);
});

test('a superseded table read releases its admission without issuing an obsolete query', async () => {
  let admit, released = 0;
  const { view, calls } = fixture(() => new Promise(resolve => { admit = resolve; }));
  const pending = view.sync(); await tick(); view.suspend();
  admit(() => { released++; }); await pending;
  assert.equal(calls.length, 0); assert.equal(released, 1);
});

test('structured busy failures stay errors and release table admission', async () => {
  let released = 0;
  const { view, context, errors } = fixture(async () => () => { released++; });
  const busy = Object.assign(new Error('Preparation busy'), { code: 'preparation_capacity', status: 429 });
  context.provider.queryRecords = async () => { throw busy; };
  await view.sync(); assert.deepEqual(errors, [busy]); assert.equal(released, 1); assert.equal(view.key, null);
});

test('canceled CSV export waits for then releases admission without a query or download', async () => {
  let admit, released = 0;
  const { view, calls, errors } = fixture(() => new Promise(resolve => { admit = resolve; }));
  const pending = view.exportCsv(); await tick(); view.exportController.abort();
  admit(() => { released++; }); await pending;
  assert.equal(calls.length, 0); assert.equal(released, 1); assert.equal(view.exporting, false); assert.deepEqual(errors, []);
});
