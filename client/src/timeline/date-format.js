import { Temporal } from '@js-temporal/polyfill';
import { toIso, eraYear } from './time-scale.js';
import presentationSchema from '../../../shared/schemas/presentation.schema.json' with { type: 'json' };

export const DATE_FORMATS = Object.freeze([...presentationSchema.definitions.band.properties.dateFormat.enum]);
const allowed = new Set(DATE_FORMATS);
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = number => String(number).padStart(2, '0');

export function formatBandDate(value, formatId = 'DEFAULT', timeZone = 'UTC', fallback = '') {
  if (!allowed.has(formatId)) throw new RangeError('Unsupported date format identifier');
  if (formatId === 'DEFAULT') return fallback;
  const iso = toIso(value);
  if (formatId === 'ISO') return iso;
  if (formatId === 'UTC') return new Date(iso).toUTCString();
  const date = Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone);
  const parts = { yyyy: date.year <= 0 ? eraYear(date.year) : String(date.year).padStart(4, '0'), mmm: months[date.month - 1], ddd: weekdays[date.dayOfWeek - 1], MM: pad(date.month), dd: pad(date.day), hh: pad(date.hour), mm: pad(date.minute) };
  return formatId.replace(/yyyy|mmm|ddd|MM|dd|hh|mm/g, token => parts[token]);
}
