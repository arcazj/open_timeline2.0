import { createIcons, icons } from 'lucide';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { openConfigurationManager } from '../../client/src/ui/configuration-manager.js';
import initial from '../../shared/fixtures/initial-snapshot.json';
import '../../client/src/styles/app.css';

const provider = new LocalProvider(initial);
const info = await provider.initialize();
let manager, active = true, loseNext = false, validationGate, mutationGate, applied = [], commands = [], lookups = [], confirmed = [];
const mutate = provider.mutateConfiguration.bind(provider), validate = provider.validateConfiguration.bind(provider), outcome = provider.getCommandOutcome.bind(provider);
provider.mutateConfiguration = async command => {
  commands.push(structuredClone(command));
  const result = await mutate(command);
  if (mutationGate) await mutationGate.promise;
  if (loseNext) { loseNext = false; throw Object.assign(new Error('Simulated lost response after Local commit'), { code: 'write_outcome_unknown' }); }
  return result;
};
provider.validateConfiguration = async (...args) => { if (validationGate) await validationGate.promise; return validate(...args); };
provider.getCommandOutcome = async id => { lookups.push(id); return outcome(id); };
function open() {
  if (manager?.isOpen()) return;
  manager = openConfigurationManager({ provider, generation: info.generation, actor: info.actor, local: true, sourceName: 'Configuration test fixture', models: info.models, settings: info.settings,
    updateIcons: () => createIcons({ icons }), isCurrent: (origin, generation, principalId) => active && origin === provider && generation === info.generation && principalId === info.actor.id,
    onClose: () => { manager = null; }, onMutation: result => { confirmed.push(result.commandId); }, onApply: (settings, keys) => { applied.push({ settings: structuredClone(settings), keys: structuredClone(keys) }); }, onAuthorizationError: error => { throw error; } });
}
window.configurationHarness = {
  open, state: () => ({ snapshot: structuredClone(provider.snapshot), commands: structuredClone(commands), lookups: [...lookups], applied: structuredClone(applied), confirmed: [...confirmed] }),
  loseNext: () => { loseNext = true; },
  gateValidation: () => { let release; const promise = new Promise(resolve => { release = resolve; }); validationGate = { promise, release }; },
  releaseValidation: () => { validationGate?.release(); validationGate = null; },
  gateMutation: () => { let release; const promise = new Promise(resolve => { release = resolve; }); mutationGate = { promise, release }; },
  releaseMutation: () => { mutationGate?.release(); mutationGate = null; },
  suspend: () => { active = false; manager.suspend(); },
};
open();
