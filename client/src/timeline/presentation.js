import Ajv from 'ajv/dist/2020.js';
import { instantFormat, toMs } from './time-scale.js';
import presentationSchema from '../../../shared/schemas/presentation.schema.json' with { type: 'json' };
import renderSchema from '../../../shared/schemas/record-render.schema.json' with { type: 'json' };
import hazardIcons from '../../../shared/legacy-hazard-icons.json' with { type: 'json' };
import { compareOrderedText } from '../data/string-order.js';

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
ajv.addFormat('timeline-instant', instantFormat);
const check = ajv.compile(presentationSchema);
const checkRender = ajv.compile(renderSchema);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const FIELDS = new Set(['/id', '/title', '/kind', '/sourceId', '/start', '/end', '/originalStart', '/originalEnd', '/order']);
const failure = (code, message) => Object.assign(new Error(message), { code, status: 422 });

export const DATE_FORMATS = Object.freeze([...presentationSchema.definitions.band.properties.dateFormat.enum]);
export const APPROVED_ICONS = Object.freeze([...renderSchema.properties.icon.enum]);
export const isHazardIcon = icon => Object.values(hazardIcons).includes(icon);

export function fieldSegments(field, grouping = false) {
  if (typeof field !== 'string' || Array.from(field).length > 256) throw failure('invalid_field_pointer', 'Field must be a bounded JSON pointer');
  if ((grouping ? ['/sourceId', '/kind'] : [...FIELDS]).includes(field)) return [field.slice(1)];
  if (!field.startsWith('/data/')) throw failure('invalid_field_pointer', 'Use a supported record field or /data/... pointer');
  const segments = field.slice(1).split('/');
  if (segments.length < 2 || segments.length > 9 || segments.some(segment => !segment || /~(?![01])/u.test(segment))) throw failure('invalid_field_pointer', 'Invalid JSON pointer depth, empty segment or escape');
  const decoded = segments.map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (decoded.some(segment => FORBIDDEN.has(segment))) throw failure('invalid_field_pointer', 'Prototype-related fields are not allowed');
  return decoded;
}

export function readField(record, field, grouping = false) {
  let value = record;
  for (const segment of fieldSegments(field, grouping)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !own(value, segment)) return { missing: true, value: undefined };
    value = value[segment];
  }
  return { missing: false, value };
}

