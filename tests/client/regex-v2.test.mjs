import test from 'node:test';
import assert from 'node:assert/strict';
import { RE2Set } from 're2js';
import corpus from '../../shared/fixtures/regex-cases.json' with { type: 'json' };
import { compileRegex, createRegexBudget } from '../../client/src/data/safe-regex.js';
import { compileExpression, compileSearch } from '../../client/src/data/filter-expression.js';

for (const item of corpus.cases) test(`v2 RE2 common dialect: ${item.id}`, () => {
  const operation = () => compileRegex(item.pattern, { flags: item.flags, matchMode: item.matchMode });
  if (item.error) assert.throws(operation, error => {
    assert.equal(error.code, item.error); assert.equal(error.diagnostic.offset, item.offset);
    assert.equal(error.diagnostic.offsetUnit, 'unicode-codepoint'); return true;
  });
  else {
    const compiled = operation();
    assert.deepEqual(item.subjects.map(value => compiled.test(value)), item.expected);
    assert.equal(compiled.emptyMatch, item.emptyMatch ?? false);
  }
});

const node = overrides => ({ op: 'regex', ruleId: 'title-match', field: '/title', pattern: '^Activity_(5_1|0_3)$', ...overrides });
test('v2 predicate IDs, unknown truth and explanations do not alter v1', () => {
  const root = node(), predicate = compileExpression({ version: 2, root });
  assert.equal(predicate({ title: 'Activity_5_1' }), true);
  assert.equal(predicate({ title: 'Activity_0_3_read_descriptor' }), false);
  assert.equal(predicate({}), false); assert.equal(predicate({ title: null }), false);
  const negated = compileExpression({ version: 2, root: { op: 'not', arg: root } });
  assert.equal(negated({}), false); assert.equal(negated({ title: null }), false);
  assert.deepEqual(predicate.explain({ title: 'Activity_5_1' }), { matched: true, rules: [{ ruleId: 'title-match', field: '/title', op: 'regex' }], truncated: false });
  assert.throws(() => compileExpression({ version: 1, root }), { code: 'invalid_filter' });
  assert.throws(() => compileExpression({ version: 2, root: { op: 'or', args: [root, root] } }), { code: 'invalid_filter' });
  assert.throws(() => compileExpression({ version: 2, root: node({ field: '/order' }) }), { code: 'invalid_filter' });
});

test('explicit v2 search flags, full matching and approved string fields', () => {
  const input = { definitionVersion: 2, searchMode: 'regex', search: 'Activity_[05]_[13]', searchFields: ['/title'], searchMatchMode: 'full' };
  const search = compileSearch(input);
  assert.equal(search.matches({ title: 'Activity_5_1' }), true);
  assert.equal(search.matches({ title: 'Activity_5_1_suffix' }), false);
  assert.deepEqual(search.explain({ title: 'Activity_5_1' }), { matched: true, rules: [{ ruleId: 'search', field: '/title', op: 'regex' }], truncated: false });
  for (const change of [{ definitionVersion: 1 }, { search: '' }, { searchFields: ['/order'] }, { searchCaseSensitive: false }, { searchFlags: null }]) assert.throws(() => compileSearch({ ...input, ...change }));
  assert.throws(() => compileSearch({ searchFlags: [] }), { code: 'invalid_search' });
  assert.throws(() => compileSearch({ definitionVersion: 2, searchFlags: [] }), { code: 'invalid_search' });
  assert.equal(compileSearch({ search: 'STRASSE' }).matches({ title: 'Stra\u00dfe' }), true);
  assert.equal(compileSearch({ definitionVersion: 2, searchMode: 'regex', search: 'STRASSE', searchFlags: ['i'] }).matches({ title: 'Stra\u00dfe' }), false);
});

test('regex limits bound AST nodes, fields, UTF-8 bytes, aggregate work and cancellation', () => {
  assert.throws(() => compileRegex('x'.repeat(513)), { code: 'invalid_regex' });
  assert.doesNotThrow(() => compileRegex('\ud83d\ude80'.repeat(512)));
  assert.equal(compileRegex('.{1000}', { matchMode: 'full' }).test('a'.repeat(1000)), true);
  assert.throws(() => compileExpression({ version: 2, root: { op: 'and', args: Array.from({ length: 9 }, (_, index) => node({ ruleId: `r${index}` })) } }), { code: 'regex_resource_limit' });
  const budget = createRegexBudget({ maxWork: 3 }), first = compileRegex('a', { budget }), second = compileRegex('b', { budget });
  first.test('aa'); second.test('b'); assert.deepEqual(budget.usage, { bytes: 3, work: 3 });
  assert.throws(() => second.test('b'), { code: 'regex_resource_limit', status: 413 });
  assert.throws(() => compileRegex('.', { budget: createRegexBudget({ maxBytes: 3 }) }).test('\ud83d\ude80'), { code: 'regex_resource_limit' });
  const controller = new AbortController(), cancelled = compileRegex('a', { budget: createRegexBudget({ signal: controller.signal }) });
  controller.abort(); assert.throws(() => cancelled.test('a'), { name: 'AbortError' });
  assert.throws(() => compileRegex('.', { flags: ['i'] }).test('\u1c8a'), { code: 'regex_unicode_version' });
});

test('literal explanations respect same-field matches, All terms and output limits', () => {
  const search = compileSearch({ search: 'alpha beta', searchMode: 'all', searchFields: ['/title', '/data/description'] });
  assert.deepEqual(search.explain({ title: 'Alpha', data: { description: 'Beta' } }), { matched: true, rules: [{ ruleId: 'search-term-1', field: '/title', op: 'literal' }, { ruleId: 'search-term-2', field: '/data/description', op: 'literal' }], truncated: false });
  assert.deepEqual(search.explain({ title: 'Alpha' }), { matched: false, rules: [], truncated: false });
  assert.deepEqual(compileSearch({}).explain({ title: 'Alpha' }), { matched: false, rules: [], truncated: false });
  const bounded = compileSearch({ search: Array(20).fill('x').join(' '), searchFields: ['/title'] }).explain({ title: 'x' });
  assert.equal(bounded.rules.length, 16); assert.equal(bounded.truncated, true);
});

test('RE2 compile/evaluation failures have no alternate native-regex path', () => {
  const add = RE2Set.prototype.add, match = RE2Set.prototype.match;
  try {
    RE2Set.prototype.add = () => { throw new Error('injected initialization failure'); };
    assert.throws(() => compileRegex('unique-engine-initialization-probe'), { code: 'regex_engine_failure' });
    RE2Set.prototype.add = add;
    const compiled = compileRegex('unique-engine-evaluation-probe');
    RE2Set.prototype.match = () => { throw new Error('injected evaluation failure'); };
    assert.throws(() => compiled.test('unique-engine-evaluation-probe'), { code: 'regex_engine_failure' });
  } finally { RE2Set.prototype.add = add; RE2Set.prototype.match = match; }
});
