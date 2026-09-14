export function packFootprints(items, clearance = 4, maxIndexBytes = 128 * 1024 * 1024) {
  if (!Number.isFinite(clearance) || clearance < 0 || items.some(item => !Number.isFinite(item.footprintStart) || !Number.isFinite(item.footprintEnd) || item.footprintEnd + clearance <= item.footprintStart)) throw new RangeError('Invalid packing footprint');
  if (items.length < 128) {
    const tracks = [], rows = [];
    for (const item of items) {
      let row = tracks.findIndex(intervals => intervals.every(([a, b]) => item.footprintEnd + clearance <= a || item.footprintStart >= b + clearance));
      if (row < 0) { row = tracks.length; tracks.push([]); }
      tracks[row].push([item.footprintStart, item.footprintEnd]); rows.push(row);
    }
    return { rows, count: tracks.length };
  }
  // Expanded half-open intervals exactly encode the existing clearance rule.
  // Range bitsets find the first available row without reordering any records.
  const points = [...new Set(items.flatMap(item => [item.footprintStart, item.footprintEnd + clearance]))].sort((a, b) => a - b);
  const coordinates = new Map(points.map((value, index) => [value, index])), size = points.length - 1;
  const capacity = size * 4 + 4;
  let accountedBytes = capacity * 24;
  const capacityError = () => Object.assign(new Error('Packing index capacity exceeded; narrow the time range or filters'), { code: 'layout_capacity', status: 413 });
  if (accountedBytes > maxIndexBytes) throw capacityError();
  const aggregate = new Array(capacity).fill(0n), own = new Array(capacity).fill(0n);
  const aggregateBits = new Uint32Array(capacity), ownBits = new Uint32Array(capacity);
  function mark(values, widths, node, bit, row) {
    const previous = widths[node], next = row + 1;
    if (next > previous) {
      accountedBytes += (previous === 0 ? 32 : 0) + 8 * (Math.ceil(next / 64) - Math.ceil(previous / 64));
      if (accountedBytes > maxIndexBytes) throw capacityError();
      widths[node] = next;
    }
    values[node] |= bit;
  }
  function occupied(node, left, right, start, end) {
    if (start <= left && right <= end) return aggregate[node];
    const middle = Math.floor((left + right) / 2);
    let result = own[node];
    if (start < middle) result |= occupied(node * 2, left, middle, start, end);
    if (end > middle) result |= occupied(node * 2 + 1, middle, right, start, end);
    return result;
  }
  function insert(node, left, right, start, end, bit, row) {
    mark(aggregate, aggregateBits, node, bit, row);
    if (start <= left && right <= end) { mark(own, ownBits, node, bit, row); return; }
    const middle = Math.floor((left + right) / 2);
    if (start < middle) insert(node * 2, left, middle, start, end, bit, row);
    if (end > middle) insert(node * 2 + 1, middle, right, start, end, bit, row);
  }
  const rows = []; let count = 0, allRows = 0n;
  for (const item of items) {
    const start = coordinates.get(item.footprintStart), end = coordinates.get(item.footprintEnd + clearance);
    const blocked = occupied(1, 0, size, start, end);
    let row, bit;
    if (blocked === allRows) { row = count++; bit = 1n << BigInt(row); allRows |= bit; }
    else { bit = (blocked + 1n) & ~blocked; const hex = bit.toString(16); row = (hex.length - 1) * 4 + Math.log2(Number.parseInt(hex[0], 16)); }
    rows.push(row); insert(1, 0, size, start, end, bit, row);
  }
  return { rows, count };
}
