import test from 'node:test';
import assert from 'node:assert/strict';
import { packFootprints } from '../../client/src/timeline/row-packer.js';

function reference(items, clearance = 4) {
  const tracks = [], rows = [];
  for (const item of items) {
    let row = tracks.findIndex(track => track.every(([a, b]) => item.footprintEnd + clearance <= a || item.footprintStart >= b + clearance));
    if (row < 0) { row = tracks.length; tracks.push([]); }
    tracks[row].push([item.footprintStart, item.footprintEnd]); rows.push(row);
  }
  return { rows, count: tracks.length };
}
test('range-indexed packing exactly matches first-compatible rows for 1000 arbitrary-order cases', () => {
  let seed = 39134839;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
  for (let run = 0; run < 1000; run++) {
    const items = Array.from({ length: 128 + Math.floor(random() * 150) }, () => { const start = Math.floor(random() * 1000) / 3; return { footprintStart: start, footprintEnd: start + random() * 100 + 0.01 }; });
    assert.deepEqual(packFootprints(items), reference(items));
  }
});
test('packing honors exact clearance, duplicate endpoints and arbitrarily simultaneous records', () => {
  const touching = Array.from({ length: 400 }, (_, index) => ({ footprintStart: index % 2 ? 14 : 0, footprintEnd: index % 2 ? 24 : 10 }));
  assert.deepEqual(packFootprints(touching), reference(touching));
  const simultaneous = Array.from({ length: 25000 }, () => ({ footprintStart: 0, footprintEnd: 100 }));
  const packed = packFootprints(simultaneous);
  assert.equal(packed.count, 25000); assert.equal(packed.rows[24999], 24999);
  assert.deepEqual(packFootprints([]), { rows: [], count: 0 });
});
test('packing index rejects its resource budget without changing input footprints', () => {
  const items = Array.from({ length: 128 }, (_, index) => ({ footprintStart: index, footprintEnd: index + 500 })), original = structuredClone(items);
  assert.throws(() => packFootprints(items, 4, 1000), error => error.code === 'layout_capacity' && error.status === 413);
  assert.deepEqual(items, original);
});
