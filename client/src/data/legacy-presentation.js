import { ProviderError, clone, inspectJson } from './data-provider.js';
import { DEFAULT_DEFINITION, validateDefinition } from './model-catalog.js';
import { Temporal } from '@js-temporal/polyfill';
import { toMs, toIso } from '../timeline/time-scale.js';

const BAND_FIELDS = { color: 'backgroundColor', textColor: 'textColor', dateColor: 'dateColor', SessionColor: 'sessionColor', eventColor: 'eventColor', sessionHeight: 'barHeight', defaultEventSize: 'pointRadius', intervalUnit: 'intervalUnit', dateFormat: 'dateFormat' };
const PARAM_FIELDS = new Set(['name', 'title', 'date', 'timeZone', 'top', 'left', 'height', 'width', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'camera', 'data', 'data_default_port', 'data_sse_port']);
const OTHER_BAND_FIELDS = new Set(['name', 'height', 'intervalPixels', 'subIntervalPixels', 'intervalUnitPos', 'fontSize', 'fontWeight', 'fontStyle', 'fontFamily', 'textBackgroundColor', 'model']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const problem = message => new ProviderError('invalid_legacy_presentation', message, 422);
const number = (value, label) => {
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw problem(`${label} must be a positive decimal number`);
  return value;
};

export function legacyModelFocus(value) {
  if (value === undefined || value === 'current_time') return { mode: 'current', timestamp: null };
  try { return { mode: 'fixed', timestamp: toIso(toMs(value)) }; } catch { /* Only the explicit UTC legacy spelling is accepted below. */ }
  const match = typeof value === 'string' && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) UTC$/.exec(value);
  if (!match) throw problem('Model reference date requires offset ISO or an explicit legacy UTC date');
  const timestamp = `${match[4]}-${String(MONTHS.indexOf(match[2]) + 1).padStart(2, '0')}-${match[3].padStart(2, '0')}T${match[5]}:${match[6]}:${match[7]}.000Z`;
  try {
    const ms = toMs(timestamp);
    if (DAYS[Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO('UTC').dayOfWeek - 1] !== match[1]) throw new Error('weekday');
    return { mode: 'fixed', timestamp };
  } catch { throw problem('Model reference date is invalid or its weekday does not match'); }
}

