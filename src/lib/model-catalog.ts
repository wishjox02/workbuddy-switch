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

export function isOurModel(model: ModelDefinition): boolean {
  return model.managed === true || (model.remoteAvailable === true && !model.localInstalled);
}

export function groupModelCatalog(models: ModelDefinition[]): Array<[string, ModelDefinition[]]> {
  const groups = new Map<string, ModelDefinition[]>();
  for (const model of models) {
    const group = isOurModel(model) ? "我们的模型" : model.provider.toLowerCase() === "openai" ? "OPENAI" : model.provider;
    groups.set(group, [...(groups.get(group) ?? []), model]);
  }
  return [...groups.entries()].sort(([left], [right]) =>
    left === "我们的模型" ? (right === left ? 0 : -1) : right === "我们的模型" ? 1 : left.localeCompare(right),
  );
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
