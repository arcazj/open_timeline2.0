const X_FIELDS = ['xStart', 'xEnd', 'labelX', 'iconX', 'baselineStart', 'baselineEnd', 'footprintStart', 'footprintEnd'];
const finite = Number.isFinite;
const point = item => item.record.kind === 'event' || item.record.end !== null && item.record.end === item.record.start;
const headers = rows => [...(rows.rows ?? []), ...(rows.items ?? []).filter(item => item.type === 'group')];

function footprint(item, fontSize) {
  if (![item.xStart, item.xEnd, item.labelX, item.labelWidth].every(finite) || item.labelWidth < 0) return null;
  const styled = item.style && item.labelLines, isPoint = point(item);
  const radius = styled ? isPoint ? item.style.pointRadius : item.style.barHeight / 2 : isPoint ? 4.5 : 4;
  const center = styled ? item.geometryOffsetY : isPoint ? fontSize / 2 + 3.5 : fontSize + 12;
  const labelTop = styled ? item.labelOffsetY : 0;
  const labelHeight = styled ? item.labelLines.length * item.labelLineHeight : fontSize + 7;
  if (![radius, center, labelTop, labelHeight].every(finite) || radius < 0 || labelHeight < 0) return null;
  const result = {
    left: Math.min(item.xStart - (isPoint ? radius + 2 : 4), item.labelX - 2),
    right: Math.max(item.xEnd + (isPoint ? radius + 2 : 4), item.xStart + (isPoint ? radius + 2 : 8), item.labelX + item.labelWidth + 3),
    top: Math.min(labelTop, center - radius - 2), bottom: Math.max(labelTop + labelHeight, center + radius + 2),
  };
  if (item.iconX != null) {
    if (!finite(item.iconX)) return null;
    result.left = Math.min(result.left, item.iconX - 4); result.right = Math.max(result.right, item.iconX + 20);
    result.top = Math.min(result.top, center - 12); result.bottom = Math.max(result.bottom, center + 12);
  }
  if (item.baselineStart != null || item.baselineEnd != null) {
    if (![item.baselineStart, item.baselineEnd, item.baselineOffsetY].every(finite)) return null;
    result.left = Math.min(result.left, item.baselineStart - 2, item.baselineEnd - 2);
    result.right = Math.max(result.right, item.baselineStart + 2, item.baselineEnd + 2);
    result.top = Math.min(result.top, item.baselineOffsetY); result.bottom = Math.max(result.bottom, item.baselineOffsetY + 1);
  }
  return result;
}

function rowGroups(rows, groupBy) {
  const structural = headers(rows).sort((a, b) => a.row - b.row);
  const grouped = structural.length > 0 || !!rows.presentation?.grouping?.field || groupBy !== 'none';
  const key = header => typeof header.key === 'string' ? header.key : groupBy !== 'none' && typeof header.name === 'string' ? `${groupBy}:${header.name}` : null;
  return {
    grouped,
    at(row) {
      if (!grouped) return '';
      const header = structural.findLast(item => item.row <= row);
      return !header || header.row === row || header.collapsed ? null : key(header);
    },
    structural: new Set(structural.map(item => item.row)),
  };
}

function nestedRows(rows) {
  const blocked = new Set();
  for (const enclosure of rows.enclosures ?? []) {
    const first = Math.max(rows.startRow, enclosure.startRow), last = Math.min(rows.startRow + rows.pageCapacity, enclosure.endRow);
    for (let row = first; row < last; row++) blocked.add(row);
  }
  for (const item of rows.items ?? []) if (item.record && (item.depth > 0 || item.ancestorIds?.length || rows.presentation?.nesting?.enabled && (item.parentId || item.record.parentSessionId))) blocked.add(item.row);
  return blocked;
}

