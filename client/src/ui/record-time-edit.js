import Decimal from 'decimal.js';
import { invertPosition, timeDecimal, toIso, toMs } from '../timeline/time-scale.js';

const MIN_TIME = toMs('-009999-01-01T00:00:00.000Z');
const MAX_TIME = toMs('9999-12-31T23:59:59.999Z');
const integer = value => timeDecimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

export function validateRecordTimes(record, start, end) {
  const nextStart = integer(start), nextEnd = end === null ? null : integer(end);
  if (record.kind === 'event' && nextEnd !== null) throw new Error('A point event has no end time.');
  if (nextStart.lt(MIN_TIME) || nextStart.gt(MAX_TIME) || (nextEnd && (nextEnd.lt(nextStart) || nextEnd.gt(MAX_TIME)))) throw new Error('Times must remain in astronomical years -9999 through 9999, with end at or after start.');
  const payload = { start: toIso(nextStart.toFixed()), end: nextEnd ? toIso(nextEnd.toFixed()) : null };
  return { payload, changed: payload.start !== record.start || payload.end !== record.end };
}

export function changeRecordTime(record, operation, value) {
  const start = timeDecimal(record.start), end = record.end === null ? null : timeDecimal(record.end);
  let nextStart = start, nextEnd = end;
  if (operation === 'move') {
    const delta = Decimal.max(MIN_TIME - start.toNumber(), Decimal.min(integer(value), MAX_TIME - (end || start).toNumber()));
    nextStart = start.plus(delta); if (end) nextEnd = end.plus(delta);
  } else if (operation === 'start') nextStart = integer(value);
  else if (operation === 'end' || operation === 'close') {
    if (record.kind !== 'session') throw new Error('A point event has no end time.');
    if (operation === 'end' && end === null) throw new Error('Close an ongoing session explicitly.');
    if (operation === 'close' && end !== null) throw new Error('This session is already closed.');
    nextEnd = integer(value);
  } else throw new Error('Unsupported time command.');
  return validateRecordTimes(record, nextStart, nextEnd);
}

export function pointerRecordTime(record, operation, frozen, grabX, currentX) {
  const at = x => timeDecimal(invertPosition(frozen.map, Math.max(0, Math.min(frozen.width, x)), frozen.fromMs, frozen.toMs, frozen.width));
  return changeRecordTime(record, operation, operation === 'move' ? at(currentX).minus(at(grabX)) : at(currentX));
}

export function parentTimeWarning(record, parent) {
  if (!parent || parent.id !== record.parentSessionId) return '';
  if (timeDecimal(record.start).lt(timeDecimal(parent.start)) || (parent.end !== null && (record.end === null && record.kind === 'session' || timeDecimal(record.end || record.start).gt(timeDecimal(parent.end))))) return 'Outside parent time extent. Parent and child times are independent; no related records were moved.';
  return '';
}

export function sourceCanEdit(actor, source) {
  if (!actor || !(actor.capabilities || []).some(value => value === '*' || value === 'records.edit')) return false;
  if (!source || source.lifecycle !== 'active' || !(actor.sourceIds || []).includes(source.id)) return false;
  const published = source.versions?.at(-1)?.definition;
  return published?.enabled === true && published?.writable === true;
}
