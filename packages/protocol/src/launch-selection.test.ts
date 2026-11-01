import { describe, expect, test } from "bun:test";
import {
  launchCatalogFromAgentModels,
  resolveLaunchEffort,
  resolveLaunchFastMode,
  resolveLaunchModel,
  resolveLaunchSelection,
  type LaunchCatalogEntry,
} from "./launch-selection.js";
import type { AgentModel } from "./native-agent.js";

const codex: LaunchCatalogEntry[] = [
  { id: "gpt-a", efforts: ["low", "high"], supportsSpeed: true },
  { id: "gpt-b", efforts: ["medium"] },
];

describe("resolveLaunchSelection", () => {
  test("keeps a saved model, effort and speed the catalogue offers", () => {
    expect(
      resolveLaunchSelection(
        "codex",
        { model: "gpt-a", reasoningEffort: "high", fastMode: true },
        codex,
      ),
    ).toEqual({ model: "gpt-a", reasoningEffort: "high", fastMode: true });
  });

  test("drops an effort and speed the selected row cannot honour", () => {
    expect(
      resolveLaunchSelection(
        "codex",
        { model: "gpt-b", reasoningEffort: "high", fastMode: true },
        codex,
      ),
    ).toEqual({ model: "gpt-b" });
  });

  test("falls back to the session-default row, then the first connected row", () => {
    expect(resolveLaunchModel("codex", codex, "retired")).toBe("gpt-a");
    expect(
      resolveLaunchModel("codex", [{ ...codex[0]!, connected: false }, codex[1]!], undefined),
    ).toBe("gpt-b");
    expect(
      resolveLaunchModel("codex", [codex[0]!, { ...codex[1]!, sessionDefault: true }], undefined),
    ).toBe("gpt-b");
  });

  test("keeps the saved choice when there is no catalogue to check it against", () => {
    expect(
      resolveLaunchSelection(
        "codex",
        { model: "gpt-z", reasoningEffort: "high", fastMode: false },
        undefined,
      ),
    ).toEqual({ model: "gpt-z", reasoningEffort: "high", fastMode: false });
    expect(resolveLaunchSelection("codex", {}, [])).toEqual({ model: "default" });
  });

  test("leaves the model to the provider when nothing is connected", () => {
    expect(
      resolveLaunchSelection(
        "codex",
        { model: "gpt-a", reasoningEffort: "high", fastMode: true },
        codex.map((row) => ({ ...row, connected: false })),
      ),
    ).toEqual({ model: "default" });
  });

  test("leaves an unmarked Pi catalogue to Pi's session default, keeping the effort", () => {
    const pi: LaunchCatalogEntry[] = [
      { id: "openai/gpt-4", efforts: ["low"] },
      { id: "openai/gpt-6", efforts: ["high"] },
    ];
    expect(resolveLaunchSelection("pi", { reasoningEffort: "high" }, pi)).toEqual({
      model: "default",
      reasoningEffort: "high",
    });
    // A marked row is where a Pi tab starts, so the launch starts there too.
    expect(
      resolveLaunchSelection("pi", { reasoningEffort: "low" }, [
        pi[0]!,
        { ...pi[1]!, sessionDefault: true },
      ]),
    ).toEqual({ model: "openai/gpt-6" });
  });

  test("never keeps a speed on a platform without a speed control", () => {
    expect(resolveLaunchSelection("pi", { model: "x", fastMode: true }, undefined)).toEqual({
      model: "x",
    });
  });
});

describe("per-model helpers", () => {
  test("check a picked model's effort against its own row", () => {
    expect(resolveLaunchEffort("codex", codex, "gpt-a", "low")).toBe("low");
    expect(resolveLaunchEffort("codex", codex, "gpt-b", "low")).toBeUndefined();
    expect(resolveLaunchEffort("codex", codex, "gpt-a", "default")).toBeUndefined();
  });

  test("drop the effort but keep the speed of a model the catalogue does not list", () => {
    expect(resolveLaunchEffort("codex", codex, "retired", "high")).toBeUndefined();
    expect(resolveLaunchFastMode("codex", codex, "retired", true)).toBe(true);
  });

  test("treat a launcher's own default row as a choice with no effort axis", () => {
    const placeholder: LaunchCatalogEntry[] = [{ id: "default", efforts: [] }];
    expect(resolveLaunchEffort("cursor", placeholder, "default", "high")).toBeUndefined();
  });
});

describe("launchCatalogFromAgentModels", () => {
  test("reads one platform's rows and reports no catalogue when it has none", () => {
    const models: AgentModel[] = [
      {
        platform: "codex",
        id: "gpt-a",
        label: "A",
        reasoning: [{ id: "high", label: "High" }],
        supportsSpeed: true,
      },
      { platform: "claude", id: "sonnet", label: "Sonnet", resolvedModel: "claude-sonnet" },
    ];
    expect(launchCatalogFromAgentModels("codex", models)).toEqual([
      { id: "gpt-a", efforts: ["high"], supportsSpeed: true },
    ]);
    expect(launchCatalogFromAgentModels("claude", models)).toEqual([
      { id: "sonnet", resolvedModel: "claude-sonnet", efforts: [] },
    ]);
    expect(launchCatalogFromAgentModels("pi", models)).toBeUndefined();
  });
});