// These rows are disposable drag geometry, never canonical pagination or query coverage.
export function mergeNavigationPreviewRows(baseRows, neighbors, { groupBy = 'none', fontSize = 13, maxItems = 1000 } = {}) {
  if (!Array.isArray(neighbors) || !Number.isInteger(maxItems) || maxItems < 0 || !finite(fontSize) || fontSize <= 0) throw new TypeError('Invalid navigation preview options');
  const items = [...(baseRows.items ?? [])], reasons = new Set(), omittedByReason = {};
  const coverage = { added: 0, duplicates: 0, omitted: 0, partial: false, reasons: [], omittedByReason };
  const omit = (reason, count = 1) => { coverage.omitted += count; omittedByReason[reason] = (omittedByReason[reason] ?? 0) + count; reasons.add(reason); };
  const seen = new Set(items.filter(item => item.record).map(item => item.record.id));
  const groups = rowGroups(baseRows, groupBy), blocked = nestedRows(baseRows), occupied = new Map();
  const first = baseRows.startRow, last = first + baseRows.pageCapacity, height = baseRows.rowHeight;
  let invalidBase = !Number.isInteger(first) || !Number.isInteger(baseRows.pageCapacity) || baseRows.pageCapacity < 1 || baseRows.pageCapacity > 100 || !finite(height) || height <= 0;
  const positioned = (bounds, row) => ({ ...bounds, top: bounds.top + row * height, bottom: bounds.bottom + row * height });
  const remember = bounds => {
    for (let row = Math.floor(bounds.top / height); row < Math.ceil(bounds.bottom / height); row++) {
      const bucket = occupied.get(row) ?? []; bucket.push(bounds); occupied.set(row, bucket);
    }
  };
  for (const item of items) if (item.record) {
    const bounds = footprint(item, fontSize);
    if (!bounds || !Number.isInteger(item.row)) invalidBase = true;
    else if (!invalidBase) remember(positioned(bounds, item.row));
  }
  if (baseRows.pageComplete === false || baseRows.pageCount > 1 || baseRows.nextCursor || baseRows.previousCursor) reasons.add('base-page-partial');
  const compatible = bounds => {
    for (let row = Math.floor(bounds.top / height); row < Math.ceil(bounds.bottom / height); row++) {
      for (const other of occupied.get(row) ?? []) if (!(bounds.right + 4 <= other.left || bounds.left >= other.right + 4 || bounds.bottom <= other.top || bounds.top >= other.bottom)) return false;
    }
    return true;
  };
  for (const neighbor of neighbors) {
    const source = neighbor?.rows, records = source?.items?.filter(item => item.record) ?? [];
    if (!source || !finite(neighbor.offsetX)) { omit('invalid-neighbor', records.length); continue; }
    if (source.pageComplete === false || source.pageCount > 1 || source.nextCursor || source.previousCursor) reasons.add('neighbor-page-partial');
    const otherGroups = rowGroups(source, groupBy), nested = nestedRows(source);
    const mismatch = ['queryId', 'snapshotId', 'generation', 'revision', 'mapId'].some(key => baseRows[key] != null && source[key] != null && baseRows[key] !== source[key]);
    for (const original of records) {
      if (seen.has(original.record.id)) { coverage.duplicates++; continue; }
      if (invalidBase) { omit('invalid-base-geometry'); continue; }
      if (mismatch) { omit('incompatible-snapshot'); continue; }
      if (source.rowHeight !== height) { omit('row-height-changed'); continue; }
      if (groups.grouped !== otherGroups.grouped) { omit('grouping-changed'); continue; }
      if (nested.has(original.row)) { omit('hierarchy-requires-layout'); continue; }
      if (items.length >= maxItems) { omit('preview-item-limit'); continue; }
      const item = { ...original };
      for (const key of X_FIELDS) if (item[key] != null) item[key] += neighbor.offsetX;
      const bounds = footprint(item, fontSize), group = otherGroups.at(original.row);
      if (!bounds) { omit('invalid-item-geometry'); continue; }
      if (group === null) { omit('group-context-unavailable'); continue; }
      let placed = false;
      for (let row = first; row < last; row++) {
        if (groups.structural.has(row) || blocked.has(row) || groups.at(row) !== group || groups.grouped && row >= baseRows.endRow) continue;
        const positionedBounds = positioned(bounds, row);
        if (!compatible(positionedBounds)) continue;
        item.row = row; items.push(item); remember(positionedBounds); seen.add(item.record.id); coverage.added++; placed = true; break;
      }
      if (!placed) omit('no-compatible-free-row');
    }
  }
  coverage.reasons = [...reasons]; coverage.partial = reasons.size > 0;
  return { rows: { ...baseRows, items, previewOnly: true }, coverage };
}
