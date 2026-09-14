import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { collectThirdPartyNotices, assertNoticesCoverInputs, embeddedJson } from '../../scripts/third-party-notices.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('standalone notices include locked runtime dependencies, transitive licenses, fonts and Unicode', async () => {
  const first = await collectThirdPartyNotices(root), second = await collectThirdPartyNotices(root);
  assert.deepEqual(first, second);
  assert.ok(first.document.packages.some(item => item.name === 'three'));
  assert.ok(first.document.packages.some(item => item.name === 'jsbi'));
  assert.ok(!first.document.packages.some(item => item.name === '@playwright/test'));
  assert.ok(first.document.assets.some(item => item.license === 'OFL-1.1'));
  assert.ok(first.document.assets.some(item => item.license === 'Unicode-3.0'));
  const project = first.document.assets.find(item => item.license === 'GPL-3.0-only');
  assert.equal(project.notices[0].path, 'LICENSE');
  assert.match(project.notices[0].text, /GNU GENERAL PUBLIC LICENSE/);
  assert.ok(first.document.assets.some(item => item.license === 'GPL-3.0-or-later'));
  for (const item of [...first.document.packages, ...first.document.assets]) for (const notice of item.notices) {
    assert.match(notice.sha256, /^[a-f0-9]{64}$/);
    assert.ok(notice.text.trim().length > 0);
    if (!/\/NOTICE(?:[._-].*)?$/i.test(notice.path)) assert.ok(notice.text.length > 100);
  }
  assertNoticesCoverInputs(first.document, ['node_modules/three/src/Three.js', 'client/src/app.js']);
  assert.throws(() => assertNoticesCoverInputs(first.document, ['node_modules/unreviewed/index.js']), /no license notice/);
  assert.throws(() => assertNoticesCoverInputs(first.document, ['node_modules/three/node_modules/unreviewed/index.js']), /no license notice/);
});

test('license content cannot terminate its inert HTML JSON element', () => {
  const value = { text: '</script><script>unexpected()</script>\u2028\u2029' };
  const encoded = embeddedJson(value);
  assert.ok(!encoded.includes('<')); assert.deepEqual(JSON.parse(encoded), value);
});