/** Adapts data only. It never executes legacy code, activates connectors or writes a source. */
export function adaptLegacyPresentation(model, { sourceBindings = [], namespaceGrouping, sortBy, focus } = {}) {
  inspectJson(model);
  inspectJson(sourceBindings);
  if (!model || !Array.isArray(model.params) || model.params.length !== 1 || !model.params[0] || Array.isArray(model.params[0]) || typeof model.params[0] !== 'object' || !Array.isArray(model.bands) || model.bands.length !== 2 || !model.bands.every(band => band && typeof band === 'object' && !Array.isArray(band)) || /overview/i.test(model.bands[0].name || '') || !/overview/i.test(model.bands[1].name || '')) throw problem('Compatibility profile requires one primary band and one named overview band');
  if (!Array.isArray(sourceBindings) || sourceBindings.length > 100) throw problem('At most 100 explicit source bindings are supported');
  if (namespaceGrouping !== undefined && typeof namespaceGrouping !== 'boolean') throw problem('namespaceGrouping must be boolean');
  const params = model.params[0], definition = clone(DEFAULT_DEFINITION), diagnostics = [];
  const notice = (path, code, message) => diagnostics.push({ path, code, severity: 'notice', message });
  const unsupported = path => diagnostics.push({ path, code: 'unsupported_legacy_presentation', severity: 'warning', message: 'This authored property is preserved in source provenance but is not rendered or executed.' });
  if (params.camera !== undefined && params.camera !== 'Orthographic') throw problem('Perspective models require a separate explicit compatibility implementation');
  const name = params.title ?? 'Legacy timeline';
  if (typeof name !== 'string' || !name.trim() || [...name].length > 100) throw problem('Model title must contain 1-100 characters');
  definition.fontSize = params.fontSize === undefined ? 12 : number(params.fontSize, 'fontSize');
  definition.rowHeight = Math.max(32, definition.fontSize + 19);
  definition.timeZone = params.timeZone ?? 'UTC';
  const presentation = { version: 1, bands: {}, labels: { fields: ['/title'] }, nesting: { enabled: true } };
  const viewHints = { version: 1, focus: legacyModelFocus(focus ?? params.date), bands: {} };
  const authoredHeights = [];
  for (let index = 0; index < 2; index++) {
    const band = model.bands[index], role = index ? 'overview' : 'primary', target = {};
    for (const [legacy, field] of Object.entries(BAND_FIELDS)) if (band[legacy] !== undefined) target[field] = clone(band[legacy]);
    target.barHeight ??= index ? 4 : 10;
    target.pointRadius ??= index ? 2 : 5;
    target.axisPosition = band.intervalUnitPos === undefined || band.intervalUnitPos === 'BOTTOM' ? 'bottom' : band.intervalUnitPos === 'TOP' ? 'top' : null;
    if (target.axisPosition === null) throw problem('Unknown legacy axis position');
    target.intervalUnit ??= index ? 'DAY' : 'HOUR';
    presentation.bands[role] = target;
    if (!index) {
      definition.displayUnit = target.intervalUnit;
      for (const field of ['fontSize', 'fontWeight', 'fontStyle']) if (band[field] !== undefined || params[field] !== undefined) {
        let value = band[field] ?? params[field];
        if (field === 'fontSize') value = number(value, field);
        if (field === 'fontWeight' && typeof value === 'string') value = ({ normal: 400, bold: 700 })[value.toLowerCase()] ?? value;
        presentation.labels[field] = value;
      }
      if (band.textBackgroundColor !== undefined) presentation.labels.backgroundColor = band.textBackgroundColor === false ? null : band.textBackgroundColor;
    }
    const height = typeof band.height === 'string' && /^(?:[1-9]\d?|100)%$/.test(band.height) ? Number(band.height.slice(0, -1)) : null;
    if (height === null) throw problem('Legacy band heights must be explicit percentages');
    authoredHeights.push(height);
    viewHints.bands[role] = { heightFraction: height / 100, intervalPixels: number(band.intervalPixels, 'intervalPixels'), intervalUnit: target.intervalUnit };
    if (band.subIntervalPixels !== undefined && band.subIntervalPixels !== 'NONE') {
      if (band.intervalUnit === 'HOUR' && viewHints.bands[role].intervalPixels >= 60) target.minorDivisions = 4;
      else unsupported(`/bands/${index}/subIntervalPixels`);
    }
    if (band.dateFormat !== undefined) notice(`/bands/${index}/dateFormat`, 'calendar_format_correction', 'Calendar months and 24-hour time are formatted correctly; legacy formatter defects are not reproduced.');
    for (const key of Object.keys(band)) if (!(key in BAND_FIELDS) && !OTHER_BAND_FIELDS.has(key)) unsupported(`/bands/${index}/${key}`);
    if (band.model !== undefined) {
      if (!Array.isArray(band.model) || band.model.length !== 1 || !band.model[0] || typeof band.model[0] !== 'object' || Array.isArray(band.model[0])) throw problem('Only one sort model per band is supported');
      for (const key of Object.keys(band.model[0])) if (key !== 'sortBy') {
        if (key === 'alternateColor') notice(`/bands/${index}/model/0/${key}`, 'inactive_legacy_property', 'No legacy consumer of model.alternateColor was found; this value is not applied as a lane palette.');
        else unsupported(`/bands/${index}/model/0/${key}`);
      }
    }
  }
  if (authoredHeights[0] + authoredHeights[1] !== 100) throw problem('Primary and overview percentages must total 100');
  const grouping = namespaceGrouping === true ? 'namespace' : namespaceGrouping === false ? 'NONE' : sortBy ?? model.bands[0].model?.[0]?.sortBy ?? 'NONE';
  if (grouping !== 'NONE') {
    if (typeof grouping !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,7}$/.test(grouping)) throw problem('Legacy grouping must be a safe data-property chain');
    presentation.grouping = { field: `/data/${grouping.split('.').join('/')}`, direction: 'asc' };
  }
  presentation.sourceStyles = sourceBindings.flatMap((binding, index) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw problem('Invalid source binding');
    if (binding.enabled === false) return [];
    if (binding.render !== undefined && (!binding.render || typeof binding.render !== 'object' || Array.isArray(binding.render))) throw problem('Source render must be an object');
    const style = { sourceId: binding.sourceId };
    if (binding.namespace !== undefined) style.namespace = binding.namespace;
    for (const [field, target] of Object.entries({ color: 'backgroundColor', textColor: 'textColor', dateColor: 'dateColor' })) if (binding.render?.[field] !== undefined) style[target] = binding.render[field];
    for (const field of Object.keys(binding.render ?? {})) if (!['color', 'textColor', 'dateColor'].includes(field)) {
      if (field === 'alternateColor') notice(`/sourceBindings/${index}/render/${field}`, 'inactive_legacy_property', 'Legacy namespace lanes use source.color without alternating this color.');
      else unsupported(`/sourceBindings/${index}/render/${field}`);
    }
    return [style];
  });
  definition.presentation = presentation;
  const validation = validateDefinition(definition);
  if (!validation.valid) throw new ProviderError('invalid_legacy_presentation', 'Legacy model contains unsupported presentation values', 422, { errors: validation.errors });
  for (const key of Object.keys(model)) if (!['params', 'bands'].includes(key)) unsupported(`/${key}`);
  for (const key of Object.keys(params)) if (!PARAM_FIELDS.has(key)) unsupported(`/params/0/${key}`);
  for (const key of ['data', 'data_default_port', 'data_sse_port']) if (params[key] !== undefined) notice(`/params/0/${key}`, 'connector_not_activated', 'Legacy data paths and ports are not executed; only explicitly configured read-only sources are used.');
  notice('/params/0/fontFamily', 'measured_font_substitution', 'Embedded measured Noto Sans replaces the legacy browser font; exact historical glyph geometry is not claimed.');
  notice('/params/0/width', 'responsive_geometry', 'Authored band proportions and scale are retained; fixed page placement is replaced by responsive viewport dimensions.');
  return { name, definition, viewHints, diagnostics };
}

