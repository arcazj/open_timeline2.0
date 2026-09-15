import { createTimeMap, projectTime, timeDecimal, toMs } from './time-scale.js';
import { measureText } from './text-metrics.js';
import { buildPresentationLayout } from './layout-presentation.js';
import { packFootprints } from './row-packer.js';
import { normalizeStringOrder } from '../data/string-order.js';
import { collapsedGroupKeys } from './group-pagination.js';

export { measureText } from './text-metrics.js';

export const RENDER_PROFILE = 'noto-sans-latin-v1';

function fitLabel(title, fontSize, width) {
  const measured = measureText(title, fontSize);
  if (measured.width <= width) return { displayTitle: title, labelWidth: measured.width, overflow: false };
  if (measureText('...', fontSize).width > width) throw Object.assign(new Error('Label cannot fit the admitted render profile; use a wider view or smaller approved font'), { code: 'label_width_limit', status: 422 });
  const chars = Array.from(title);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureText(chars.slice(0, mid).join('') + '...', fontSize).width <= width) lo = mid;
    else hi = mid - 1;
  }
  const displayTitle = chars.slice(0, lo).join('') + '...';
  return { displayTitle, labelWidth: measureText(displayTitle, fontSize).width, overflow: true };
}

export function overlaps(record, from, to) {
  const start = timeDecimal(toMs(record.start));
  const left = timeDecimal(from);
  const right = timeDecimal(to);
  if (record.kind === 'event' || (record.end !== null && toMs(record.end) === toMs(record.start))) return start.gte(left) && start.lt(right);
  return start.lt(right) && (record.end === null || timeDecimal(toMs(record.end)).gt(left));
}

export function buildLayout(records, rawMap, input, matches = new Set()) {
  normalizeStringOrder(input.groupOrder === undefined ? {} : input.groupOrder, input.definitionVersion === undefined ? 1 : input.definitionVersion);
  collapsedGroupKeys(input.collapsedGroups, input.definitionVersion ?? 1);
  if (input.definitionVersion === 2 || input.presentation !== undefined || records.some(record => Object.keys(record.render ?? {}).some(key => key !== 'color') && overlaps(record, input.viewFromMs ?? input.from, input.viewToMs ?? input.to))) return buildPresentationLayout(records, rawMap, input, matches, overlaps);
  const map = createTimeMap(rawMap);
  const from = input.viewFromMs ?? input.from;
  const to = input.viewToMs ?? input.to;
  const width = Number(input.width);
  const fontSize = Number(input.fontSize ?? 13);
  const rowHeight = Number(input.rowHeight ?? 32);
  const availableHeight = Number(input.availableHeight ?? 480);
  if (!(width >= 64 && width <= 8192) || !Number.isFinite(width) || !(fontSize >= 10 && fontSize <= 32) || rowHeight < Math.max(32, fontSize + 19) || rowHeight > 128 || !Number.isFinite(rowHeight)) throw Object.assign(new RangeError('Invalid render dimensions'), { code: 'invalid_profile', status: 422 });
  if (!(availableHeight >= rowHeight && availableHeight <= 8192)) throw Object.assign(new RangeError('Insufficient data height'), { code: 'row_height_limit', status: 422 });
  if (input.renderProfileId && input.renderProfileId !== RENDER_PROFILE) throw Object.assign(new Error('Unsupported render profile'), { code: 'unsupported_profile', status: 422 });
  if (!['none', 'sourceId', 'kind'].includes(input.groupBy ?? 'none')) throw Object.assign(new Error('Unsupported grouping'), { code: 'invalid_group', status: 422 });
  const left = timeDecimal(from);
  const right = timeDecimal(to);
  if (!right.gt(left)) throw new RangeError('Invalid detail range');
  const domainStart = map.decimalKnots[0].t;
  const domainEnd = map.decimalKnots.at(-1).t;
  if (left.lt(domainStart) || right.gt(domainEnd)) throw new RangeError('Detail range outside map');
  const eligible = records.filter(r => overlaps(r, from, to));
  eligible.sort((a, b) => toMs(a.start) - toMs(b.start) || ((a.end === null ? Infinity : toMs(a.end)) - (b.end === null ? Infinity : toMs(b.end))) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groups = new Map();
  for (const record of eligible) {
    const key = input.groupBy && input.groupBy !== 'none' ? record[input.groupBy] : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const items = [];
  const structuralRows = [];
  let offset = 0;
  for (const name of [...groups.keys()].sort()) {
    if (input.groupBy && input.groupBy !== 'none') structuralRows.push({ row: offset++, type: 'group', name });
    const groupItems = [];
    for (const record of groups.get(name)) {
      const start = timeDecimal(toMs(record.start));
      const end = record.end === null && record.kind === 'session' ? domainEnd : record.end === null ? start : timeDecimal(toMs(record.end));
      const clippedStart = start.lt(domainStart) ? domainStart : start;
      const clippedEnd = end.gt(domainEnd) ? domainEnd : end;
      const xStart = projectTime(map, clippedStart, from, to, width);
      const xEnd = projectTime(map, clippedEnd, from, to, width);
      const point = record.kind === 'event' || end.eq(start);
      let label = fitLabel(record.title, fontSize, width - 12);
      let labelX = Math.max(6, Math.min(width - 6 - label.labelWidth, xStart));
      if (point) {
        const rightSpace = width - 6 - (xStart + 10);
        const leftSpace = xStart - 16;
        const fullWidth = measureText(record.title, fontSize).width;
        const rightSide = fullWidth <= rightSpace || (fullWidth > leftSpace && rightSpace >= leftSpace);
        label = fitLabel(record.title, fontSize, Math.max(12, rightSide ? rightSpace : leftSpace));
        labelX = rightSide ? xStart + 10 : xStart - 10 - label.labelWidth;
      }
      const footprintStart = Math.max(0, Math.min(xStart - (point ? 6 : 2), labelX - 2));
      const footprintEnd = Math.min(width, Math.max(xEnd + (point ? 6 : 2), labelX + label.labelWidth + 2));
      groupItems.push({ record, row: 0, xStart, xEnd, labelX, ...label, footprintStart, footprintEnd, match: matches.has(record.id) });
    }
    const packed = packFootprints(groupItems);
    groupItems.forEach((item, index) => { item.row = offset + packed.rows[index]; items.push(item); });
    offset += packed.count;
  }
  return { items, rows: structuralRows, totalRows: offset, detailTotal: eligible.length, detailMatchTotal: eligible.filter(r => matches.has(r.id)).length, renderInstanceTotal: eligible.length, rowHeight, pageCapacity: Math.min(100, Math.floor(availableHeight / rowHeight)), from, to, width, fontSize };
}
