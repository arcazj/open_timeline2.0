import { compileExpression } from './filter-expression.js';
import builtInFields from '../../../shared/fixtures/filter-fields.json' with { type: 'json' };

const fieldPrefix = /^[A-Za-z_][A-Za-z0-9_./~]*\s*[:=]/u;
const scalarField = (name, fields) => {
  const aliases = { title: '/title', start: '/start', end: '/end', id: '/id', namespace: '/data/namespace' };
  const pointer = name.startsWith('/') ? name : aliases[name] ?? `/data/${name}`;
  return Object.hasOwn(fields, pointer) && fields[pointer] !== 'strings' ? pointer : null;
};

export function migrateLegacyFilter(input, { fieldTypes = builtInFields } = {}) {
  const diagnostics = [], required = new Set();
  const issue = (code, message, offset = 0, repair = false) => {
    diagnostics.push({ code, message, offset, offsetUnit: 'unicode-codepoint', severity: repair ? 'warning' : 'error' });
    if (repair) required.add(code);
  };
  const invalid = message => { throw new Error(message); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['include', 'exclude', 'sortBy', 'relationshipMode', 'acknowledgements'].includes(key))) {
    issue('migration_input', 'Use explicit include, exclude and sortBy fields.');
    return { format: 'legacy-filter-migration', version: 1, classification: 'blocked', publishable: false, diagnostics, requiredAcknowledgements: [], draft: null };
  }
  const { include = '', exclude = '', sortBy = 'NONE', acknowledgements = [], relationshipMode = 'independent' } = input;
  if ([include, exclude, sortBy].some(value => typeof value !== 'string' || [...value].length > 4096) ||
      !Array.isArray(acknowledgements) || acknowledgements.length > 20 || acknowledgements.some(value => typeof value !== 'string' || value.length > 128) || !['independent', 'family'].includes(relationshipMode)) {
    issue('migration_input', 'Migration text must be bounded; choose independent or family relationships.');
    return { format: 'legacy-filter-migration', version: 1, classification: 'blocked', publishable: false, diagnostics, requiredAcknowledgements: [], draft: null };
  }
  let ordinal = 0;
  function leaf(text) {
    const match = /^([A-Za-z_][A-Za-z0-9_./~]*)\s*([:=])([\s\S]*)$/u.exec(text.trim());
    if (!match) invalid('A condition must identify an approved field with : or =. Unscoped serialized-object patterns require manual field selection.');
    const field = scalarField(match[1], fieldTypes), raw = match[3].trim();
    if (!field) invalid(`Unknown or nonscalar field: ${match[1]}. Select its published schema first.`);
    if (!raw) invalid('Empty condition values are ambiguous. Use an explicit typed empty-string rule.');
    const ruleId = `migration-${++ordinal}`;
    if (match[2] === '=') {
      issue('help-equality-repair', 'The inspected legacy server does not implement the advertised equality syntax; this is an intent repair.', 0, true);
      let value;
      if (fieldTypes[field] === 'string' || fieldTypes[field] === 'date') {
        value = raw.startsWith('"') ? JSON.parse(raw) : raw;
      } else value = JSON.parse(raw);
      return { op: 'eq', field, value, ruleId };
    }
    issue('typed-field-repair', 'Typed field matching replaces serialized-object matching; nested children and JSON punctuation no longer create parent hits.', 0, true);
    if (fieldTypes[field] !== 'string') invalid('A legacy colon pattern on a non-text field requires an explicit typed equality/comparison repair.');
    if (/[.*?^$()[\]{}\\|+]/u.test(raw)) return { op: 'regex', field, pattern: raw, flags: [], matchMode: 'search', dialect: 're2-common-v1', ruleId };
    return { op: 'contains', field, value: raw, caseSensitive: true, ruleId };
  }
  function tree(text) {
    if (!text.trim()) return null;
    const alternatives = [[]]; let start = 0, escaped = false, bracket = false, depth = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '[') bracket = true;
      if (char === ']' && bracket) { bracket = false; continue; }
      if (bracket) continue;
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (depth < 0) invalid('Unbalanced pattern grouping.');
      if (depth || ![';', '+', '|'].includes(char)) continue;
      if (char === '|') invalid('A top-level pipe is ambiguous between legacy include/exclude separation and regex alternation. Use separate include/exclude fields or a structured rule.');
      if (!fieldPrefix.test(text.slice(index + 1).trimStart())) invalid('An unescaped separator or repetition is ambiguous. Rewrite it as a structured regex or AND/OR rule.');
      alternatives.at(-1).push(leaf(text.slice(start, index))); start = index + 1;
      if (char === ';') alternatives.push([]);
    }
    if (escaped || bracket || depth) invalid('Unfinished escape, character class or grouping.');
    alternatives.at(-1).push(leaf(text.slice(start)));
    const nodes = alternatives.map(args => args.length === 1 ? args[0] : { op: 'and', args });
    return nodes.length === 1 ? nodes[0] : { op: 'or', args: nodes };
  }
  let draft = null;
  try {
    const included = tree(include), excluded = tree(exclude);
    const root = included && excluded ? { op: 'and', args: [included, { op: 'not', arg: excluded }] } : included ?? (excluded ? { op: 'not', arg: excluded } : null);
    const expression = root ? { version: 2, root } : null;
    compileExpression(expression, { fieldTypes });
    let grouping = null;
    if (sortBy && sortBy !== 'NONE') {
      const field = sortBy === 'namespace' ? '/data/namespace' : scalarField(sortBy, fieldTypes);
      if (!field) invalid('Legacy grouping is not a registered scalar field.');
      grouping = { field, direction: 'asc' };
      issue('deterministic-group-order', 'Groups use deterministic codepoint order instead of legacy encounter order.', 0, true);
    }
    if (relationshipMode === 'family') issue('explicit-family-context', 'Family retention includes authorized family members only; direct predicate hits and context remain distinct.', 0, true);
    draft = { definitionVersion: 2, relationshipMode, expression, grouping, groupOrder: { order: 'codepoint', caseSensitive: true },
      migration: { format: 'legacy-filter-migration', version: 1, original: { include, exclude, sortBy }, acknowledged: [...required].filter(code => acknowledgements.includes(code)) } };
  } catch (error) { issue(error.diagnostic?.code ?? 'migration_ambiguous', error.message, error.diagnostic?.offset ?? 0); }
  const blocked = diagnostics.some(item => item.severity === 'error');
  const missing = [...required].filter(code => !acknowledgements.includes(code));
  if (!blocked && missing.length) diagnostics.push({ code: 'intent_repair_required', message: 'Review and acknowledge the proposed semantic repairs before using this draft.', offset: 0, offsetUnit: 'unicode-codepoint', severity: 'warning' });
  return { format: 'legacy-filter-migration', version: 1, classification: blocked ? 'blocked' : required.size ? 'intent-repair' : 'exact',
    publishable: !blocked && !missing.length, diagnostics, requiredAcknowledgements: [...required], draft: blocked ? null : draft };
}
