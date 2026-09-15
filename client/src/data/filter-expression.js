import baseFieldTypes from '../../../shared/fixtures/filter-fields.json' with { type: 'json' };
import casefold from '../../../shared/fixtures/casefold.json' with { type: 'json' };
import { ProviderError } from './data-provider.js';
import { compileRegex, createRegexBudget, regexCapabilities, regexError } from './safe-regex.js';
export { createRegexBudget, regexCapabilities } from './safe-regex.js';
import { toMs } from '../timeline/time-scale.js';
import { overlaps } from '../timeline/layout.js';

const folds = casefold.mappings ?? casefold;
const whitespace = /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
const defaultSearchFields = ['/title', '/data/description', '/data/text', '/data/system', '/data/type', '/data/status'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = message => { throw new ProviderError('invalid_filter', message, 422); };
export function foldText(value) { return [...value.normalize('NFC')].map(c => folds[String(c.codePointAt(0))] ?? c).join('').normalize('NFC'); }
export function fieldValue(record, path) {
  let value = record;
  for (const encoded of path.slice(1).split('/')) {
    const segment = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!plain(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}
function typed(value, type, path) {
  if (value === null) return null;
  if (type === 'date') { try { if (typeof value !== 'string') throw new Error(); return toMs(value); } catch { error(`${path} requires an offset timestamp`); } }
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return value;
  if (type === 'boolean' && typeof value === 'boolean') return value;
  if (type === 'string' && typeof value === 'string') return value.normalize('NFC');
  if (type === 'strings' && Array.isArray(value) && value.every(item => typeof item === 'string')) return value.map(item => item.normalize('NFC'));
  error(`${path} has an incompatible value type`);
}
function ordered(left, right) {
  if (typeof left === 'number') return left < right ? -1 : left > right ? 1 : 0;
  const a = [...left], b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i].codePointAt(0) - b[i].codePointAt(0);
  return a.length - b.length;
}
export function compileExpression(expression, { fieldTypes = baseFieldTypes, regexBudget = createRegexBudget() } = {}) {
  if (expression === undefined || expression === null) return () => true;
  if (!plain(expression) || ![1, 2].includes(expression.version) || Object.keys(expression).some(key => !['version', 'root'].includes(key))) error('Expected a version 1 or 2 filter expression');
  let count = 0, regexCount = 0;
  const ruleIds = new Set(), explanationNodes = [];
  function compile(node, depth = 1) {
    const ordinal = count + 1, evaluate = compileNode(node, depth);
    if (expression.version === 2) explanationNodes.push({ ruleId: node.ruleId ?? `$node-${ordinal}`, field: node.field, op: node.op, evaluate });
    return evaluate;
  }
  function compileNode(node, depth) {
    if (!plain(node) || typeof node.op !== 'string' || depth > 8 || ++count > 100) error('Filter exceeds its structure, depth 8, or 100-node limit');
    if (expression.version === 2 && node.ruleId !== undefined) {
      if (typeof node.ruleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(node.ruleId) || ruleIds.has(node.ruleId)) error('Rule IDs must be unique 1-64 character identifiers');
      ruleIds.add(node.ruleId);
    }
    const keys = allowed => { if (Object.keys(node).some(key => !allowed.includes(key) && !(expression.version === 2 && key === 'ruleId'))) error(`Unknown field in ${node.op}`); };
    if (['and', 'or'].includes(node.op)) {
      keys(['op', 'args']);
      if (!Array.isArray(node.args) || !node.args.length || node.args.length > 100) error('Boolean groups require 1-100 expressions');
      const children = node.args.map(child => compile(child, depth + 1));
      return record => { const values = children.map(child => child(record)); return node.op === 'and' ? values.includes(false) ? false : values.includes(null) ? null : true : values.includes(true) ? true : values.includes(null) ? null : false; };
    }
    if (node.op === 'not') { keys(['op', 'arg']); const child = compile(node.arg, depth + 1); return record => { const value = child(record); return value === null ? null : !value; }; }
    if (node.op === 'overlaps') {
      keys(['op', 'from', 'to']);
      let from, to;
      try { if (typeof node.from !== 'string' || typeof node.to !== 'string') throw new Error(); from = toMs(node.from); to = toMs(node.to); } catch { error('Overlap requires valid offset timestamps'); }
      if (from >= to) error('Overlap interval must be positive');
      return record => overlaps(record, from, to);
    }
    if (typeof node.field !== 'string' || !Object.hasOwn(fieldTypes, node.field)) error('Unknown or undeclared filter field');
    const type = fieldTypes[node.field];
    if (node.op === 'exists') { keys(['op', 'field', 'value']); if (typeof node.value !== 'boolean') error('Exists requires a boolean value'); return record => (fieldValue(record, node.field) !== undefined) === node.value; }
    if (node.op === 'regex' && expression.version === 2) {
      keys(['op', 'field', 'pattern', 'flags', 'matchMode', 'dialect']);
      if (++regexCount > regexCapabilities.regexNodes) regexError('regex_resource_limit', 'Filter exceeds eight regex nodes', { status: 413 });
      if (type !== 'string') error('Regex requires a declared string field');
      const compiled = compileRegex(node.pattern, { flags: node.flags, matchMode: node.matchMode, dialect: node.dialect, budget: regexBudget, field: node.field, ruleId: node.ruleId });
      return record => { const raw = fieldValue(record, node.field); return raw === undefined || raw === null ? null : compiled.test(typed(raw, type, node.field)); };
    }
    if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains'].includes(node.op)) error('Unsupported filter operator');
    keys(node.op === 'in' ? ['op', 'field', 'values'] : node.op === 'contains' ? ['op', 'field', 'value', 'caseSensitive'] : ['op', 'field', 'value']);
    if (type === 'strings' && node.op !== 'contains') error('Array fields support contains and exists only');
    if (type === 'boolean' && !['eq', 'ne', 'in'].includes(node.op)) error('Boolean fields support equality, membership and exists only');
    if (node.op === 'contains' && !['string', 'strings'].includes(type)) error('Contains requires text or a text-array field');
    if (node.caseSensitive !== undefined && typeof node.caseSensitive !== 'boolean') error('caseSensitive must be boolean');
    let expected;
    if (node.op === 'in') {
      if (!Array.isArray(node.values) || !node.values.length || node.values.length > 100) error('In requires 1-100 typed values');
      expected = node.values.map(value => typed(value, type, node.field));
    } else {
      if (!Object.hasOwn(node, 'value')) error('Predicate value is required');
      expected = typed(node.value, type === 'strings' ? 'string' : type, node.field);
      if (expected === null && !['eq', 'ne'].includes(node.op)) error('Null supports equality or inequality only');
    }
    return record => {
      const raw = fieldValue(record, node.field);
      if (raw === undefined) return null;
      const value = typed(raw, type, node.field);
      if (node.op === 'eq') return value === expected;
      if (node.op === 'ne') return value !== expected;
      if (node.op === 'in') return expected.includes(value);
      if (value === null) return null;
      if (node.op === 'contains') {
        const normalize = node.caseSensitive ? text => text.normalize('NFC') : foldText;
        return type === 'strings' ? value.some(item => normalize(item) === normalize(expected)) : normalize(value).includes(normalize(expected));
      }
      const comparison = ordered(value, expected);
      return { lt: comparison < 0, lte: comparison <= 0, gt: comparison > 0, gte: comparison >= 0 }[node.op];
    };
  }
  const predicate = compile(expression.root);
  const result = record => predicate(record) === true;
  if (expression.version === 2) result.explain = record => {
    if (!result(record)) return { matched: false, rules: [], truncated: false };
    const hits = explanationNodes.filter(node => node.evaluate(record) === true);
    return { matched: true, rules: hits.slice(0, 16).map(({ ruleId, field, op }) => ({ ruleId, ...(field === undefined ? {} : { field }), op })), truncated: hits.length > 16 };
  };
  return result;
}

export function parseSearch(text, mode = 'any', caseSensitive = false) {
  if (typeof text !== 'string' || [...text].length > 512 || !['any', 'all', 'phrase'].includes(mode) || typeof caseSensitive !== 'boolean') throw new ProviderError('invalid_search', 'Invalid search text, mode or case option', 422);
  const terms = []; let term = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') { const next = text[++index]; if (next !== '\\' && next !== '"') throw new ProviderError('invalid_search', 'Only quote and backslash may be escaped', 422); term += next; }
    else if (char === '"') quoted = !quoted;
    else if (mode !== 'phrase' && !quoted && (whitespace.test(char) || char === ';')) { if (term) { terms.push(term); term = ''; } }
    else term += char;
  }
  if (quoted) throw new ProviderError('invalid_search', 'Unterminated search quote', 422);
  if (mode === 'phrase') { while (term && whitespace.test(term[0])) term = term.slice(1); while (term && whitespace.test(term.at(-1))) term = term.slice(0, -1); }
  if (term) terms.push(term);
  if (terms.length > 20) throw new ProviderError('invalid_search', 'Search exceeds 20 terms', 422);
  return terms.map(caseSensitive ? value => value.normalize('NFC') : foldText);
}
export function compileSearch(input, { fieldTypes = baseFieldTypes, regexBudget = createRegexBudget() } = {}) {
  const version = input.definitionVersion === undefined ? 1 : input.definitionVersion;
  if (![1, 2].includes(version)) throw new ProviderError('invalid_search', 'Unsupported query definition version', 422);
  if (version === 1 && (input.searchMode === 'regex' || ['searchFlags', 'searchMatchMode', 'searchDialect'].some(key => Object.hasOwn(input, key)))) throw new ProviderError('invalid_search', 'Regex search requires query definition version 2', 422);
  if (input.searchMode === 'regex') {
    const fields = input.searchFields === undefined ? defaultSearchFields : input.searchFields;
    if (!Array.isArray(fields) || !fields.length || fields.length > 16 || new Set(fields).size !== fields.length || fields.some(field => typeof field !== 'string' || !Object.hasOwn(fieldTypes, field) || fieldTypes[field] !== 'string')) throw new ProviderError('invalid_search', 'Regex search fields must be 1-16 unique declared string fields', 422);
    if (input.searchCaseSensitive !== undefined) throw new ProviderError('invalid_search', 'Regex search uses explicit flags instead of searchCaseSensitive', 422);
    const compiled = compileRegex(input.search, { flags: input.searchFlags, matchMode: input.searchMatchMode, dialect: input.searchDialect, budget: regexBudget, ruleId: 'search' });
    const matchFields = record => fields.filter(field => {
      const value = fieldValue(record, field);
      if (value === undefined || value === null) return false;
      if (typeof value !== 'string') throw new ProviderError('invalid_search', 'Regex search field has an incompatible value type', 422);
      return compiled.test(value, { field });
    });
    return { active: true, terms: [input.search], regex: { dialect: compiled.dialect, flags: compiled.flags, matchMode: compiled.matchMode, emptyMatch: compiled.emptyMatch },
      matches: record => matchFields(record).length > 0,
      explain: record => { const hits = matchFields(record); return { matched: hits.length > 0, rules: hits.map(field => ({ ruleId: 'search', field, op: 'regex' })), truncated: false }; } };
  }
  if (version === 2 && ['searchFlags', 'searchMatchMode', 'searchDialect'].some(key => Object.hasOwn(input, key))) throw new ProviderError('invalid_search', 'Regex options require regex search mode', 422);
  const mode = input.searchMode === undefined ? 'any' : input.searchMode, caseSensitive = input.searchCaseSensitive === undefined ? false : input.searchCaseSensitive;
  const terms = parseSearch(input.search === undefined ? '' : input.search, mode, caseSensitive), fields = input.searchFields === undefined ? defaultSearchFields : input.searchFields;
  if (!Array.isArray(fields) || !fields.length || fields.length > 16 || new Set(fields).size !== fields.length || fields.some(field => typeof field !== 'string' || !Object.hasOwn(fieldTypes, field) || fieldTypes[field] === 'strings')) throw new ProviderError('invalid_search', 'Search fields must be 1-16 unique declared scalar fields', 422);
  const normalize = caseSensitive ? value => value.normalize('NFC') : foldText;
  const matches = record => {
    if (!terms.length) return true;
    const values = fields.map(field => fieldValue(record, field)).filter(value => ['string', 'number', 'boolean'].includes(typeof value)).map(value => normalize(String(value)));
    const hits = terms.map(term => values.some(value => value.includes(term)));
    return mode === 'all' ? hits.every(Boolean) : hits.some(Boolean);
  };
  return { active: terms.length > 0, terms, matches, explain(record) {
    if (!terms.length || !matches(record)) return { matched: false, rules: [], truncated: false };
    const rules = [];
    for (const [index, term] of terms.entries()) for (const field of fields) {
      const value = fieldValue(record, field);
      if (['string', 'number', 'boolean'].includes(typeof value) && normalize(String(value)).includes(term)) rules.push({ ruleId: `search-term-${index + 1}`, field, op: 'literal' });
    }
    return { matched: true, rules: rules.slice(0, 16), truncated: rules.length > 16 };
  } };
}
