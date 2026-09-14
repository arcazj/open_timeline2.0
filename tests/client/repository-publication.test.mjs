import test from 'node:test';
import assert from 'node:assert/strict';
import { pathProblems, hasCredential, documentationProblems } from '../../scripts/check-repository.mjs';

test('publication excludes runtime identities, exports, private profiles and installed tools', () => {
  for (const file of ['var/hazards/control/identities.json', '.env.production', 'runtime/secret.json', 'output/source-export.json',
    'node_modules/three/package.json', 'tmp/tool/python.exe', '.idea/workspace.xml', 'yaml/local/private.yml']) {
    assert.ok(pathProblems([file]).length, file);
  }
  assert.deepEqual(pathProblems(['data/default-dataset.json', 'tests/fixtures/synthetic.json', '.env.example',
    'output/pdf/local-test-data.pdf', '.run/Timeline.run.xml']), []);
});

test('publication detects path case collisions and common credentials without returning their values', () => {
  assert.ok(pathProblems(['README.md', 'readme.md']).length);
  assert.ok(hasCredential('ghp_' + 'x'.repeat(36)));
  assert.ok(hasCredential('-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'));
  assert.equal(hasCredential('OPENBEXI_API_TOKEN = generate_a_private_token()'), false);
});

test('documentation links and images must be present in the selected publication file set', () => {
  const files = new Set(['README.md', 'docs/publishing.md', 'docs/ui/screen.png']);
  assert.deepEqual(documentationProblems('README.md', '[Guide](docs/publishing.md) ![App](docs/ui/screen.png) [Demo](https://example.org/) [Start](#start)', files), []);
  assert.deepEqual(documentationProblems('docs/publishing.md', '[Readme](../README.md)', files), []);
  assert.equal(documentationProblems('README.md', '[Missing](dist/index.html) ![Missing](docs/ui/absent.png)', files).length, 2);
  assert.equal(documentationProblems('README.md', '[Local](file:///C:/private/report.txt)', files).length, 1);
});