export function validatePresentation(presentation) {
  const errors = check(presentation) ? [] : (check.errors ?? []).map(error => ({ path: `${error.instancePath}/${error.params?.additionalProperty ?? error.params?.missingProperty ?? ''}`.replace(/\/$/u, '') || '/', code: error.keyword, message: error.message }));
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) return { valid: false, errors };
  if (Array.isArray(presentation.bandLayout) && errors.length === 0) {
    const bands = presentation.bandLayout;
    if (bands.filter(b => b.role === 'detail').length > 1) errors.push({ path: '/bandLayout', code: 'band_capacity', message: 'One additional detail band is supported alongside context bands' });
    if (bands.filter(b => b.role === 'primary').length !== 1 || bands.filter(b => b.role === 'overview').length > 1 || new Set(bands.map(b => b.id)).size !== bands.length) errors.push({ path: '/bandLayout', code: 'band_roles', message: 'Bands require unique IDs, one primary and at most one overview' });
    bands.forEach((band, i) => {
      if (band.role === 'context' && !band.range) errors.push({ path: `/bandLayout/${i}`, code: 'band_range', message: 'Context bands require an initial range' });
      if (band.role === 'detail' && (band.range || band.fixedScale)) errors.push({ path: `/bandLayout/${i}`, code: 'band_range', message: 'Detail bands inherit the primary range and scale' });
      for (const range of [band.range, ...(band.fixedScale || [])].filter(Boolean)) if (toMs(range.from) >= toMs(range.to)) errors.push({ path: `/bandLayout/${i}`, code: 'band_range', message: 'Band intervals must be positive' });
    });
  }
  const pointers = [];
  if (typeof presentation.grouping?.field === 'string') pointers.push(['/grouping/field', presentation.grouping.field, true]);
  if (Array.isArray(presentation.labels?.fields)) presentation.labels.fields.forEach((field, i) => pointers.push([`/labels/fields/${i}`, field, false]));
  if (Array.isArray(presentation.inspector?.fields)) presentation.inspector.fields.forEach((entry, i) => {
    pointers.push([`/inspector/fields/${i}/field`, entry?.field, false]);
    if (typeof entry?.label === 'string' && !entry.label.trim()) errors.push({ path: `/inspector/fields/${i}/label`, code: 'blank_label', message: 'Field label must not be blank' });
  });
  for (const [path, field, grouping] of pointers) {
    try { fieldSegments(field, grouping); } catch (error) { errors.push({ path, code: error.code, message: error.message }); }
  }
  const seen = new Set(), namespaces = new Set();
  if (Array.isArray(presentation.sourceStyles)) presentation.sourceStyles.forEach((style, i) => {
    if (typeof style?.sourceId !== 'string') return;
    if (!style.sourceId.trim() || seen.has(style.sourceId)) errors.push({ path: `/sourceStyles/${i}/sourceId`, code: 'source_style_id', message: 'Source style identities must be nonblank and unique' });
    seen.add(style.sourceId);
    if (typeof style.namespace === 'string') {
      const namespace = style.namespace.normalize('NFC');
      if (!namespace.trim() || namespaces.has(namespace)) errors.push({ path: `/sourceStyles/${i}/namespace`, code: 'namespace_style_id', message: 'Namespace style selectors must be nonblank and unique after Unicode normalization' });
      namespaces.add(namespace);
    }
  });
  return { valid: errors.length === 0, errors };
}

export function groupStyle(group, presentation) {
  const field = presentation.grouping.field;
  const source = field === '/sourceId' ? presentation.sourceStyles.find(style => style.sourceId === group.value)
    : field === '/data/namespace' && typeof group.value === 'string' ? presentation.sourceStyles.find(style => style.namespace?.normalize('NFC') === group.value) : null;
  return { backgroundColor: source?.backgroundColor ?? null, textColor: source?.textColor ?? presentation.bands.primary.textColor, dateColor: source?.dateColor ?? presentation.bands.primary.dateColor };
}

export function resolvePresentation(input = {}) {
  const raw = input.presentation;
  if (raw !== undefined) {
    const validation = validatePresentation(raw);
    if (!validation.valid) throw Object.assign(failure('invalid_presentation', 'Presentation definition is invalid'), { errors: validation.errors });
  }
  if (input.theme !== undefined && !['light', 'classic', 'dark'].includes(input.theme)) throw failure('invalid_presentation', 'Unknown theme');
  if (input.displayUnit !== undefined && !presentationSchema.definitions.band.properties.intervalUnit.enum.includes(input.displayUnit)) throw failure('invalid_presentation', 'Unknown display unit');
  const dark = input.theme === 'dark';
  const color = { textColor: dark ? '#e4edf0' : '#27343a', dateColor: dark ? '#a1b3bc' : '#667981', sessionColor: '#39788a', eventColor: '#39788a' };
  const common = { ...color, axisPosition: 'bottom', dateFormat: 'DEFAULT' };
  return {
    version: 1,
    ...(raw?.compact !== undefined ? { compact: raw.compact } : {}),
    ...(raw?.durationLabels ? { durationLabels: raw.durationLabels } : {}),
    ...(raw?.bandLayout ? { bandLayout: structuredClone(raw.bandLayout) } : {}),
    bands: {
      primary: { ...common, backgroundColor: dark ? '#171c21' : input.theme === 'classic' ? '#a9d7ef' : '#eef0f0', barHeight: 8, pointRadius: 4.5, intervalUnit: input.displayUnit ?? 'HOUR', ...raw?.bands?.primary },
      overview: { ...common, backgroundColor: dark ? '#283841' : '#f0f2f4', barHeight: 4, pointRadius: 2, intervalUnit: 'DAY', ...raw?.bands?.overview },
    },
    grouping: raw?.grouping ? { direction: 'asc', ...raw.grouping } : { field: input.groupBy && input.groupBy !== 'none' ? `/${input.groupBy}` : null, direction: 'asc' },
    sourceStyles: (raw?.sourceStyles ?? []).map(style => ({ ...style })),
    labels: { fontSize: input.fontSize ?? 13, fontWeight: 400, fontStyle: 'normal', maxLines: 1, backgroundColor: null, ...raw?.labels, fields: [...(raw?.labels?.fields ?? ['/title'])] },
    inspector: raw?.inspector ? { fields: raw.inspector.fields.map(field => ({ ...field })) } : null,
    nesting: { enabled: false, color: '#75909e', opacity: 0.15, ...raw?.nesting },
    baseline: { enabled: false, color: '#78848d', ...raw?.baseline },
  };
}

