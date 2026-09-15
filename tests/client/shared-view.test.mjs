import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSharedView, decodeSharedView, sharedViewLink, validateSharedView } from '../../client/src/ui/shared-view.js';
import { documentTarget, swaggerDocument } from '../../client/src/ui/help-documents.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';

const view = () => ({ version: 1, range: { fromMs: '0', toMs: '3600000' }, domain: { from: '1970-01-01T00:00:00.000Z', to: '1970-01-02T00:00:00.000Z' }, settings: { theme: 'light', rowHeight: 32, fontSize: 13, groupBy: 'none', displayUnit: 'HOUR', timeZone: 'UTC', scaleMode: 'adaptive', ratio: 16, bins: 128 }, filters: { sourceId: 'all', kind: 'all' }, search: { search: 'Telemetry \u0142 <event>', searchMode: 'any', searchCaseSensitive: false }, view: 'timeline', scaleStrategy: 'automatic', selectedId: null, generation: null });

test('view links round-trip Unicode, fractional times, and display settings', () => {
  const input = view(); input.range.fromMs = '0.125';
  assert.deepEqual(structuredClone(decodeSharedView(encodeSharedView(input))), input);
  assert.deepEqual(structuredClone(decodeSharedView(sharedViewLink('https://example.org/timeline', input))), input);
});
test('links strip credentials, query secrets and local filesystem locations', () => {
  const link = sharedViewLink('https://alice:secret@example.org/timeline?token=sensitive&path=C:/data', view());
  assert.equal(new URL(link).search, ''); assert.equal(new URL(link).username, ''); assert.equal(new URL(link).password, '');
  assert.ok(!link.includes('secret') && !link.includes('C:/data'));
  assert.match(sharedViewLink('file:///C:/private/data/index.html', view()), /^#view=/);
  assert.throws(() => sharedViewLink('javascript:alert(1)', view()));
});
test('v2 shared views retain regex, family context and typed group collapse without changing v1', () => {
  const input = { ...view(), version: 2, relationshipMode: 'family', groupOrder: { order: 'natural', caseSensitive: true }, collapsedGroups: ['string:SOURCE1'],
    search: { definitionVersion: 2, search: '^Task_[0-9]+$', searchMode: 'regex', searchFlags: ['i'], searchMatchMode: 'full', searchDialect: 're2-common-v1', searchFields: ['/title'] },
    filters: { expression: { version: 2, root: { op: 'regex', field: '/title', pattern: 'Task' } } } };
  assert.deepEqual(structuredClone(decodeSharedView(encodeSharedView(input))), input);
  for (const change of [value => value.version = 1, value => value.relationshipMode = 'unknown', value => value.search.searchCaseSensitive = false,
    value => value.search.search = '(?=unsafe)', value => value.collapsedGroups.push('string:SOURCE1')]) {
    const invalid = structuredClone(input); change(invalid); assert.throws(() => validateSharedView(invalid));
  }
});
test('shared views reject unexpected settings, malformed encodings, invalid ranges and oversized links', () => {
  for (const change of [item => item.token = 'secret', item => item.filters.path = 'C:/data', item => item.range.toMs = '-1', item => item.range.fromMs = 'NaN', item => item.version = 2, item => item.settings.ratio = 100, item => item.selectedId = '<script>']) {
    const input = view(); change(input); assert.throws(() => validateSharedView(input));
  }
  for (const link of ['#view=%', '#view=', '#view=_w', `#view=${'a'.repeat(20000)}`, '#other=test']) assert.throws(() => decodeSharedView(link));
  const duplicate = JSON.stringify(view()).replace('"version":1', '"version":1,"version":1');
  assert.throws(() => decodeSharedView(`#view=${Buffer.from(duplicate).toString('base64url')}`));
});
test('documentation links resolve locally and reject unsafe external destinations', () => {
  const docs = { 'README.md': {}, 'docs/api.md': {} }, repo = 'https://github.com/arcazj/open_timeline2.0';
  assert.deepEqual(documentTarget('../README.md', 'docs/api.md', docs, repo), { document: 'README.md' });
  assert.deepEqual(documentTarget('docs/api.md', 'README.md', docs, repo), { document: 'docs/api.md' });
  for (const target of ['javascript:alert(1)', 'data:text/html,hello', 'file:///C:/data', 'https://token:secret@example.org']) assert.equal(documentTarget(target, 'README.md', docs, repo), null);
  assert.match(documentTarget('missing.md', 'README.md', docs, repo).url, /\/blob\/main\/missing.md$/);
});
test('offline Swagger forbids network access and execution, and escapes script terminators', () => {
  const html = swaggerDocument({ spec: { info: { title: '</script><script>alert(1)</script>' } }, swagger: { js: '/* </script> */', css: '/* </style> */' } });
  assert.match(html, /connect-src 'none'/); assert.match(html, /validatorUrl:null/); assert.match(html, /supportedSubmitMethods:\[\]/);
  assert.ok(!html.includes('</script><script>alert'));
});
test('live OpenAPI uses the current authenticated provider, with a bounded read-only request', async () => {
  const old = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ openapi: '3.1.0' })); };
  const provider = new ServerProvider({ baseUrl: 'https://example.org', token: 'test-secret', workspaceId: 'demo' });
  try {
    assert.equal((await provider.getOpenApi()).openapi, '3.1.0');
    assert.equal(request.url, 'https://example.org/api/v1/workspaces/demo/openapi.json');
    assert.equal(request.options.method, 'GET'); assert.equal(request.options.headers.Authorization, 'Bearer test-secret'); assert.equal(request.options.credentials, 'omit');
    const controller = new AbortController(); controller.abort();
    globalThis.fetch = async (url, options) => { options.signal.throwIfAborted(); };
    await assert.rejects(provider.getOpenApi({ signal: controller.signal }), { name: 'AbortError' });
  } finally { globalThis.fetch = old; provider.dispose(); }
});
