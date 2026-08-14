import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "./agent-platforms";
import {
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  MAX_OPENCODE_MODEL_PROVIDERS,
  isNativeAgentTabData,
  isSelectableOpenCodeModelId,
  isSelectableOpenCodeProvider,
  migrateOpenCodeModelProviders,
  normalizeOpenCodeModelProviders,
  openCodeModelProviderId,
  openCodeModelProvidersKey,
} from "./native-agent";

describe("opencode model provider allowlist", () => {
  test("defaults to the two managed catalogues", () => {
    expect([...DEFAULT_OPENCODE_MODEL_PROVIDERS]).toEqual([
      "opencode",
      "opencode-go",
    ]);
  });

  test("falls back to the default pair when nothing is stored", () => {
    for (const value of [undefined, null, "opencode", {}, 5]) {
      expect(normalizeOpenCodeModelProviders(value)).toEqual([
        "opencode",
        "opencode-go",
      ]);
    }
  });

  test("preserves an explicitly empty list as unrestricted", () => {
    expect(normalizeOpenCodeModelProviders([])).toEqual([]);
    expect(isSelectableOpenCodeProvider("hpc-ai", [])).toBe(true);
  });

  test("lowercases, trims, and dedupes stored ids", () => {
    expect(normalizeOpenCodeModelProviders([
      "  OpenCode ",
      "opencode",
      "OPENCODE-GO",
      "",
      42,
      "openrouter",
    ])).toEqual(["opencode", "opencode-go", "openrouter"]);
  });

  test("bounds the list so config cannot unbound a scan", () => {
    const providers = Array.from(
      { length: MAX_OPENCODE_MODEL_PROVIDERS + 20 },
      (_unused, index) => `provider-${index}`,
    );
    expect(normalizeOpenCodeModelProviders(providers)).toHaveLength(
      MAX_OPENCODE_MODEL_PROVIDERS,
    );
  });

  test("selects only the allowed providers", () => {
    const allowed = [...DEFAULT_OPENCODE_MODEL_PROVIDERS];
    expect(isSelectableOpenCodeProvider("opencode", allowed)).toBe(true);
    expect(isSelectableOpenCodeProvider("opencode-go", allowed)).toBe(true);
    expect(isSelectableOpenCodeProvider("hpc-ai", allowed)).toBe(false);
    expect(isSelectableOpenCodeProvider("openrouter", allowed)).toBe(false);
  });

  test("reads the provider from the first segment only", () => {
    // OpenCode model halves may themselves contain slashes.
    expect(openCodeModelProviderId("opencode/claude-sonnet-5")).toBe("opencode");
    expect(openCodeModelProviderId("opencode-go/openai/gpt-5")).toBe("opencode-go");
    expect(openCodeModelProviderId("no-separator")).toBe("");
    expect(openCodeModelProviderId("/leading")).toBe("");
  });

  test("selects model ids by their provider half", () => {
    const allowed = [...DEFAULT_OPENCODE_MODEL_PROVIDERS];
    expect(isSelectableOpenCodeModelId("opencode/claude-sonnet-5", allowed)).toBe(true);
    expect(isSelectableOpenCodeModelId("opencode-go/openai/gpt-5", allowed)).toBe(true);
    expect(isSelectableOpenCodeModelId("hpc-ai/kimi-k2.5", allowed)).toBe(false);
    // A bare model id names no provider and cannot be attributed to one.
    expect(isSelectableOpenCodeModelId("claude-sonnet-5", allowed)).toBe(false);
  });

  test("keys distinct allowlists distinctly", () => {
    expect(openCodeModelProvidersKey(["opencode", "opencode-go"]))
      .toBe(openCodeModelProvidersKey(["opencode", "opencode-go"]));
    expect(openCodeModelProvidersKey(["opencode"]))
      .not.toBe(openCodeModelProvidersKey(["opencode-go"]));
    // Nothing constrains a stored id's shape, so a separator-joined key would
    // serve one list's cached catalogue to the other.
    expect(openCodeModelProvidersKey(["a,b"]))
      .not.toBe(openCodeModelProvidersKey(["a", "b"]));
    // Order is part of the identity; re-filtering on a reorder is harmless.
    expect(openCodeModelProvidersKey(["a", "b"]))
      .not.toBe(openCodeModelProvidersKey(["b", "a"]));
  });
});

