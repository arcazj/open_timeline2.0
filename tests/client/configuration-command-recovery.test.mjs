import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigurationCommandRecovery, CONFIGURATION_RECOVERY_KEY } from '../../client/src/data/configuration-command-recovery.js';

function environment(protocol = 'http:') {
  const values = new Map();
  return { location: { protocol }, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } };
}
const provider = () => ({ baseUrl: `http://127.0.0.1/${crypto.randomUUID()}/`, workspaceId: 'default', token: 'SECRET' });
const command = (generation, family = 'filters') => ({ generation, family, type: family === 'settings' ? 'reset' : 'create', clientCommandId: crypto.randomUUID(), ...(family === 'settings' ? { scope: 'personal' } : {}), payload: { name: 'PRIVATE TITLE', definition: { private: 'DATA' }, paths: ['/private'] } });

test('configuration recovery stores only source, principal and command identity and restores until confirmed', () => {
  const origin = provider(), env = environment(), generation = crypto.randomUUID(), original = command(generation);
  const config = { provider: origin, generation, principalId: 'alice', local: false, environment: env };
  createConfigurationCommandRecovery(config).remember(original);
  const serialized = env.localStorage.getItem(CONFIGURATION_RECOVERY_KEY), [stored] = JSON.parse(serialized);
  assert.deepEqual(Object.keys(stored).sort(), ['baseUrl', 'workspaceId', 'generation', 'principalId', 'clientCommandId', 'family', 'type'].sort());
  assert(!/SECRET|PRIVATE|DATA|payload|definition/.test(serialized));
  const restored = createConfigurationCommandRecovery(config);
  assert.equal(restored.read()[0].clientCommandId, original.clientCommandId);
  restored.clear(original.clientCommandId);
  assert.deepEqual(createConfigurationCommandRecovery(config).read(), []);
  assert.equal(env.localStorage.getItem(CONFIGURATION_RECOVERY_KEY), null);
});

test('private recovery locks do not cross principal, source or generation boundaries', () => {
  const origin = provider(), env = environment(), generation = crypto.randomUUID();
  const config = { provider: origin, generation, principalId: 'alice', local: false, environment: env };
  createConfigurationCommandRecovery(config).remember(command(generation));
  for (const change of [{ principalId: 'bob' }, { generation: crypto.randomUUID() }, { provider: provider() }]) assert.deepEqual(createConfigurationCommandRecovery({ ...config, ...change }).read(), []);
  assert.equal(createConfigurationCommandRecovery(config).read().length, 1);
});

test('settings recovery retains only scope, not preference values or paths', () => {
  const origin = provider(), env = environment(), generation = crypto.randomUUID(), original = command(generation, 'settings');
  const store = createConfigurationCommandRecovery({ provider: origin, generation, principalId: 'alice', local: false, environment: env });
  store.remember(original);
  assert.equal(store.read()[0].scope, 'personal');
  assert(!env.localStorage.getItem(CONFIGURATION_RECOVERY_KEY).includes('/private'));
  assert.throws(() => store.remember({ ...original, scope: undefined }), /safe configuration command identity/);
});

test('storage denial and file URLs truthfully warn while memory recovery remains usable', () => {
  const origin = provider(), generation = crypto.randomUUID(), original = command(generation);
  const denied = { location: { protocol: 'http:' }, get localStorage() { throw new Error('denied'); } };
  const config = { provider: origin, generation, principalId: 'alice', local: false, environment: denied };
  const store = createConfigurationCommandRecovery(config); store.remember(original);
  assert.match(store.warning(), /memory-only/); assert.equal(store.read().length, 1);
  const file = createConfigurationCommandRecovery({ ...config, provider: provider(), environment: environment('file:') });
  assert.match(file.warning(), /file URLs.*browser-dependent/);
});

test('malformed stored identities are not trusted or exposed as private recovery state', () => {
  const env = environment(), origin = provider(), generation = crypto.randomUUID();
  env.localStorage.setItem(CONFIGURATION_RECOVERY_KEY, JSON.stringify([{ baseUrl: origin.baseUrl, workspaceId: 'default', generation, principalId: 'alice', clientCommandId: 'x', family: 'filters', type: 'create', token: 'SECRET' }]));
  const store = createConfigurationCommandRecovery({ provider: origin, generation, principalId: 'alice', local: false, environment: env });
  assert.deepEqual(store.read(), []); assert.match(store.warning(), /unavailable/);
});
