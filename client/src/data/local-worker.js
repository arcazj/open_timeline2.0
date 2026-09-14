import { LocalProvider } from './local-provider.js';

const METHODS = new Set(['getStatus', 'createQuery', 'getQuery', 'getDensity', 'getMap', 'getZones', 'getOverview', 'createLayout', 'getLayout', 'getRows', 'getPlacement', 'getRecord', 'queryRecords', 'executeCommand', 'executeBatch', 'getCommandOutcome', 'listModels', 'getModel', 'validateModel', 'executeModelCommand', 'exportSnapshot', 'releaseQuery', 'releaseLayout', 'listConfiguration', 'getConfiguration', 'validateConfiguration', 'configurationUsage', 'mutateConfiguration', 'getEffectiveSettings', 'mutateSettings', 'previewSchemaImpact']);
const active = new Map();
let provider;

const metadata = () => provider ? { identity: provider.identity, generation: provider.generation, revision: provider.revision, modified: provider.modified } : null;
const errorData = error => ({ name: error.name, code: error.code, message: error.message, status: error.status, errors: error.errors });

self.addEventListener('message', async ({ data }) => {
  if (data?.type === 'cancel') { active.get(data.id)?.abort(); return; }
  if (data?.type !== 'request' || typeof data.id !== 'string') return;
  const { id, method, args = [], options = {} } = data;
  const controller = new AbortController();
  active.set(id, controller);
  try {
    let result;
    if (method === 'initialize') {
      if (provider) throw new Error('Worker source is already initialized');
      provider = new LocalProvider(args[0]);
      provider.subscribeChanges(event => self.postMessage({ type: 'change', event, metadata: metadata() }));
      result = await provider.initialize({ signal: controller.signal });
    } else {
      if (!METHODS.has(method) || !provider) throw new Error('Unsupported worker request');
      result = await provider[method](...args, { ...options, signal: controller.signal });
    }
    self.postMessage({ type: 'response', id, result, metadata: metadata() });
  } catch (error) {
    self.postMessage({ type: 'response', id, error: errorData(error), metadata: metadata() });
  } finally { active.delete(id); }
});

self.postMessage({ type: 'ready' });
