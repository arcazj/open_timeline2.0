import { createTimeMap, projectTime, timeDecimal, toMs } from './time-scale.js';
import { measureText, wrapLabel } from './text-metrics.js';
import { compareGroups, groupStyle, groupValue, recordLabel, resolvePresentation, resolveRecordStyle, isHazardIcon } from './presentation.js';
import { normalizeStringOrder } from '../data/string-order.js';
import { collapsedGroupKeys, paginateGroupRows } from './group-pagination.js';

const failure = (code, message) => Object.assign(new Error(message), { code, status: 422 });
const compareRecords = (a, b) => toMs(a.start) - toMs(b.start) || ((a.end === null ? Infinity : toMs(a.end)) - (b.end === null ? Infinity : toMs(b.end))) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const compareSiblings = (a, b) => (a.record.order ?? 0) - (b.record.order ?? 0) || compareRecords(a.record, b.record);

export function buildPresentationLayout(records, rawMap, input, matches, overlaps) {
  const groupOrder = normalizeStringOrder(input.groupOrder === undefined ? {} : input.groupOrder, input.definitionVersion === undefined ? 1 : input.definitionVersion);
  const collapsed = collapsedGroupKeys(input.collapsedGroups, input.definitionVersion ?? 1);
  const map = createTimeMap(rawMap), from = input.viewFromMs ?? input.from, to = input.viewToMs ?? input.to;
  const width = Number(input.width), fontSize = Number(input.fontSize ?? 13), requestedHeight = Number(input.rowHeight ?? 32), availableHeight = Number(input.availableHeight ?? 480);
  if (!(width >= 64 && width <= 8192) || !Number.isFinite(width) || !(fontSize >= 10 && fontSize <= 32) || !Number.isFinite(fontSize) || !Number.isFinite(requestedHeight) || requestedHeight < Math.max(32, fontSize + 19) || requestedHeight > 192) throw failure('invalid_profile', 'Invalid render dimensions');
  if (!Number.isFinite(availableHeight) || availableHeight > 8192 || availableHeight < requestedHeight) throw failure('row_height_limit', 'Insufficient data height');
  if (input.renderProfileId && input.renderProfileId !== 'noto-sans-latin-v1') throw failure('unsupported_profile', 'Unsupported render profile');
  if (!['none', 'sourceId', 'kind'].includes(input.groupBy ?? 'none')) throw failure('invalid_group', 'Unsupported grouping selector');
  const left = timeDecimal(from), right = timeDecimal(to), domainStart = map.decimalKnots[0].t, domainEnd = map.decimalKnots.at(-1).t;
  if (!right.gt(left) || left.lt(domainStart) || right.gt(domainEnd)) throw failure('invalid_layout', 'Detail range must be inside the map');
  const presentation = resolvePresentation(input);
  const bandSources = presentation.bandLayout?.find(band => band.role === 'primary')?.sourceIds;
  const eligible = records.filter(record => (!bandSources || bandSources.includes(record.sourceId)) && overlaps(record, from, to)).sort(compareRecords);
  const groups = new Map(), items = [], rows = [], enclosures = [];
  let rowHeight = presentation.compact ? 21 : requestedHeight;
  const project = value => projectTime(map, timeDecimal(value).clamp(domainStart, domainEnd), from, to, width);
  for (const record of eligible) {
    const group = groupValue(record, presentation);
    if (!groups.has(group.key)) groups.set(group.key, { ...group, items: [], recordCount: 0, matchCount: 0, collapsed: collapsed.has(group.key) });
    groups.get(group.key).recordCount++;
    if (matches.has(record.id)) groups.get(group.key).matchCount++;
    if (collapsed.has(group.key)) continue;
    const style = resolveRecordStyle(record, presentation), fullLabel = recordLabel(record, presentation);
    const start = timeDecimal(toMs(record.start));
    const end = record.end === null && record.kind === 'session' ? domainEnd : record.end === null ? start : timeDecimal(toMs(record.end));
    const point = record.kind === 'event' || end.eq(start);
    const xStart = project(start), xEnd = project(end);
    let label, labelX;
    const bitmapPoint = point && isHazardIcon(style.icon);
    const iconX = style.icon ? xStart - (bitmapPoint ? 8 : point ? style.pointRadius + 21 : 20) : null;
    if (point) {
      const rightStart = xStart + (bitmapPoint ? 8 : style.pointRadius) + 5;
      const leftEnd = style.icon ? iconX - 4 : xStart - style.pointRadius - 5;
      const rightSpace = width - 6 - rightStart, leftSpace = leftEnd - 6;
      const fullWidth = Math.max(...fullLabel.split('\n').map(text => measureText(text, style.fontSize, style.fontWeight, style.fontStyle).width));
      const rightSide = fullWidth <= rightSpace || (fullWidth > leftSpace && rightSpace >= leftSpace);
      label = wrapLabel(fullLabel, style, rightSide ? rightSpace : leftSpace, presentation.labels.maxLines);
      labelX = rightSide ? rightStart : leftEnd - label.labelWidth;
    } else {
      label = wrapLabel(fullLabel, style, width - 12, presentation.labels.maxLines);
      labelX = Math.max(6, Math.min(width - 6 - label.labelWidth, xStart));
    }
    const labelLineHeight = Math.ceil(style.fontSize * 1.35), labelOffsetY = presentation.compact ? 2 : 6;
    let geometryOffsetY = presentation.compact ? point ? 2 + label.labelLines.length * labelLineHeight / 2 : 2 + label.labelLines.length * labelLineHeight + style.barHeight / 2 : point ? 6 + Math.max(16, label.labelLines.length * labelLineHeight) / 2 : 8 + label.labelLines.length * labelLineHeight + style.barHeight / 2;
    const inside = !point && !style.icon && presentation.durationLabels === 'inside-when-fitting' && labelX >= xStart && labelX + label.labelWidth + 4 <= Math.min(width, xEnd);
    if (inside) { style.barHeight = Math.max(style.barHeight, label.labelLines.length * labelLineHeight + 2); labelX += 2; geometryOffsetY = labelOffsetY + label.labelLines.length * labelLineHeight / 2; }
    let neededHeight = Math.max(labelOffsetY + label.labelLines.length * labelLineHeight + 6, geometryOffsetY + (point ? Math.max(style.pointRadius, 8) : Math.max(style.barHeight / 2, style.icon ? 8 : 0)) + 6);
    if (presentation.compact) neededHeight = Math.max(labelOffsetY + label.labelLines.length * labelLineHeight, geometryOffsetY + (point ? style.pointRadius : style.barHeight / 2)) + 2;
    let footprintStart = Math.min(xStart - (point ? style.pointRadius + 2 : 2), labelX - 2);
    let footprintEnd = Math.max(xEnd + (point ? style.pointRadius + 2 : 2), labelX + label.labelWidth + 2);
    if (style.icon) { footprintStart = Math.min(footprintStart, iconX - 2); footprintEnd = Math.max(footprintEnd, iconX + 18); }
    const item = { record, row: 0, xStart, xEnd, labelX, ...label, labelLineHeight, labelOffsetY, geometryOffsetY, style, parentId: record.parentSessionId ?? null, depth: 0, ancestorIds: [], match: matches.has(record.id) };
    if (inside) item.labelInsideBar = true;
    if (style.icon) item.iconX = iconX;
    if (presentation.baseline.enabled && (record.originalStart != null || record.originalEnd != null)) {
      const baselineStart = project(record.originalStart ?? record.start);
      const baselineEnd = project(record.originalEnd ?? (record.end === null && record.kind === 'session' ? domainEnd : record.end ?? record.start));
      item.baselineStart = baselineStart; item.baselineEnd = baselineEnd;
      item.baselineOffsetY = Math.max(geometryOffsetY + (point ? style.pointRadius : style.barHeight / 2) + 3, point ? labelOffsetY + label.labelLines.length * labelLineHeight + 3 : 0);
      footprintStart = Math.min(footprintStart, baselineStart - 2, baselineEnd - 2);
      footprintEnd = Math.max(footprintEnd, baselineStart + 2, baselineEnd + 2);
      neededHeight = Math.max(neededHeight, item.baselineOffsetY + 0.5 + 6);
    }
    item.footprintStart = Math.max(0, footprintStart); item.footprintEnd = Math.min(width, footprintEnd);
    rowHeight = Math.max(rowHeight, Math.ceil(neededHeight));
    groups.get(group.key).items.push(item);
  }
  if (rowHeight > 192 || rowHeight > availableHeight) throw failure('row_height_limit', 'Resolved labels and graphics do not fit the available row height');
  let offset = 0;
  for (const group of [...groups.values()].sort((a, b) => compareGroups(a, b, presentation.grouping.direction, groupOrder))) {
    if (presentation.grouping.field) {
      rows.push({ row: offset++, type: 'group', name: group.name, key: group.key, style: groupStyle(group, presentation), ...(input.definitionVersion === 2 ? { collapsed: group.collapsed, recordCount: group.recordCount, matchCount: group.matchCount } : {}) });
    }
    if (group.collapsed) continue;
    const groupIds = new Set(group.items.map(item => item.record.id));
    if (presentation.nesting.enabled && group.items.some(item => groupIds.has(item.parentId))) {
      const byId = new Map(group.items.map(item => [item.record.id, item]));
      const children = new Map(group.items.map(item => [item.record.id, []]));
      const roots = [];
      for (const item of group.items) {
        if (item.parentId && byId.has(item.parentId)) children.get(item.parentId).push(item);
        else roots.push(item);
      }
      let visited = 0;
      const visit = (item, ancestors) => {
        if (ancestors.length > 8 || ancestors.includes(item.record.id)) throw failure('invalid_parent', 'Parent nesting is cyclic or too deep');
        item.row = offset++; item.depth = ancestors.length; item.ancestorIds = [...ancestors]; items.push(item); visited++;
        const startRow = item.row;
        let xMin = item.footprintStart, xMax = item.footprintEnd;
        for (const child of children.get(item.record.id).sort(compareSiblings)) {
          const extent = visit(child, [...ancestors, item.record.id]);
          xMin = Math.min(xMin, extent.xMin); xMax = Math.max(xMax, extent.xMax);
        }
        if (children.get(item.record.id).length) enclosures.push({ parentId: item.record.id, title: item.record.title, startRow, endRow: offset, xStart: Math.max(0, xMin - 4), xEnd: Math.min(width, xMax + 4), color: presentation.nesting.color, opacity: presentation.nesting.opacity, depth: ancestors.length });
        return { xMin, xMax };
      };
      roots.sort((a, b) => compareRecords(a.record, b.record)).forEach(root => visit(root, []));
      if (visited !== group.items.length) throw failure('invalid_parent', 'Parent nesting contains a cycle');
    } else {
      const packed = packFootprints(group.items);
      group.items.forEach((item, index) => { item.row = offset + packed.rows[index]; items.push(item); });
      offset += packed.count;
    }
  }
  enclosures.sort((a, b) => a.startRow - b.startRow || b.endRow - a.endRow || (a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1 : 0));
  const result = { items, rows, enclosures, presentation, totalRows: offset, detailTotal: eligible.length, detailMatchTotal: eligible.filter(record => matches.has(record.id)).length, renderInstanceTotal: items.length, rowHeight, pageCapacity: Math.min(100, Math.floor(availableHeight / rowHeight)), from, to, width, fontSize };
  return input.definitionVersion === 2 ? paginateGroupRows(result, result.pageCapacity) : result;
}
import { packFootprints } from './row-packer.js';
