/**
 * Points a `dev:test` profile's own OpenCode at a scripted loopback model
 * through a custom provider (todo 0049 task 6, todo 0039 task 6).
 *
 * An agent-test backend runs OpenCode with
 * `XDG_CONFIG_HOME=<dataDir>/agent-credentials/xdg-config`
 * (`createBackendProcessEnvironment`), so its global configuration is
 * `<that>/opencode/opencode.json`, the file the MCP editor's OpenCode user
 * scope also writes. A custom provider there uses the AI SDK
 * `@ai-sdk/openai-compatible` package, which OpenCode bundles, so nothing is
 * downloaded: OpenCode sends chat completions to `<baseURL>/chat/completions`,
 * the same wire the Pi fakes already serve.
 *
 * The merge keeps every key the file already has (MCP servers above all),
 * adds one provider, makes it the default and the small model, and limits
 * OpenCode to that provider (`enabled_providers`), so neither a turn nor a
 * title request can reach OpenCode's own hosted models. The key is a literal
 * placeholder. Every file is under the profile's data directory; callers
 * snapshot and restore it.
 */
import path from "node:path";

/** The profile's global OpenCode configuration file. */
export function profileOpenCodeConfigFile(dataDir: string): string {
  return path.join(dataDir, "agent-credentials", "xdg-config", "opencode", "opencode.json");
}

export interface OpenCodeFakeProvider {
  provider: string;
  providerName: string;
  /** Ends in `/v1`: OpenCode appends `/chat/completions`. */
  baseUrl: string;
  model: string;
  modelName: string;
}

/** `provider/modelId`, the form an OpenCode session and dispatch take. */
export function openCodeModelRef(fake: Pick<OpenCodeFakeProvider, "provider" | "model">): string {
  return `${fake.provider}/${fake.model}`;
}

/** The configuration keys the fake adds or replaces. */
export function openCodeFakeProviderConfig(fake: OpenCodeFakeProvider) {
  const ref = openCodeModelRef(fake);
  return {
    provider: {
      [fake.provider]: {
        npm: "@ai-sdk/openai-compatible",
        name: fake.providerName,
        options: { baseURL: fake.baseUrl, apiKey: "fixture-only-not-a-key" },
        models: {
          [fake.model]: {
            name: fake.modelName,
            tool_call: true,
            limit: { context: 64_000, output: 2_000 },
          },
        },
      },
    },
    model: ref,
    small_model: ref,
    enabled_providers: [fake.provider],
  };
}

/**
 * The file's new text: the existing configuration with the fake merged in.
 * A file that is not plain JSON (OpenCode also accepts JSONC) is refused
 * rather than rewritten, so a comment can never be lost.
 */
export function mergeOpenCodeFakeProvider(
  existing: string | undefined,
  fake: OpenCodeFakeProvider,
): string {
  let earlier: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      earlier = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new Error("the profile's OpenCode configuration is not plain JSON; not rewriting it");
    }
    if (!earlier || typeof earlier !== "object" || Array.isArray(earlier)) {
      throw new Error("the profile's OpenCode configuration is not a JSON object");
    }
  }
  const added = openCodeFakeProviderConfig(fake);
  const providers = {
    ...(earlier.provider as Record<string, unknown> | undefined),
    ...added.provider,
  };
  return `${JSON.stringify({ ...earlier, ...added, provider: providers }, null, 2)}\n`;
}
