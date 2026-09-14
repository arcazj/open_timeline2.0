import { normalizeConfiguration, applyConfigurationCommand, effectiveSettings, validateResourceDefinition, configurationUsage, filterFieldTypes, resolvedDataSchema } from '../../../client/src/data/configuration-catalog.js';
import { sha256 } from '../../../client/src/data/data-provider.js';
import { applySettingsCommand } from '../../../client/src/data/settings-commands.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const results = [];
for (const item of request.requests) {
  try {
    let result;
    if (item.method === 'normalize') result = normalizeConfiguration(item.snapshot, item.actor);
    else if (item.method === 'apply') result = applyConfigurationCommand(item.snapshot, item.command, { actor: item.actor, now: item.now, createId: () => item.createId });
    else if (item.method === 'settings') result = applySettingsCommand(item.snapshot, item.command, item.actor);
    else if (item.method === 'effective') result = effectiveSettings(item.snapshot, item.options);
    else if (item.method === 'validate') result = { valid: validateResourceDefinition(item.family, item.definition, item.context).valid };
    else if (item.method === 'usage') result = configurationUsage(item.snapshot, item.family, item.id, item.version);
    else if (item.method === 'fields') result = filterFieldTypes(item.snapshot, item.schemaRefs);
    else if (item.method === 'schema') result = resolvedDataSchema(item.definition);
    else if (item.method === 'hash') result = await sha256(item.value);
    else throw new Error('Unknown fixture method');
    results.push({ result });
  } catch (error) { results.push({ error: { code: error.code, status: error.status } }); }
}
process.stdout.write(JSON.stringify(results));
