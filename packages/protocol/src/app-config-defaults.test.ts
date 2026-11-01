import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_MESSAGING_SETTINGS } from "./agent-mail.js";
import { createDefaultAppConfig, DEFAULT_ENV_FILE_PATTERNS } from "./app-config-defaults.js";
import {
  CODEX_FALLBACK_MODEL_CATALOG,
  DEFAULT_CODEX_MODEL_ID,
  DEFAULT_CODEX_REASONING_EFFORT,
} from "./codex-model-catalog.js";
import { DEFAULT_OPENCODE_MODEL_PROVIDERS } from "./native-agent.js";

describe("createDefaultAppConfig", () => {
  test("returns a fresh, independently mutable config on every call", () => {
    const first = createDefaultAppConfig();
    const second = createDefaultAppConfig();
    expect(first).toEqual(second);
    first.global.envFilePatterns.push(".env.extra");
    first.global.allowedDomains.push("example.invalid");
    first.global.agentMessaging.wakePeers = true;
    first.global.agentSettings.platforms.codex.model = "changed";
    expect(second.global.envFilePatterns).toEqual([...DEFAULT_ENV_FILE_PATTERNS]);
    expect(second.global.allowedDomains).not.toContain("example.invalid");
    expect(createDefaultAppConfig().global.agentMessaging.wakePeers).toBe(false);
    expect(createDefaultAppConfig().global.agentSettings.platforms.codex.model).toBe(
      DEFAULT_CODEX_MODEL_ID,
    );
  });

  test("uses the shared section defaults rather than copies", () => {
    const { global, version, schemaVersion } = createDefaultAppConfig();
    expect(schemaVersion).toBe(2);
    expect(version).toBe("1.0.0");
    expect(global.envFilePatterns).toEqual([".env", ".env.local"]);
    expect(global.agentMessaging).toEqual({ ...DEFAULT_AGENT_MESSAGING_SETTINGS });
    expect(global.openCodeModelProviders).toEqual([...DEFAULT_OPENCODE_MODEL_PROVIDERS]);
    expect(global.debugLogging).toBe(false);
    expect(global.agentSettings.platforms.codex).toEqual({
      mode: "native",
      model: DEFAULT_CODEX_MODEL_ID,
      reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    });
  });
});

describe("CODEX_FALLBACK_MODEL_CATALOG", () => {
  test("offers the stored default model with its default effort", () => {
    const model = CODEX_FALLBACK_MODEL_CATALOG.find(({ id }) => id === DEFAULT_CODEX_MODEL_ID);
    expect(model).toBeDefined();
    expect(model?.reasoningEfforts).toContain(DEFAULT_CODEX_REASONING_EFFORT);
  });

  test("has unique ids and a supported default effort per model", () => {
    const ids = CODEX_FALLBACK_MODEL_CATALOG.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of CODEX_FALLBACK_MODEL_CATALOG) {
      expect(model.reasoningEfforts).toContain(model.defaultReasoningEffort);
    }
  });
});
