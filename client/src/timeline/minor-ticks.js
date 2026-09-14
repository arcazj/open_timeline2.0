import { generateTicks } from './time-scale.js';

export function minorTicks({ from, to, unit, divisions, project, timeZone = 'UTC', minPixels = 8 }) {
  if (!divisions || divisions === 1) return [];
  if (!Number.isInteger(divisions) || divisions < 1 || divisions > 12) throw new RangeError('Invalid minor divisions');
  // Only fixed-duration units are subdivided; calendar boundaries are never approximated.
  const duration = { MILLISECOND: 1, SECOND: 1000, MINUTE: 60000, HOUR: 3600000 }[unit];
  if (!duration) return [];
  const first = Math.max(-377705116800000, Number(from) - duration);
  const majors = generateTicks(first, to, unit, { maxTicks: 600, timeZone });
  const result = [];
  for (const major of majors) for (let index = 1; index < divisions; index++) {
    const timeMs = major.timeMs + duration * index / divisions;
    if (timeMs < Number(from) || timeMs >= Number(to)) continue;
    const previous = timeMs - duration / divisions, next = timeMs + duration / divisions;
    if (Math.min(Math.abs(project(timeMs) - project(previous)), Math.abs(project(next) - project(timeMs))) < minPixels) continue;
    result.push({ timeMs, label: '', minor: true });
  }
  return result;
}
