import test from 'node:test';
import assert from 'node:assert/strict';
import { changeRecordTime, pointerRecordTime, validateRecordTimes, parentTimeWarning, sourceCanEdit } from '../../client/src/ui/record-time-edit.js';
const record = { id: 'session', kind: 'session', start: '2026-09-12T01:00:00.000Z', end: '2026-09-12T02:00:00.000Z', sourceId: 'ops' };
test('elapsed movement preserves duration, point kind, null ongoing ends and millisecond rounding', () => {
  assert.deepEqual(changeRecordTime(record, 'move', 1.5).payload, { start: '2026-09-12T01:00:00.002Z', end: '2026-09-12T02:00:00.002Z' });
  assert.equal(changeRecordTime(record, 'move', 0.1).changed, false);
  assert.equal(changeRecordTime({ ...record, kind: 'event', end: null }, 'move', -1000).payload.end, null);
  assert.equal(changeRecordTime({ ...record, end: null }, 'move', 1000).payload.end, null);
});
test('independent finite endpoints never flip and ongoing closure must be explicit', () => {
  assert.equal(changeRecordTime(record, 'start', record.end).payload.end, record.end);
  assert.throws(() => changeRecordTime(record, 'start', '2026-09-12T03:00:00.000Z'));
  assert.throws(() => changeRecordTime(record, 'end', '2026-09-12T00:00:00.000Z'));
  assert.throws(() => changeRecordTime({ ...record, end: null }, 'end', record.end));
  assert.equal(changeRecordTime({ ...record, end: null }, 'close', record.end).payload.end, record.end);
  assert.throws(() => changeRecordTime(record, 'close', record.end));
  assert.throws(() => changeRecordTime({ ...record, kind: 'event', end: null }, 'end', record.end));
});
test('movement clamps the complete interval to the supported timestamp domain', () => {
  const early = { ...record, start: '-009999-01-01T00:00:00.000Z', end: '-009999-01-01T01:00:00.000Z' };
  assert.equal(changeRecordTime(early, 'move', -100).changed, false);
  const late = { ...record, start: '9999-12-31T22:59:59.999Z', end: '9999-12-31T23:59:59.999Z' };
  assert.equal(changeRecordTime(late, 'move', 100).changed, false);
  assert.equal(validateRecordTimes(record, '2026-09-12T03:00:00.000Z', '2026-09-12T04:00:00.000Z').changed, true);
});
test('adaptive inverse movement uses one UTC delta, not equal endpoint pixel offsets', () => {
  const from = Date.parse('2026-09-12T00:00:00.000Z'), hour = 3600000;
  const context = { map: { domain: { from: new Date(from).toISOString(), to: new Date(from + 4 * hour).toISOString() }, knots: [{ timeMs: String(from), u: '0' }, { timeMs: String(from + hour), u: '0.1' }, { timeMs: String(from + 2 * hour), u: '0.5' }, { timeMs: String(from + 4 * hour), u: '1' }] }, fromMs: String(from), toMs: String(from + 4 * hour), width: 1000 };
  const proposal = pointerRecordTime(record, 'move', context, 100, 300);
  assert.deepEqual(proposal.payload, { start: '2026-09-12T01:30:00.000Z', end: '2026-09-12T02:30:00.000Z' });
  assert.equal(pointerRecordTime(record, 'end', context, 500, 750).payload.end, '2026-09-12T03:00:00.000Z');
});
test('parent diagnostics are non-mutating and detect events and ongoing sessions outside bounds', () => {
  const child = { ...record, parentSessionId: 'parent' }, parent = { ...record, id: 'parent' };
  assert.equal(parentTimeWarning(child, parent), '');
  assert.match(parentTimeWarning({ ...child, start: '2026-09-12T00:00:00.000Z' }, parent), /Outside parent/);
  assert.match(parentTimeWarning({ ...child, end: null }, parent), /Outside parent/);
  assert.equal(parentTimeWarning({ ...child, kind: 'event', end: null }, parent), '');
  assert.equal(parentTimeWarning({ ...child, end: null }, { ...parent, end: null }), '');
});
test('edit eligibility requires actor grant plus active published writable source', () => {
  const actor = { capabilities: ['records.edit'], sourceIds: ['ops'] }, source = { id: 'ops', lifecycle: 'active', versions: [{ definition: { enabled: true, writable: true } }] };
  assert.equal(sourceCanEdit(actor, source), true);
  assert.equal(sourceCanEdit({ ...actor, capabilities: ['records.read'] }, source), false);
  assert.equal(sourceCanEdit({ ...actor, sourceIds: [] }, source), false);
  assert.equal(sourceCanEdit(actor, { ...source, lifecycle: 'archived' }), false);
  assert.equal(sourceCanEdit(actor, { ...source, versions: [{ definition: { enabled: true, writable: false } }] }), false);
  assert.equal(sourceCanEdit(actor, { ...source, versions: [] }), false);
});
