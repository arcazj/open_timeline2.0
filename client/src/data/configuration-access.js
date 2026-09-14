import { clone, ProviderError } from './data-provider.js';
import { CONFIGURATION_FAMILIES } from './configuration-catalog.js';

export function configurationReadable(resource, actor) {
  const has = name => actor.capabilities.includes('*') || actor.capabilities.includes(name);
  return has('configuration.manage') || (resource.visibility === 'personal' ? resource.ownerId === actor.id && has('configuration.personal') : has('configuration.read'));
}

export function configurationResource(snapshot, family, id, actor) {
  if (!CONFIGURATION_FAMILIES.includes(family)) throw new ProviderError('invalid_configuration', 'Unknown configuration family', 422);
  const resource = snapshot[family].find(item => item.id === id);
  if (!resource || !configurationReadable(resource, actor)) throw new ProviderError('configuration_not_found', 'Configuration resource is unavailable', 404);
  return resource;
}

export function configurationActions(resource, actor, family) {
  const has = name => actor.capabilities.includes('*') || actor.capabilities.includes(name);
  const canEdit = has('configuration.manage') || (resource.visibility === 'personal' && resource.ownerId === actor.id && has('configuration.personal'));
  const actions = ['duplicate'];
  if (canEdit) {
    actions.push('delete', resource.lifecycle === 'archived' ? 'unarchive' : 'archive');
    if (resource.lifecycle !== 'archived') {
      actions.push('update');
      if (resource.draft !== null && (resource.visibility === 'personal' || has('configuration.publish'))) actions.push('publish');
    }
  }
  if (['views', 'filters'].includes(family) && resource.lifecycle !== 'archived' && resource.versions.length && (has('configuration.personal') || has('configuration.manage'))) actions.push('apply');
  return actions;
}

export function configurationSummary(resource, actor, family) {
  const { draft, versions, ...metadata } = resource;
  return { ...clone(metadata), hasDraft: draft !== null, publishedVersions: versions.map(item => item.version), allowedActions: configurationActions(resource, actor, family) };
}

export function compareConfigurationNames(a, b) {
  const compare = (left, right) => {
    const x = [...left], y = [...right];
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i].codePointAt(0) - y[i].codePointAt(0);
    return x.length - y.length;
  };
  return compare(a.name, b.name) || compare(a.id, b.id);
}
