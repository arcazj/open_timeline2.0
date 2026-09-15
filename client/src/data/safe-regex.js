import { RE2JS, RE2Set, RE2JSSyntaxException } from 're2js';
import limits from '../../../shared/fixtures/regex-dialect.json' with { type: 'json' };
import { ProviderError, abortIfNeeded } from './data-provider.js';

export const regexCapabilities = Object.freeze({
  dialect: limits.dialect, engines: Object.freeze(limits.engines), flags: Object.freeze(['i', 'm', 's']),
  matchModes: Object.freeze(['search', 'full']), patternCodepoints: limits.patternCodepoints,
  regexNodes: limits.regexNodes, searchFields: limits.searchFields, unicodeProperties: false,
  expansionUnits: limits.expansionUnits, fieldBytes: limits.fieldBytes, aggregateBytes: limits.aggregateBytes, aggregateWork: limits.aggregateWork,
  subjectNormalization: 'NFC', casefold: 'engine-simple-common-15.1',
  incompatibleCasefoldRanges: Object.freeze(limits.incompatibleCasefoldRanges.map(range => Object.freeze([...range]))),
});
const cache = new Map();
const utf8 = new TextEncoder();
const incompatibleCasefold = point => limits.incompatibleCasefoldRanges.some(([from, to]) => point >= from && point <= to);

export function regexError(code, message, { offset = null, field, ruleId, hint = 'Use the documented RE2 common syntax.', status = 422 } = {}) {
  const diagnostic = { code, offset, offsetUnit: 'unicode-codepoint', hint };
  if (field !== undefined) diagnostic.field = field;
  if (ruleId !== undefined) diagnostic.ruleId = ruleId;
  throw new ProviderError(code, message, status, { diagnostic });
}

export function createRegexBudget({ maxWork = limits.aggregateWork, maxBytes = limits.aggregateBytes, signal, checkCancelled } = {}) {
  if (!Number.isSafeInteger(maxWork) || maxWork < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Regex budgets must be positive safe integers');
  let bytes = 0, work = 0;
  return { consume(value, cost, context) {
    abortIfNeeded(signal); checkCancelled?.();
    const size = utf8.encode(value).length;
    bytes += size; work += Math.max(1, [...value].length) * cost;
    if (size > limits.fieldBytes || bytes > maxBytes || work > maxWork) regexError('regex_resource_limit', 'Regex evaluation exceeded its field or aggregate work budget', { ...context, status: 413, hint: 'Narrow the time range, source selection, fields, or pattern.' });
  }, get usage() { return { bytes, work }; } };
}

// This gate restricts syntax; all parsing, compilation and matching remain in RE2.
export function validateRegex(pattern, flags = [], matchMode = 'search', dialect = limits.dialect, context = {}) {
  const fail = (code, message, offset = null, hint) => regexError(code, message, { ...context, offset, hint, status: code === 'regex_resource_limit' ? 413 : 422 });
  if (typeof pattern !== 'string' || !pattern || [...pattern].length > limits.patternCodepoints) fail('invalid_regex', 'Regex requires 1-512 Unicode codepoints');
  if (!Array.isArray(flags) || flags.some(flag => !['i', 'm', 's'].includes(flag)) || new Set(flags).size !== flags.length) fail('invalid_regex_flags', 'Regex flags must be unique i, m, or s values');
  if (!['search', 'full'].includes(matchMode)) fail('invalid_regex', 'Regex matchMode must be search or full');
  if (dialect !== limits.dialect) fail('unsupported_regex_dialect', 'Unsupported regex dialect');
  const chars = [...pattern], stack = [], weights = [{ total: 0, last: 0 }]; let inClass = false, classStart = 0, classContent = false;
  const atom = units => { const frame = weights.at(-1); frame.total += units; frame.last = units; };
  const checkPoint = (point, offset) => {
    if (point >= 0xd800 && point <= 0xdfff || point > 0x10ffff) fail('invalid_regex', 'Regex contains an invalid Unicode scalar', offset);
    if (flags.includes('i') && incompatibleCasefold(point)) fail('regex_unicode_version', 'This character has incompatible case folding between the pinned engines', offset, 'Use case-sensitive regex or literal search for this character.');
  };
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]; checkPoint(char.codePointAt(0), index);
    if (char === '\\') {
      const start = index, next = chars[++index];
      if (next === undefined) fail('invalid_regex', 'Regex ends with an unfinished escape', start);
      if ('0123456789'.includes(next)) fail('unsupported_regex_syntax', 'Backreferences and octal escapes are not supported', start, 'Use an explicit character or hexadecimal escape.');
      if (['p', 'P', 'C', 'Q', 'E', 'k', 'g', 'u', 'U', 'Z', 'e'].includes(next)) fail('unsupported_regex_syntax', 'This escape is outside the shared regex dialect', start);
      if (next === 'x') {
        let hex = '';
        if (chars[index + 1] === '{') {
          index += 2;
          while (index < chars.length && chars[index] !== '}') hex += chars[index++];
          if (chars[index] !== '}' || !hex || hex.length > 6) fail('invalid_regex', 'Invalid hexadecimal escape', start);
        } else {
          hex = (chars[index + 1] ?? '') + (chars[index + 2] ?? ''); index += 2;
          if (hex.length !== 2) fail('invalid_regex', 'Hexadecimal escape requires two digits or braces', start);
        }
        if ([...hex].some(value => !'0123456789abcdefABCDEF'.includes(value))) fail('invalid_regex', 'Invalid hexadecimal escape', start);
        checkPoint(Number.parseInt(hex, 16), start);
      } else if (next >= 'A' && next <= 'Z' || next >= 'a' && next <= 'z') {
        if (!'afnrtvAbBdDsSwWz'.includes(next)) fail('unsupported_regex_syntax', 'Unsupported regex escape', start);
      }
      if (inClass) classContent = true; else atom(1);
      continue;
    }
    if (inClass) {
      if (char === ']' && classContent) { inClass = false; atom(index - classStart + 1); }
      else if (!(index === classStart + 1 && char === '^')) classContent = true;
      continue;
    }
    if (char === '[') { inClass = true; classStart = index; classContent = false; continue; }
    if (char === '(') {
      if (chars[index + 1] === '?' && chars[index + 2] !== ':') fail('unsupported_regex_syntax', 'Lookaround, inline flags and named groups are not supported', index, 'Use a Boolean filter group and the explicit i, m, s flags.');
      stack.push(index);
      weights.push({ total: 0, last: 0 });
      if (chars[index + 1] === '?' && chars[index + 2] === ':') index += 2;
    } else if (char === ')') {
      if (!stack.length) fail('invalid_regex', 'Unmatched closing parenthesis', index);
      stack.pop();
      atom(weights.pop().total + 2);
    } else if (char === '{') {
      let end = index + 1;
      while (end < chars.length && '0123456789,'.includes(chars[end])) end++;
      if (chars[end] === '}' && end > index + 1) {
        const parts = chars.slice(index + 1, end).join('').split(',');
        if (parts.length <= 2 && parts[0] && parts.every(part => !part || Number(part) <= 1000)) {
          const frame = weights.at(-1), repeated = Math.max(0, Number(parts.at(-1) || parts[0]) - 1) * frame.last + (parts.length === 2 && !parts[1] ? 2 : 0);
          frame.total += repeated; frame.last += repeated; index = end;
        } else atom(1);
      } else atom(1);
    } else if (char === '*' || char === '+' || char === '?') { const frame = weights.at(-1); frame.total += 2; frame.last += 2; }
    else if (char === '|') { atom(1); weights.at(-1).last = 0; }
    else atom(1);
  }
  if (inClass) fail('invalid_regex', 'Unclosed character class', classStart);
  if (stack.length) fail('invalid_regex', 'Unclosed parenthesis', stack.at(-1));
  const cost = weights[0].total;
  if (cost > limits.expansionUnits) fail('regex_resource_limit', 'Regex exceeds the shared expansion budget', null, 'Reduce repetition or alternatives in the pattern.');
  return { pattern, flags: [...flags].sort(), matchMode, dialect, cost: Math.max(1, cost) };
}

