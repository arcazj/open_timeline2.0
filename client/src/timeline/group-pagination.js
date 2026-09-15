const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 422 }); };

export function collapsedGroupKeys(value = [], definitionVersion = 1) {
  if (!Array.isArray(value) || value.length > 1000 || value.some(key => typeof key !== 'string' || Array.from(key).length > 4096 || !['number:', 'string:', 'boolean:', 'null:', 'missing:'].some(prefix => key.startsWith(prefix)))) fail('invalid_group', 'Collapsed groups require at most 1000 bounded typed group keys');
  if (definitionVersion !== 2 && value.length) fail('invalid_group', 'Group collapse requires definition version 2');
  const keys = value.map(key => key.normalize('NFC'));
  if (new Set(keys).size !== keys.length) fail('invalid_group', 'Collapsed group keys must be unique');
  return new Set(keys);
}

export function paginateGroupRows(layout, capacity) {
  const groups = new Map(layout.rows.map(row => [row.row, row]));
  const counts = {
    logicalGroupTotal: layout.rows.length,
    collapsedGroupTotal: layout.rows.filter(row => row.collapsed).length,
    hiddenItemTotal: layout.rows.reduce((total, row) => total + (row.collapsed ? row.recordCount : 0), 0),
  };
  if (!groups.size) return { ...layout, ...counts };
  if (capacity < 2 && layout.rows.some(row => !row.collapsed)) fail('row_height_limit', 'A grouped timeline needs space for a group header and at least one readable record row');
  const positions = [], rows = [];
  let offset = 0, current;
  // Insert presentation slots once, before pinning the layout; record IDs never repeat.
  for (let row = 0; row < layout.totalRows; row++) {
    const group = groups.get(row);
    if (group) {
      if (!group.collapsed && offset % capacity === capacity - 1) offset++;
      current = group;
      rows.push({ ...group, row: offset, continuation: false });
    } else if (current && offset % capacity === 0) {
      rows.push({ ...current, row: offset++, continuation: true });
    }
    positions[row] = offset++;
  }
  for (const item of layout.items) item.row = positions[item.row];
  for (const enclosure of layout.enclosures ?? []) {
    enclosure.startRow = positions[enclosure.startRow];
    enclosure.endRow = positions[enclosure.endRow - 1] + 1;
  }
  return { ...layout, ...counts, rows, totalRows: offset };
}
