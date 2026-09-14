import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { createQueryData } from '../../client/src/data/query-core.js';
import { overlaps } from '../../client/src/timeline/layout.js';
import { toIso } from '../../client/src/timeline/time-scale.js';

test('1,000 seeded cached overview counts match the half-open overlap oracle for all record kinds', () => {
  let seed = 70211;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const origin = Date.parse('2031-01-01T00:00:00.000Z');
  for (let trial = 0; trial < 1000; trial++) {
    const width = 16 + Math.floor(random() * 1000), from = origin + trial * 2000, to = from + width;
    const records = Array.from({ length: 8 }, (_, index) => {
      const start = from + Math.floor((random() * 1.5 - 0.25) * width);
      const kind = index % 4 === 0 ? 'event' : 'session';
      const end = kind === 'event' || index % 4 === 1 ? null : index % 4 === 2 ? start : start + Math.floor(random() * width);
      return { ...initial.records[0], id: `oracle-${index}`, kind, title: index % 2 ? 'Needle' : 'Other', start: toIso(start), end: end === null ? null : toIso(end), deletedAt: null };
    });
    const query = createQueryData({ records }, { domain: { from: toIso(from), to: toIso(to) }, bins: 16, search: 'Needle', scaleMode: trial % 2 ? 'adaptive' : 'uniform' });
    for (const cell of query.overviewBins) {
      const admitted = records.filter(record => overlaps(record, cell.from, cell.to));
      assert.equal(cell.total, admitted.length, `trial ${trial}`);
      assert.equal(cell.matched, admitted.filter(record => record.title === 'Needle').length, `matched trial ${trial}`);
    }
    const clear = createQueryData({ records }, { domain: query.map.domain, bins: 16 });
    assert.deepEqual(query.density, clear.density);
  }
});