export function legacyViewport(viewHints, width, now = Date.now(), timeZone = 'UTC') {
  if (!(Number.isFinite(width) && width >= 64 && width <= 8192)) throw problem('Viewport width must be between 64 and 8192 CSS pixels');
  const center = viewHints.focus.mode === 'fixed' ? toMs(viewHints.focus.timestamp) : toMs(now);
  const durations = { MILLISECOND: 1, SECOND: 1000, MINUTE: 60000, HOUR: 3600000, DAY: 86400000, WEEK: 604800000 };
  const period = band => {
    const unit = band.intervalUnit;
    let milliseconds = durations[unit];
    if (milliseconds === undefined) {
      const focus = Temporal.Instant.fromEpochMilliseconds(center).toZonedDateTimeISO(timeZone);
      const count = { YEAR: 1, DECADE: 10, CENTURY: 100, MILLENNIUM: 1000 }[unit];
      if (unit !== 'MONTH' && !count) throw problem('Unknown calendar unit');
      milliseconds = focus.add(unit === 'MONTH' ? { months: 1 } : { years: count }).epochMilliseconds - center;
    }
    const span = Math.max(2, milliseconds * width / number(band.intervalPixels, 'intervalPixels'));
    return { from: toIso(Math.max(-377705116800000, Math.floor(center - span / 2))), to: toIso(Math.min(253402300799999, Math.ceil(center + span / 2))) };
  };
  return { primary: period(viewHints.bands.primary), overview: period(viewHints.bands.overview), center: toIso(center) };
}