export function compileRegex(pattern, { flags = [], matchMode = 'search', dialect = limits.dialect, budget = createRegexBudget(), ...context } = {}) {
  const specification = validateRegex(pattern, flags, matchMode, dialect, context);
  const key = JSON.stringify([limits.engines.javascript, specification]);
  let compiled = cache.get(key);
  if (compiled) { cache.delete(key); cache.set(key, compiled); }
  else {
    let engine;
    try {
      const engineFlags = (flags.includes('i') ? RE2JS.CASE_INSENSITIVE : 0) | (flags.includes('m') ? RE2JS.MULTILINE : 0) | (flags.includes('s') ? RE2JS.DOTALL : 0);
      engine = new RE2Set(matchMode === 'full' ? RE2Set.ANCHOR_BOTH : RE2Set.UNANCHORED, engineFlags, limits.engineMemoryBytes);
      engine.add(pattern); engine.compile();
      if (engine.prog.numInst() > limits.programInstructions) regexError('regex_resource_limit', 'Regex compiled program exceeds its instruction budget', { ...context, status: 413, hint: 'Reduce repetition or alternatives in the pattern.' });
      compiled = { engine, emptyMatch: engine.match('').length > 0 };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof RE2JSSyntaxException) regexError('invalid_regex', 'Invalid RE2 expression', context);
      regexError('regex_engine_failure', 'The bounded regex engine could not compile this expression', { ...context, status: 503, hint: 'Simplify the pattern or retry; no alternate regex engine is used.' });
    }
    cache.set(key, compiled);
    while (cache.size > limits.cacheEntries) cache.delete(cache.keys().next().value);
  }
  return { ...specification, emptyMatch: compiled.emptyMatch, test(raw, evaluationContext = {}) {
    const activeContext = { ...context, ...evaluationContext };
    const subject = raw.normalize('NFC');
    budget.consume(subject, specification.cost, activeContext);
    if (flags.includes('i')) {
      const index = [...subject].findIndex(char => incompatibleCasefold(char.codePointAt(0)));
      if (index >= 0) regexError('regex_unicode_version', 'A selected field contains a character with incompatible engine case folding', { ...activeContext, offset: index, hint: 'Use case-sensitive regex or literal search for this field.' });
    }
    try { return compiled.engine.match(subject).length > 0; }
    catch { regexError('regex_engine_failure', 'The bounded regex engine failed during evaluation', { ...activeContext, status: 503, hint: 'Retry with a narrower scope; no alternate regex engine is used.' }); }
  } };
}
