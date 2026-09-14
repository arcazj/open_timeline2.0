import { generateTicks, timeDecimal } from './time-scale.js';

// Durations select a calendar interval; Temporal still places every actual tick.
const intervals = [
  ...[1, 2, 5, 10, 20, 50, 100, 200, 500].map(multiple => ['MILLISECOND', multiple, multiple]),
  ...[1, 2, 5, 10, 15, 30].map(multiple => ['SECOND', multiple, multiple * 1000]),
  ...[1, 2, 5, 10, 15, 30].map(multiple => ['MINUTE', multiple, multiple * 60000]),
  ...[1, 2, 3, 6, 12].map(multiple => ['HOUR', multiple, multiple * 3600000]),
  ['DAY', 1, 86400000], ['WEEK', 1, 604800000], ['MONTH', 1, 2629800000], ['MONTH', 3, 7889400000], ['MONTH', 6, 15778800000],
  ['YEAR', 1, 31557600000], ['YEAR', 2, 63115200000], ['YEAR', 5, 157788000000], ['DECADE', 1, 315576000000],
  ['DECADE', 2, 631152000000], ['DECADE', 5, 1577880000000], ['CENTURY', 1, 3155760000000], ['CENTURY', 2, 6311520000000], ['CENTURY', 5, 15778800000000], ['MILLENNIUM', 1, 31557600000000],
];

export function adaptiveTicks({ map, from, to, width, project, timeZone = 'UTC', minimumSpacing = 72 }) {
  if (!map?.knots?.length || !(width > 0) || !(minimumSpacing >= 1)) throw new RangeError('A map, positive width and tick spacing are required');
  const start = timeDecimal(from), end = timeDecimal(to), segments = [];
  for (let index = 1; index < map.knots.length; index++) {
    const left = timeDecimal(map.knots[index - 1].timeMs), right = timeDecimal(map.knots[index].timeMs);
    const a = left.gt(start) ? left : start, b = right.lt(end) ? right : end;
    if (b.lte(a)) continue;
    const pixels = project(b.toString()) - project(a.toString());
    if (!(pixels > 0)) continue;
    const target = b.minus(a).div(pixels).times(minimumSpacing).toNumber();
    const interval = intervals.find(entry => entry[2] >= target) || intervals.at(-1);
    const previous = segments.at(-1);
    if (previous?.interval === interval && previous.to.eq(a)) previous.to = b;
    else segments.push({ from: a, to: b, interval });
  }
  const ticks = new Map();
  for (const segment of segments) {
    const [unit, multiple] = segment.interval;
    const pixels = project(segment.to.toString()) - project(segment.from.toString());
    const limit = Math.min(512, Math.ceil(pixels / minimumSpacing) * 4 + 8);
    for (const tick of generateTicks(segment.from, segment.to, unit, { multiple, timeZone, maxTicks: limit })) ticks.set(tick.timeMs, { ...tick, unit, multiple });
  }
  return [...ticks.values()].sort((a, b) => a.timeMs - b.timeMs);
}
