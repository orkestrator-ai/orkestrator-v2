import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  allowOpenCodeFakeProvider,
  allowlistWithProvider,
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

describe("OpenCode provider allowlist", () => {
  test("adds the provider to the managed default, and leaves an admitting list alone", () => {
    expect(allowlistWithProvider(undefined, "fixture-fake")).toEqual([
      "opencode",
      "opencode-go",
      "fixture-fake",
    ]);
    expect(allowlistWithProvider(["opencode"], "Fixture-Fake")).toEqual([
      "opencode",
      "fixture-fake",
    ]);
    expect(allowlistWithProvider(["fixture-fake"], "fixture-fake")).toBeUndefined();
    // Empty is the user's opt-in to the full catalogue, which already admits it.
    expect(allowlistWithProvider([], "fixture-fake")).toBeUndefined();
  });

  for (const earlier of [undefined, ["opencode"]] as const) {
    test(`patches the setting and restores ${earlier ? "the earlier value" : "its absence"}`, async () => {
      const calls: Array<[string, unknown]> = [];
      const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push([command, args]);
        return (
          command === "get_config"
            ? { global: earlier ? { openCodeModelProviders: earlier } : {} }
            : {}
        ) as T;
      };
      const restore = await allowOpenCodeFakeProvider(invoke, "fixture-fake");
      expect(calls[1]).toEqual([
        "patch_global_config",
        {
          patch: {
            openCodeModelProviders: earlier
              ? ["opencode", "fixture-fake"]
              : ["opencode", "opencode-go", "fixture-fake"],
          },
        },
      ]);
      await restore();
      expect(calls[2]).toEqual([
        "patch_global_config",
        earlier
          ? { patch: { openCodeModelProviders: ["opencode"] } }
          : { patch: {}, unset: ["openCodeModelProviders"] },
      ]);
    });
  }

  test("does not patch when the provider is already admitted", async () => {
    const commands: string[] = [];
    const invoke = async <T>(command: string): Promise<T> => {
      commands.push(command);
      return { global: { openCodeModelProviders: [] } } as T;
    };
    await (
      await allowOpenCodeFakeProvider(invoke, "fixture-fake")
    )();
    expect(commands).toEqual(["get_config"]);
  });
});
