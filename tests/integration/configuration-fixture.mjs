export async function configurationCommand(provider, family, type, resource, payload = {}, extra = {}) {
  const status = await provider.getStatus();
  return provider.mutateConfiguration({ family, type, generation: status.generation, clientCommandId: crypto.randomUUID(),
    ...(resource ? { resourceId: resource.id, expectedRevision: resource.revision } : {}), payload, ...extra });
}

export async function publishConfiguration(provider, family, name, definition, visibility = 'workspace') {
  let result = await configurationCommand(provider, family, 'create', null, { name, visibility, definition });
  if (!result.resource.versions.length) result = await configurationCommand(provider, family, 'publish', result.resource);
  return result.resource;
}

export async function publishSchema(provider, name, properties, extra = {}) {
  return publishConfiguration(provider, 'schemas', name, {
    schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties, additionalProperties: false, ...extra },
  });
}

export function schemaPin(resource, version = resource.versions.at(-1).version) {
  return { schemaId: resource.id, schemaVersion: version };
}