export function resolveRecordStyle(record, presentation, band = 'primary') {
  const render = record.render ?? {};
  if (!checkRender(render)) throw failure('invalid_render', 'Unsupported record render definition');
  const base = presentation.bands[band];
  if (!base) throw failure('invalid_presentation', 'Unknown band role');
  const source = presentation.sourceStyles.find(style => style.sourceId === record.sourceId) ?? {};
  return {
    color: render.color ?? source[record.kind === 'event' ? 'eventColor' : 'sessionColor'] ?? base[record.kind === 'event' ? 'eventColor' : 'sessionColor'],
    textColor: render.textColor ?? source.textColor ?? base.textColor,
    backgroundColor: own(render, 'backgroundColor') ? render.backgroundColor : presentation.labels.backgroundColor,
    fontSize: render.fontSize ?? presentation.labels.fontSize,
    fontWeight: render.fontWeight ?? presentation.labels.fontWeight,
    fontStyle: render.fontStyle ?? presentation.labels.fontStyle,
    barHeight: render.barHeight ?? base.barHeight,
    pointRadius: render.pointRadius ?? base.pointRadius,
    icon: render.icon ?? null,
    sourceBackground: source.backgroundColor ?? null,
  };
}

export function recordLabel(record, presentation) {
  const parts = presentation.labels.fields.map(field => {
    const { missing, value } = readField(record, field);
    if (missing || value === null) return '';
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw failure('invalid_label_value', `Field ${field} is not a primitive label value`);
    return String(value);
  }).filter(value => value.length);
  return (parts.join(' | ') || record.title).replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
}

export function groupValue(record, presentation) {
  if (!presentation.grouping.field) return { key: '', name: '', rank: -1, value: '' };
  const { missing, value } = readField(record, presentation.grouping.field, true);
  if (missing) return { key: 'missing:', name: '(missing)', rank: 4 };
  if (value === null) return { key: 'null:', name: '(null)', rank: 3 };
  if (typeof value === 'number' && Number.isFinite(value)) return { key: `number:${value}`, name: String(value), rank: 0, value };
  if (typeof value === 'string') { const normalized = value.normalize('NFC'); return { key: `string:${normalized}`, name: normalized, rank: 1, value: normalized }; }
  if (typeof value === 'boolean') return { key: `boolean:${value}`, name: String(value), rank: 2, value };
  throw failure('invalid_group_value', 'Grouping requires a primitive value, null or missing field');
}

export function compareGroups(a, b, direction = 'asc', ordering = {}) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank >= 3 || a.rank < 0) return 0;
  const order = a.rank === 1 ? compareOrderedText(a.value, b.value, ordering) : Number(a.value) - Number(b.value);
  return direction === 'desc' ? -order : order;
}
