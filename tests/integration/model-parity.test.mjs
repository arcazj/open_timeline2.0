import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { sha256 } from '../../client/src/data/data-provider.js';
import { snapshotContent } from '../../client/src/data/snapshot-content.js';
import { startServer } from './server-fixture.mjs';

let server, local, remote;
const definition = { theme: 'light', rowHeight: 40, fontSize: 13, groupBy: 'sourceId', displayUnit: 'MINUTE', timeZone: 'America/New_York', scaleMode: 'adaptive', ratio: 3, bins: 64 };
before(async () => {
  server = await startServer();
  local = new LocalProvider(JSON.parse(await readFile('data/default-dataset.json', 'utf8')));
  remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token });
  await local.initialize(); await remote.initialize();
});
after(async () => { local?.dispose(); remote?.dispose(); await server?.stop(); });

async function command(provider, type, model, payload = {}, id = crypto.randomUUID()) {
  const status = await provider.getStatus();
  return provider.executeModelCommand({ type, modelId: model?.id, expectedRevision: model?.revision, payload, generation: status.generation, clientCommandId: id });
}

test('Local and real Python agree on draft publication, pinned application, history and references', async () => {
  const histories = [];
  for (const provider of [local, remote]) {
    const initial = await provider.listModels();
    assert.equal(initial.items.length, 3);
    assert.equal(initial.active.version, 1);
    assert.deepEqual((await provider.validateModel(definition)).errors, []);
    assert.equal((await provider.validateModel({ ...definition, timeZone: '+03:00' })).valid, false);
    assert.equal((await provider.validateModel({ ...definition, rowHeight: 32, fontSize: 24 })).valid, false);
    assert.equal((await provider.validateModel({ ...definition, descriptor: 'alert(1)' })).valid, false);
    const key = crypto.randomUUID();
    let result = await command(provider, 'create', null, { name: 'Catalog parity', description: 'Integration fixture', tags: ['test'], definition }, key);
    let model = result.model;
    assert.equal(model.versions.length, 0); assert.deepEqual(model.draft, definition);
    assert.equal((await command(provider, 'create', null, { name: 'Catalog parity', description: 'Integration fixture', tags: ['test'], definition }, key)).model.id, model.id);
    assert.equal((await provider.getCommandOutcome(key)).state, 'committed');
    const stale = structuredClone(model);
    model = (await command(provider, 'publish', model)).model;
    assert.equal(model.draft, null); assert.deepEqual(model.versions[0].definition, definition);
    assert.deepEqual((await provider.listModels()).active, initial.active);
    await assert.rejects(command(provider, 'update', stale, { name: 'Stale replacement' }), error => error.status === 412);
    result = await command(provider, 'apply', model, { version: 1 });
    assert.equal(result.settings.modelId, model.id); assert.equal(result.settings.modelVersion, 1);
    const originalRange = structuredClone(result.settings.range);
    const firstVersion = structuredClone(model.versions[0]);
    model = (await command(provider, 'update', model, { draft: { ...definition, theme: 'classic', displayUnit: 'DAY' } })).model;
    model = (await command(provider, 'publish', model)).model;
    assert.equal(model.versions.length, 2); assert.deepEqual(model.versions[0], firstVersion);
    assert.equal((await provider.listModels()).active.version, 1);
    result = await command(provider, 'apply', model, { version: 2 });
    assert.deepEqual(result.settings.range, originalRange); assert.equal(result.settings.theme, 'classic');
    await assert.rejects(command(provider, 'delete', model), error => error.status === 409);
    model = (await command(provider, 'archive', model)).model;
    assert.equal((await provider.getModel(model.id)).usage.length, 1);
    await assert.rejects(command(provider, 'apply', model, { version: 1 }), error => error.status === 409);
    model = (await command(provider, 'unarchive', model)).model;
    model = (await command(provider, 'update', model, { draft: firstVersion.definition })).model;
    model = (await command(provider, 'publish', model)).model;
    assert.equal(model.versions.length, 3);
    assert.deepEqual(model.versions[2].definition, model.versions[0].definition);
    const exported = await provider.exportSnapshot();
    const imported = new LocalProvider(exported);
    await imported.initialize();
    assert.deepEqual((await imported.getModel(model.id)).model.versions, model.versions);
    assert.equal((await imported.listModels()).active.version, 2);
    imported.dispose();
    histories.push(model.versions.map(version => version.definition));
  }
  assert.deepEqual(histories[0], histories[1]);
});

test('Python export checksum is verified by JavaScript and model history persists across restart', async () => {
  const exported = await remote.exportSnapshot();
  const payload = snapshotContent(exported);
  assert.equal(exported.manifest.contentSha256, await sha256(payload));
  const before = await remote.listModels();
  await server.restart();
  await remote.initialize();
  assert.deepEqual((await remote.listModels()).items, before.items);
  assert.deepEqual((await remote.listModels()).active, before.active);
  const tampered = structuredClone(exported);
  tampered.models[0].name += ' tampered';
  await assert.rejects(new LocalProvider(tampered).initialize(), /integrity|checksum/i);
});

test('model catalog is authenticated, read-only validation does not create records, and missing preconditions fail', async () => {
  const url = `${server.baseUrl}/api/v1/workspaces/default/models`;
  assert.equal((await fetch(url)).status, 401);
  const before = await remote.listModels();
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unauthorized mutation shape', definition }) });
  assert.equal(response.status, 428);
  await remote.validateModel(definition);
  assert.deepEqual(await remote.listModels(), before);
});

test('canonical snapshot integrity agrees for numeric keys, Unicode ordering and fractional numbers', async () => {
  await remote.executeCommand({ type: 'create', generation: (await remote.getStatus()).generation, clientCommandId: crypto.randomUUID(), payload: {
    title: 'Canonical integrity fixture', start: '2026-09-12T10:00:00.000Z', end: null, kind: 'event', sourceId: 'operations',
    extensions: { '2': -0, '10': 0.1, '\u{1f680}': 1e-7, '\ufb33': 0.000001, fractions: [0.3333333333333333, -0.00002, 4.5] },
  } });
  const exported = await remote.exportSnapshot();
  const expected = await sha256(snapshotContent(exported));
  assert.equal(exported.manifest.contentSha256, expected);
  const imported = new LocalProvider(exported);
  await imported.initialize();
  assert.equal((await imported.getStatus()).recordCount, 49);
  imported.dispose();
});
