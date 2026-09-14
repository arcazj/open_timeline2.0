import { ProviderError, clone, sha256 } from './data-provider.js';
import { parseStrictJson } from './snapshot.js';
import { DEFAULT_DEFINITION, validateDefinition } from './model-catalog.js';

const BYTE_LIMIT = 1024 * 1024;
const POINTER_LIMIT = 10000;
const escapePointer = key => key.replace(/~/g, '~0').replace(/\//g, '~1');
const mappings = new Map([
  ['/params/0/title', { target: '/name', field: 'name' }],
  ['/params/0/fontSize', { target: '/definition/fontSize', field: 'fontSize' }],
  ['/params/0/timeZone', { target: '/definition/timeZone', field: 'timeZone' }],
  ['/params/0/fontWeight', { target: '/definition/presentation/labels/fontWeight', field: 'fontWeight' }],
  ['/params/0/fontStyle', { target: '/definition/presentation/labels/fontStyle', field: 'fontStyle' }],
]);
const bandFields = { color: 'backgroundColor', textColor: 'textColor', dateColor: 'dateColor', SessionColor: 'sessionColor', eventColor: 'eventColor', sessionHeight: 'barHeight', defaultEventSize: 'pointRadius', intervalUnitPos: 'axisPosition', intervalUnit: 'intervalUnit', dateFormat: 'dateFormat' };
const labelFields = new Set(['fontSize', 'fontWeight', 'fontStyle']);

function bandRole(source, index) {
  const name = source.bands[index]?.name;
  if (index === 0 && (name === undefined || (typeof name === 'string' && !/overview/.test(name)))) return 'primary';
  if (index === 1 && typeof name === 'string' && /overview/.test(name)) return 'overview';
  return null;
}

function mappingFor(pointer, source) {
  if (mappings.has(pointer)) return mappings.get(pointer);
  const match = /^\/bands\/(\d+)\/([^/]+)$/.exec(pointer);
  if (match) {
    const role = bandRole(source, Number(match[1])), field = match[2];
    if (!role) return null;
    if (bandFields[field]) return { target: `/definition/presentation/bands/${role}/${bandFields[field]}`, field: bandFields[field], role };
    if (role === 'primary' && (labelFields.has(field) || field === 'textBackgroundColor')) return { target: `/definition/presentation/labels/${field === 'textBackgroundColor' ? 'backgroundColor' : field}`, field, role };
  }
  if (pointer === '/bands/0/model/0/sortBy' && bandRole(source, 0) === 'primary') return { target: '/definition/presentation/grouping', field: 'groupBy' };
  return null;
}

function assignTarget(candidate, target, value) {
  const parts = target.slice(1).split('/');
  let object = candidate;
  for (const part of parts.slice(0, -1)) object = object[part] ??= part === 'presentation' ? { version: 1 } : {};
  object[parts.at(-1)] = value;
}

function sourceLabel(path) {
  if (typeof path !== 'string' || !path || path.length > 512 || /[\x00-\x1f:]/.test(path) || /^[\\/]/.test(path) || path.replace(/\\/g, '/').split('/').includes('..')) throw new ProviderError('invalid_provenance', 'Use a relative source path without credentials or traversal');
  return path.replace(/\\/g, '/');
}

function sensitiveKey(key) {
  return /(?:password|passwd|secret|token|credential|authorization|api[_-]?key|cookie|descriptor|callback|script|handler|expression|function|code|html)/i.test(key) || /^(?:data(?:_|$)|url$|uri$|endpoint$|host$|port$|path$)/i.test(key);
}

function unsafeText(value) {
  return typeof value === 'string' && /(?:[a-z][a-z0-9+.-]*:\/\/|\/\/[^\s/]+@|(?:javascript|data):|\b(?:bearer|basic)\s+\S+|(?:token|secret|password|api[_-]?key)\s*[=:]|=>|<\/?[a-z!]|\b[a-z_$][\w.$]*\s*\(|\b(?:import|export|return|const|let|var)\s+)/i.test(value);
}

function publicStringPointer(pointer) {
  return mappings.has(pointer) || /^\/params\/0\/(?:name|date|camera|fontFamily)$/.test(pointer) || /^\/bands\/\d+\/(?:name|height|color|intervalPixels|subIntervalPixels|intervalUnitPos|intervalUnit|dateFormat|dateColor|textColor|SessionColor|eventColor|fontSize|fontWeight|fontStyle|fontFamily|textBackgroundColor|image)$/.test(pointer) || /^\/bands\/\d+\/model\/\d+\/(?:sortBy|alternateColor)$/.test(pointer);
}

/** A report only: no provider, network, evaluation or catalog mutation is performed. */
export async function dryRunLegacyVisualModel(text, { sourcePath = 'import.json', sourceCommit } = {}) {
  if (typeof text !== 'string') throw new ProviderError('invalid_legacy_input', 'Legacy dry-run requires original JSON text');
  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > BYTE_LIMIT) throw new ProviderError('legacy_template_size_limit', 'Legacy template exceeds 1 MiB', 413);
  const path = sourceLabel(sourcePath);
  if (sourceCommit !== undefined && !/^[0-9a-f]{40}$/i.test(sourceCommit)) throw new ProviderError('invalid_provenance', 'Source commit must be a complete 40-character hexadecimal commit');
  const source = parseStrictJson(text);
  if (!source || typeof source !== 'object' || Array.isArray(source) || !Array.isArray(source.params) || source.params.length !== 1 || !source.params[0] || typeof source.params[0] !== 'object' || Array.isArray(source.params[0]) || !Array.isArray(source.bands) || !source.bands.length) throw new ProviderError('unsupported_legacy_shape', 'Expected a visual template with one params object and at least one band');
  const candidate = { name: 'Imported legacy template', description: '', tags: [], definition: clone(DEFAULT_DEFINITION) };
  const mappedFields = new Set();
  const dispositions = [];
  const diagnostics = [];
  const redactedValues = [];
  let blocked = false;
  function walk(value, pointer = '', inheritedSensitive = false) {
    if (dispositions.length >= POINTER_LIMIT) throw new ProviderError('legacy_pointer_limit', 'Legacy template exceeds 10,000 JSON pointers', 413);
    const key = pointer.split('/').at(-1).replace(/~1/g, '/').replace(/~0/g, '~');
    const sensitive = inheritedSensitive || sensitiveKey(key) || unsafeText(value) || (typeof value === 'string' && !publicStringPointer(pointer));
    const container = value !== null && typeof value === 'object';
    const knownContainer = pointer === '' || pointer === '/params' || pointer === '/params/0' || pointer === '/bands' || /^\/bands\/[01](?:\/model(?:\/0)?)?$/.test(pointer);
    const entry = { pointer, disposition: 'unsupported', reason: 'No verified mapping to the implemented presentation v1 capability' };
    if (sensitive) {
      entry.disposition = 'redacted';
      entry.reason = 'Executable, network, credential or unrecognized text is excluded from the public report; only its hash is retained';
      redactedValues.push({ entry, value });
      blocked = true;
    } else if (container) {
      entry.disposition = knownContainer ? 'container' : 'unsupported';
      entry.reason = knownContainer ? 'Container; each child is evaluated independently' : 'Unsupported structured configuration';
      if (!knownContainer) blocked = true;
    } else if (mappingFor(pointer, source)) {
      const mapping = { ...mappingFor(pointer, source) };
      let mapped = value;
      let conversion = 'Value copied without numeric coercion';
      if (mapping.field === 'groupBy') {
        if (value === 'NONE') { mapped = 'none'; mapping.target = '/definition/groupBy'; conversion = 'Explicit NONE to none grouping'; }
        else if (typeof value === 'string' && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,7}$/.test(value)) { mapped = { field: `/data/${value.split('.').join('/')}`, direction: 'asc' }; conversion = 'Legacy data-property chain converted to safe JSON Pointer; no evaluation'; }
        else mapped = undefined;
      }
      if (mapping.field === 'axisPosition') { mapped = value === 'TOP' ? 'top' : value === 'BOTTOM' ? 'bottom' : undefined; conversion = 'Recognized axis-position enum only; no unknown-value fallback'; }
      if (mapping.field === 'fontWeight' && typeof value === 'string') { mapped = ({ normal: 400, bold: 700 })[value.toLowerCase()]; conversion = 'Named legacy weight converted to approved measured font weight'; }
      if (mapping.field === 'fontStyle' && typeof value === 'string') { mapped = ['normal', 'italic'].includes(value.toLowerCase()) ? value.toLowerCase() : undefined; conversion = 'Named legacy style converted to approved measured font style'; }
      if (mapped === undefined || (mapping.field === 'name' && (typeof mapped !== 'string' || !mapped.trim() || [...mapped].length > 100))) {
        entry.reason = 'Legacy value has no lossless supported mapping';
        blocked = true;
      } else {
        assignTarget(candidate, mapping.target, clone(mapped));
        if (mapping.target.startsWith('/definition/') && mapping.target.split('/').length === 3) mappedFields.add(mapping.target.split('/')[2]);
        if (mapping.field === 'intervalUnit' && mapping.role === 'primary') { candidate.definition.displayUnit = mapped; mappedFields.add('displayUnit'); }
        if (mapping.field === 'fontSize' && mapping.target === '/definition/fontSize') candidate.definition.rowHeight = Math.max(candidate.definition.rowHeight, typeof mapped === 'number' ? mapped + 19 : 32);
        Object.assign(entry, { disposition: 'mapped', target: mapping.target, reason: conversion });
        if (mapping.field === 'dateFormat') diagnostics.push({ pointer, code: 'calendar_format_correction', severity: 'notice', message: 'Formatting uses corrected calendar months, padded numeric values and 24-hour hh; known legacy formatter defects are not reproduced' });
        if (mapping.field === 'groupBy' && value !== 'NONE') diagnostics.push({ pointer, code: 'typed_grouping_correction', severity: 'notice', message: 'Grouping uses deterministic typed values and explicit missing/null lanes instead of eval and substring discovery' });
      }
    } else if (pointer === '/params/0/name' || /^\/bands\/\d+\/name$/.test(pointer)) {
      entry.disposition = 'preserved-alias';
      entry.reason = 'Authored name is provenance, never a catalog identity or deduplication key';
    } else if (/^\/bands\/[01]\/model\/0\/alternateColor$/.test(pointer)) {
      entry.disposition = 'preserved-inactive';
      entry.reason = 'Declared in the legacy templates but no consumer through band.model was found; retained as inactive provenance, not applied';
    } else if (pointer === '/params/0/camera' && value === 'Orthographic') {
      entry.disposition = 'matched-default';
      entry.reason = 'Recognized Orthographic matches the implemented 2D camera; no authored camera control is fabricated';
    } else if (/\/fontFamily$/.test(pointer) && value === 'Noto Sans') {
      entry.disposition = 'matched-profile';
      entry.reason = 'Matches the approved embedded Noto Sans family; requested weight/style still require their measured profile';
    } else if (/\/(?:fontSizeInt|x|y|width|multiples|trackIncrement)$/.test(pointer) && /^\/bands\//.test(pointer)) {
      entry.disposition = 'derived';
      entry.reason = 'Legacy runtime overwrote this value; current layout recomputes it from the validated profile, viewport and query';
    } else {
      blocked = true;
      if (pointer === '/params/0/date') entry.reason = 'Reference dates belong to view state; no browser-dependent date parsing or implicit navigation';
      else if (/\/(?:top|left|height|width)$/.test(pointer)) entry.reason = 'Legacy fixed geometry is not equivalent to responsive runtime dimensions';
      else if (/\/(?:intervalPixels|subIntervalPixels)$/.test(pointer)) entry.reason = 'Legacy per-unit pixel scale/subdivision preference is not equivalent to the current map/view range; preserve and review without inventing zoom';
      else if (/\/fontFamily$/.test(pointer)) entry.reason = 'The runtime uses approved embedded Noto Sans profiles; importing a different legacy family requires explicit font-substitution review';
      else if (pointer === '/params/0/camera') entry.reason = 'Perspective and unknown camera values are not implemented; never substitute Orthographic silently';
      else if (/\/image$/.test(pointer)) entry.reason = 'Per-record approved icons exist, but a legacy band image fallback is not yet an equivalent model-level asset mapping';
      else if (/^\/bands\/[2-9]/.test(pointer)) entry.reason = 'Additional legacy bands need an explicit multi-band mapping; only one primary and one identified overview are implemented';
      else if (/\/(?:luminance|opacity|defaultSessionTexture)$/.test(pointer)) entry.reason = 'No demonstrated downstream legacy effect for this authored field; review inactive provenance rather than inventing a renderer capability';
    }
    if (!container && !sensitive) entry.value = clone(value);
    dispositions.push(entry);
    if (container) for (const [childKey, child] of Object.entries(value)) walk(child, `${pointer}/${escapePointer(childKey)}`, sensitive);
  }
  walk(source);
  for (const { entry, value } of redactedValues) entry.valueSha256 = await sha256(value);
  const validation = validateDefinition(candidate.definition);
  if (!validation.valid) blocked = true;
  const equivalentFont = source.params[0].fontFamily === 'Noto Sans' && source.bands.every(band => !band?.fontFamily || band.fontFamily === 'Noto Sans');
  diagnostics.push({ pointer: '/params/0/fontFamily', code: 'measured_font_profile', severity: equivalentFont ? 'notice' : 'review-required', message: 'The candidate uses embedded Noto Sans with measured variants. Legacy Arial/default or another family is not claimed to have identical glyph geometry' });
  if (!equivalentFont) blocked = true;
  for (const item of dispositions) if (['unsupported', 'redacted'].includes(item.disposition)) diagnostics.push({ pointer: item.pointer, code: item.disposition === 'redacted' ? 'restricted_legacy_value' : 'unmapped_legacy_capability', severity: 'blocking', message: item.reason });
  const defaults = Object.keys(DEFAULT_DEFINITION).filter(field => !mappedFields.has(field)).map(field => ({ pointer: `/definition/${field}`, value: clone(candidate.definition[field]), reason: 'Current supported default or validated minimum, not claimed as an equivalent legacy value' }));
  const counts = {};
  for (const item of dispositions) counts[item.disposition] = (counts[item.disposition] ?? 0) + 1;
  return {
    format: 'openbexi-legacy-visual-dry-run-v1',
    adapterVersion: 'presentation-v1',
    source: { path, sha256: await sha256(text), byteLength, authoredName: dispositions.find(item => item.pointer === '/params/0/name' && item.disposition === 'preserved-alias')?.value ?? null, ...(sourceCommit ? { commit: sourceCommit } : {}) },
    status: blocked ? 'blocked' : 'ready-for-explicit-create',
    canCreate: !blocked,
    candidate,
    defaults,
    validation,
    diagnostics,
    counts,
    dispositions,
  };
}