describe("opencode model provider migration", () => {
  test("returns the managed pair when no stored model names a provider", () => {
    expect(migrateOpenCodeModelProviders([
      "opencode/claude-sonnet-5",
      "claude-opus",
      "gpt-5.4",
      "default",
      undefined,
      null,
      42,
    ])).toEqual(["opencode", "opencode-go"]);
  });

  test("preserves providers a pre-existing install already selected from", () => {
    expect(migrateOpenCodeModelProviders([
      "openrouter/kimi-k2.5",
      "hpc-ai/deepseek",
      // A second model from an already-kept provider adds nothing.
      "openrouter/other",
      // Ids are matched lowercased, like a user-edited list.
      "  OpenRouter/Another  ",
    ])).toEqual(["opencode", "opencode-go", "openrouter", "hpc-ai"]);
  });

  test("bounds the migrated list by the same cap as a user-edited one", () => {
    const stored = Array.from(
      { length: MAX_OPENCODE_MODEL_PROVIDERS + 20 },
      (_unused, index) => `provider-${index}/model`,
    );
    expect(migrateOpenCodeModelProviders(stored)).toHaveLength(
      MAX_OPENCODE_MODEL_PROVIDERS,
    );
  });

  test("returns the managed pair for an install with nothing stored", () => {
    expect(migrateOpenCodeModelProviders([])).toEqual([
      "opencode",
      "opencode-go",
    ]);
  });
});

describe("native agent protocol", () => {
  test("accepts every provider through one tab-data contract", () => {
    for (const platform of AGENT_PLATFORMS) {
      expect(isNativeAgentTabData({
        platform,
        environmentId: "environment-1",
        sessionId: "session-1",
        hostPort: 4123,
        isLocal: true,
      })).toBe(true);
    }
  });

  test("rejects malformed persisted identities", () => {
    expect(isNativeAgentTabData({ platform: "other", environmentId: "env" })).toBe(false);
    expect(isNativeAgentTabData({ platform: "codex", environmentId: "" })).toBe(false);
    expect(isNativeAgentTabData({ platform: "codex", environmentId: "env", hostPort: 0 })).toBe(false);
  });

  test("rejects values that are not identity records at all", () => {
    for (const value of [undefined, null, "codex", 7, true, [], [{ platform: "codex" }]]) {
      expect(isNativeAgentTabData(value)).toBe(false);
    }
    expect(isNativeAgentTabData({ environmentId: "env" })).toBe(true);
    expect(isNativeAgentTabData({ platform: "codex" })).toBe(false);
  });

  test("rejects a host port that is not a usable TCP port", () => {
    const base = { platform: "codex", environmentId: "env" };
    for (const hostPort of [-1, 0, 1.5, NaN, Infinity, "4123", null, 2 ** 53]) {
      expect(isNativeAgentTabData({ ...base, hostPort })).toBe(false);
    }
    expect(isNativeAgentTabData({ ...base, hostPort: 1 })).toBe(true);
    expect(isNativeAgentTabData({ ...base, hostPort: 65535 })).toBe(true);
  });

  test("rejects optional fields of the wrong type", () => {
    const base = { platform: "codex", environmentId: "env" };
    expect(isNativeAgentTabData({ ...base, containerId: 1 })).toBe(false);
    expect(isNativeAgentTabData({ ...base, sessionId: {} })).toBe(false);
    expect(isNativeAgentTabData({ ...base, isLocal: "true" })).toBe(false);
  });

  test("accepts an identity whose optional fields are explicitly absent", () => {
    expect(isNativeAgentTabData({
      platform: "claude",
      environmentId: "env",
      containerId: undefined,
      hostPort: undefined,
      sessionId: undefined,
      isLocal: undefined,
    })).toBe(true);
  });
});
