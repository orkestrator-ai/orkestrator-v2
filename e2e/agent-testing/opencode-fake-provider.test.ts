import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  mergeOpenCodeFakeProvider,
  openCodeModelRef,
  profileOpenCodeConfigFile,
} from "./opencode-fake-provider";

const fake = {
  provider: "fixture-fake",
  providerName: "Fixture fake",
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "fixture-1",
  modelName: "Fixture 1",
};

describe("OpenCode fake provider", () => {
  test("the profile's global file is under its isolated XDG_CONFIG_HOME", () => {
    expect(profileOpenCodeConfigFile("/profile")).toBe(
      path.join("/profile", "agent-credentials", "xdg-config", "opencode", "opencode.json"),
    );
    expect(openCodeModelRef(fake)).toBe("fixture-fake/fixture-1");
  });

  test("an absent file gets the provider, the default and small model, and only that provider", () => {
    expect(JSON.parse(mergeOpenCodeFakeProvider(undefined, fake))).toEqual({
      provider: {
        "fixture-fake": {
          npm: "@ai-sdk/openai-compatible",
          name: "Fixture fake",
          options: { baseURL: "http://127.0.0.1:1234/v1", apiKey: "fixture-only-not-a-key" },
          models: {
            "fixture-1": {
              name: "Fixture 1",
              tool_call: true,
              limit: { context: 64_000, output: 2_000 },
            },
          },
        },
      },
      model: "fixture-fake/fixture-1",
      small_model: "fixture-fake/fixture-1",
      enabled_providers: ["fixture-fake"],
    });
  });

  test("every existing key is kept and an earlier copy of the provider is replaced", () => {
    const existing = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { kept: { type: "local", command: ["true"] } },
      provider: { other: { npm: "x" }, "fixture-fake": { stale: true } },
      model: "opencode/hosted",
    });
    const merged = JSON.parse(mergeOpenCodeFakeProvider(existing, fake));
    expect(merged.$schema).toBe("https://opencode.ai/config.json");
    expect(merged.mcp).toEqual({ kept: { type: "local", command: ["true"] } });
    expect(merged.provider.other).toEqual({ npm: "x" });
    expect(merged.provider["fixture-fake"].stale).toBeUndefined();
    expect(merged.model).toBe("fixture-fake/fixture-1");
  });

  test("JSONC and non-object files are refused rather than rewritten", () => {
    expect(() => mergeOpenCodeFakeProvider('{ // comment\n "mcp": {} }', fake)).toThrow(
      "not plain JSON",
    );
    expect(() => mergeOpenCodeFakeProvider("[]", fake)).toThrow("not a JSON object");
    expect(() => mergeOpenCodeFakeProvider("  ", fake)).not.toThrow();
  });
});
