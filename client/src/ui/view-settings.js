import { applySettingsCommand } from '../data/settings-commands.js';
import { snapshotContent } from '../data/snapshot-content.js';
import { sha256 } from '../data/data-provider.js';

export function resetTransientSettings(transient, keys) {
  const next = structuredClone(transient);
  for (const key of keys) delete next[key];
  return next;
}

export async function exportWithPersonalPreferences(snapshot, transient, actor) {
  let result = structuredClone(snapshot);
  if (Object.keys(transient).length) {
    const expectedRevision = result.preferences?.find(item => item.principalId === actor.id)?.revision ?? 0;
    result = applySettingsCommand(result, { scope: 'personal', type: 'patch', expectedRevision, generation: result.manifest.generation,
      clientCommandId: crypto.randomUUID(), payload: structuredClone(transient) }, actor).snapshot;
  }
  result.manifest.contentSha256 = await sha256(snapshotContent(result));
  return result;
}
