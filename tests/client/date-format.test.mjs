import test from 'node:test';
import assert from 'node:assert/strict';
import { DATE_FORMATS, formatBandDate } from '../../client/src/timeline/date-format.js';

test('all 35 legacy format spellings have exact corrected literal outputs', () => {
  const expected = [
    '09/12/2026/17:04', '09/12/2026-17:04', '09-12-2026 17:04', '12/09/2026/17:04',
    '12/09/2026-17:04', '12/09/2026 17:04', '09/12/17:04', '09/12-17:04', '09/12',
    'Sep 12', 'Sep/12', '12 17:04', '12/17:04', '12-17:04', 'Sat 12 17:04',
    'Sat 12/17:04', 'Sat 12-17:04', 'Sep/12/17:04', 'Sep/12-17:04', '12/09/17:04',
    '12/09-17:04', 'Sep', '09', '2026 09', '2026/09', '2026-09', '2026 Sep 12',
    '2026/Sep/12', '2026-Sep-12', '2026 Sep', '2026/Sep', '2026-Sep', '2026',
    'Sat, 12 Sep 2026 17:04:56 GMT', '2026-09-12T17:04:56.789Z',
  ];
  assert.equal(DATE_FORMATS.length, 36);
  DATE_FORMATS.filter(format => format !== 'DEFAULT').forEach((format, index) => assert.equal(formatBandDate('2026-09-12T17:04:56.789Z', format), expected[index], format));
  assert.equal(formatBandDate('unused', 'DEFAULT', 'UTC', '1 ms'), '1 ms');
});

test('IANA rollover, leap days, DST and year padding use calendar values', () => {
  assert.equal(formatBandDate('2026-01-01T01:05:00.000Z', 'MM/dd/yyyy/hh:mm', 'America/New_York'), '12/31/2025/20:05');
  assert.equal(formatBandDate('2024-02-29T00:03:00.000Z', 'yyyy-MM'), '2024-02');
  assert.equal(formatBandDate('2026-03-08T06:59:00.000Z', 'dd hh:mm', 'America/New_York'), '08 01:59');
  assert.equal(formatBandDate('2026-03-08T07:00:00.000Z', 'dd hh:mm', 'America/New_York'), '08 03:00');
  assert.equal(formatBandDate('0001-01-02T03:04:00.000Z', 'MM/dd/yyyy/hh:mm'), '01/02/0001/03:04');
  assert.equal(formatBandDate('9999-12-31T23:59:59.999Z', 'yyyy-MM'), '9999-12');
  assert.equal(formatBandDate('0.999', 'ISO'), '1970-01-01T00:00:00.000Z');
});

test('format IDs are a closed data allowlist, not executable patterns', () => {
  for (const value of ['yyyy MM dd', '<script>', 'constructor', 'HH:mm', 'yyyy;alert(1)']) assert.throws(() => formatBandDate('2026-01-01T00:00:00.000Z', value), /Unsupported date format/);
  assert.throws(() => formatBandDate('not-a-date', 'yyyy'));
  assert.throws(() => formatBandDate('2026-01-01T00:00:00.000Z', 'yyyy', 'Not/AZone'));
});
