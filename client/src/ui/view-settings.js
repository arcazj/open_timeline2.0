import { applySettingsCommand } from '../data/settings-commands.js';
import { snapshotContent } from '../data/snapshot-content.js';
import { sha256, ProviderError } from '../data/data-provider.js';

export function resetTransientSettings(transient, keys) {
  const next = structuredClone(transient);
  for (const key of keys) delete next[key];
  return next;
}

export async function exportWithPersonalPreferences(snapshot, transient, actor) {
  let result = structuredClone(snapshot);
  if (typeof actor.id !== 'string' || !actor.id.trim() || [...actor.id].length > 128) throw new ProviderError('invalid_snapshot', 'Local preference principal must be a bounded nonempty string', 422);
  result.manifest.localPreferencesPrincipalId = actor.id;
  if (Object.keys(transient).length) {
    if (result.manifest.legacy?.readOnly && !result.manifest.legacy.preferencesEnabled) throw new ProviderError('legacy_read_only', 'This legacy snapshot does not enable separate local preferences.', 403);
    const expectedRevision = result.preferences?.find(item => item.principalId === actor.id)?.revision ?? 0;
    result = applySettingsCommand(result, { scope: 'personal', type: 'patch', expectedRevision, generation: result.manifest.generation,
      clientCommandId: crypto.randomUUID(), payload: structuredClone(transient) }, actor).snapshot;
    if (result.manifest.legacy?.preferencesEnabled) {
      const revision = (result.manifest.preferencesRevision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new ProviderError('revision_capacity', 'Preferences revision capacity reached', 413);
      result.manifest.preferencesRevision = revision;
      result.manifest.legacy = { ...result.manifest.legacy, preferencesSource: 'local-export', preferencesRevision: revision,
        ...(snapshot.manifest.legacy.preferencesSource === 'application-json' ? { serverPreferencesRevision: snapshot.manifest.legacy.preferencesRevision ?? 0 } : {}) };
    }
  }
  result.manifest.contentSha256 = await sha256(snapshotContent(result));
  return result;
}
