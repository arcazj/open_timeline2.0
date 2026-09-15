import { projectTime, timeDecimal, toMs, MAX_TIME } from './time-scale.js';
import { navigationMap } from './navigation-domain.js';

export function previewProjector(context) {
  const map = navigationMap(context.map);
  return time => projectTime(map, time, context.fromMs, context.toMs, context.width);
}

export function extendPreviewSessions(rows, project) {
  return { ...rows, items: (rows.items || []).map(item => {
    const record = item.record;
    if (!record) return item;
    const duration = record.kind === 'session' && record.end !== record.start;
    if (!duration && !Number.isFinite(item.baselineStart) && !Number.isFinite(item.baselineEnd)) return item;
    const next = { ...item };
    if (duration) {
      const end = project(record.end === null ? MAX_TIME : toMs(record.end));
      next.xStart = Math.min(item.xStart, project(toMs(record.start))); next.xEnd = Math.max(item.xEnd, end);
    }
    if (Number.isFinite(item.baselineStart)) next.baselineStart = project(toMs(record.originalStart ?? record.start));
    if (Number.isFinite(item.baselineEnd)) next.baselineEnd = project(record.originalEnd != null ? toMs(record.originalEnd)
      : duration ? record.end === null ? MAX_TIME : toMs(record.end) : toMs(record.start));
    return next;
  }) };
}

export function reprojectPreviewRows(rows, map, range, width, targetProject, baseRange) {
  let omitted = 0;
  const items = (rows.items || []).flatMap(item => {
    if (!item.record) return [{ ...item }];
    const record = item.record, start = timeDecimal(toMs(record.start));
    if (baseRange.recordIds?.has(record.id)) return [];
    const end = record.end === null ? null : timeDecimal(toMs(record.end));
    const point = record.kind === 'event' || end?.eq(start);
    const overlapsBase = point ? start.gte(baseRange.fromMs) && start.lt(baseRange.toMs)
      : start.lt(baseRange.toMs) && (!end || end.gt(baseRange.fromMs));
    // The canonical page owns all records already crossing its original viewport.
    if (overlapsBase) { omitted++; return []; }
    // Source layout coordinates may be clipped to its query map; timestamps are authoritative.
    const xStart = targetProject(start), xEnd = targetProject(point ? start : end ?? MAX_TIME), delta = xStart - item.xStart;
    const next = { ...item, xStart, xEnd };
    for (const field of ['labelX', 'iconX']) if (Number.isFinite(item[field])) next[field] = item[field] + delta;
    if (Number.isFinite(item.baselineStart)) next.baselineStart = targetProject(toMs(record.originalStart ?? record.start));
    if (Number.isFinite(item.baselineEnd)) next.baselineEnd = targetProject(record.originalEnd != null ? toMs(record.originalEnd) : point ? start : end ?? MAX_TIME);
    if (item.labelInsideBar && (next.labelX < Math.min(xStart, xEnd) || next.labelX + item.labelWidth > Math.max(xStart, xEnd))) { omitted++; return []; }
    next.footprintStart = Math.min(xStart, xEnd, next.labelX ?? xStart, next.iconX ?? xStart, next.baselineStart ?? xStart, next.baselineEnd ?? xStart);
    next.footprintEnd = Math.max(xStart, xEnd, (next.labelX ?? xEnd) + (item.labelWidth || 0), (next.iconX ?? xEnd) + (item.style?.icon ? 16 : 0), next.baselineStart ?? xEnd, next.baselineEnd ?? xEnd);
    return [next];
  });
  return { rows: { ...rows, items }, omitted };
}
