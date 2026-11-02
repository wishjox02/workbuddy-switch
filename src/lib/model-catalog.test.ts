import { describe, expect, it } from "vitest";

import { mergeModelCatalog, type ModelDefinition } from "./model-catalog";

function model(id: string, overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return { id, name: id, provider: "Sub2API", description: "remote", context: "chat", ...overrides };
}

describe("mergeModelCatalog", () => {
  it("keeps models installed only on the local machine", () => {
    const result = mergeModelCatalog([model("remote")], [model("local", { provider: "my", managed: false })]);

    expect(result.map((item) => item.id)).toEqual(["remote", "local"]);
    expect(result[1]).toMatchObject({ localInstalled: true, remoteAvailable: false, managed: false });
  });

  it("uses local installation state and metadata for a shared model ID", () => {
    const result = mergeModelCatalog([model("shared", { name: "Remote name" })], [model("shared", { name: "Local name", managed: true, disabled: true })]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "Local name", localInstalled: true, remoteAvailable: true, managed: true, disabled: true });
  });

  it("keeps third-party and managed providers with the same model ID separate", () => {
    const result = mergeModelCatalog(
      [model("shared")],
      [model("shared", { provider: "my", managed: false }), model("shared", { provider: "wb-switch", managed: true })],
      true,
    );

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.provider)).toEqual(["wb-switch", "my"]);
  });
});
