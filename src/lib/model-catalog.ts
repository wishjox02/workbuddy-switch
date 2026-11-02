export interface ModelDefinition {
  id: string;
  name: string;
  provider: string;
  description: string;
  context: string;
  managed?: boolean;
  disabled?: boolean;
  localInstalled?: boolean;
  remoteAvailable?: boolean;
}

export function mergeModelCatalog(remote: ModelDefinition[], local: ModelDefinition[], preserveProviders = false): ModelDefinition[] {
  const result: ModelDefinition[] = remote.map((model) => ({ ...model, remoteAvailable: true }));
  for (const model of local) {
    const index = result.findIndex((item) => item.id === model.id && (!preserveProviders || model.managed));
    const entry = { ...model, localInstalled: true, remoteAvailable: remote.some((item) => item.id === model.id) };
    if (index >= 0) result[index] = entry;
    else result.push(entry);
  }
  return result;
}
