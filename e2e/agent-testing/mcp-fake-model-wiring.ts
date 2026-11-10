/**
 * Points a `dev:test` profile's own Claude, Codex, Pi or OpenCode at the MCP
 * qualification fake model (`mcp-fake-model.ts`, todo 0039), for the MCP
 * specs' fake-model mode (`ORKESTRATOR_AGENT_TEST_MCP_FAKE_MODEL=1`). Every
 * file it writes is under the profile's data directory and is restored by the
 * returned `stop`, which also stops the model through its own handle. Never a
 * real provider home, and no login: the keys are literal placeholders.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import { startModel, type FakeModelHandle } from "./idle-observation-fake-models";
import {
  mergeOpenCodeFakeProvider,
  openCodeModelRef,
  profileOpenCodeConfigFile,
} from "./opencode-fake-provider";

export type FakeModelPlatform = "claude" | "codex" | "pi" | "opencode";

export const FAKE_PI_PROVIDER = "mcpq-fake";
export const FAKE_PI_MODEL = "mcpq-1";
/** `provider/modelId`, the form Pi sessions and dispatches take. */
export const FAKE_PI_MODEL_REF = `${FAKE_PI_PROVIDER}/${FAKE_PI_MODEL}`;
/** OpenCode's custom provider for the same fake (todo 0039 task 6). */
export const FAKE_OPENCODE_PROVIDER = "mcpq-fake";
export const FAKE_OPENCODE_MODEL = "mcpq-1";
export const FAKE_OPENCODE_MODEL_REF = openCodeModelRef({
  provider: FAKE_OPENCODE_PROVIDER,
  model: FAKE_OPENCODE_MODEL,
});

const FAKE_MODEL = path.join(import.meta.dirname, "mcp-fake-model.ts");

export interface McpFakeModelHandle extends FakeModelHandle {
  /** The model a session must ask for, when the platform needs one named. */
  model?: string;
  /** The files pointed at the fake, for the evidence record (profile-relative). */
  files: string[];
}

export function isFakeModelPlatform(platform: string): platform is FakeModelPlatform {
  return (
    platform === "claude" || platform === "codex" || platform === "pi" || platform === "opencode"
  );
}

export function insideProfile(dataDir: string, file: string): string {
  const root = path.resolve(dataDir);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("a fake-model file escapes the profile data directory");
  }
  return resolved;
}

/** The Pi `models.json` entry for the fake; its key is a literal placeholder. */
export function fakePiModels(baseUrl: string) {
  return {
    providers: {
      [FAKE_PI_PROVIDER]: {
        name: "MCP qualification fake",
        baseUrl,
        api: "openai-completions",
        apiKey: "mcpq-fake-not-a-key",
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
        },
        models: [
          {
            id: FAKE_PI_MODEL,
            name: "MCPQ 1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 64_000,
            maxTokens: 512,
          },
        ],
      },
    },
  };
}

/** Write the platform's fake-model configuration; returns the files written. */
function configure(platform: FakeModelPlatform, dataDir: string, origin: string): string[] {
  const credentials = path.join(dataDir, "agent-credentials");
  if (platform === "claude") {
    const file = insideProfile(dataDir, path.join(credentials, "claude", "settings.json"));
    mkdirSync(path.dirname(file), { recursive: true });
    const earlier = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
      : {};
    const env = {
      ...(earlier.env as Record<string, string> | undefined),
      ANTHROPIC_BASE_URL: origin,
      ANTHROPIC_API_KEY: "fixture-only-not-a-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      DISABLE_AUTOUPDATER: "1",
    };
    writeFileSync(file, `${JSON.stringify({ ...earlier, env }, null, 2)}\n`, { mode: 0o600 });
    return [file];
  }
  if (platform === "codex") {
    const file = insideProfile(dataDir, path.join(credentials, "codex", "config.toml"));
    mkdirSync(path.dirname(file), { recursive: true });
    // A top-level key, so it goes before any table Codex or the editor added.
    const earlier = existsSync(file)
      ? readFileSync(file, "utf8").replace(/^openai_base_url = .*\n/m, "")
      : "";
    writeFileSync(file, `openai_base_url = ${JSON.stringify(`${origin}/v1`)}\n${earlier}`, {
      mode: 0o600,
    });
    return [file];
  }
  if (platform === "opencode") {
    // The global file, which the MCP editor's OpenCode user scope also edits:
    // the merge keeps its servers, and the editor keeps the provider.
    const file = insideProfile(dataDir, profileOpenCodeConfigFile(dataDir));
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const earlier = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    writeFileSync(
      file,
      mergeOpenCodeFakeProvider(earlier, {
        provider: FAKE_OPENCODE_PROVIDER,
        providerName: "MCP qualification fake",
        baseUrl: `${origin}/v1`,
        model: FAKE_OPENCODE_MODEL,
        modelName: "MCPQ 1",
      }),
      { mode: 0o600 },
    );
    return [file];
  }
  // Agent-test backends run with HOME=<dataDir>/agent-credentials/home, and a
  // local Pi bridge uses Pi's default `~/.pi/agent` under it.
  const file = insideProfile(
    dataDir,
    path.join(credentials, "home", ".pi", "agent", "models.json"),
  );
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, "utf8")) as { providers?: object };
    if (Object.keys(existing.providers ?? {}).some((name) => name !== FAKE_PI_PROVIDER)) {
      throw new Error("the profile's Pi models.json already names other providers");
    }
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(fakePiModels(`${origin}/v1`), null, 2)}\n`, {
    mode: 0o600,
  });
  return [file];
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

/**
 * Start the fake model and point the profile's platform at it. Call before
 * the environment's bridge starts its agent, so the first process reads it.
 */
export async function startMcpFakeModel(
  platform: FakeModelPlatform,
  dataDir: string,
  options: Parameters<typeof startModel>[1] = {},
): Promise<McpFakeModelHandle> {
  const credentials = path.join(dataDir, "agent-credentials");
  const planned =
    platform === "claude"
      ? path.join(credentials, "claude", "settings.json")
      : platform === "codex"
        ? path.join(credentials, "codex", "config.toml")
        : platform === "opencode"
          ? profileOpenCodeConfigFile(dataDir)
          : path.join(credentials, "home", ".pi", "agent", "models.json");
  const restore = snapshotFixtureFiles([insideProfile(dataDir, planned)]);
  const model = await startModel(FAKE_MODEL, options);
  let files: string[];
  try {
    files = configure(platform, dataDir, model.origin);
  } catch (error) {
    try {
      restore();
    } finally {
      await stopChild(model.child);
    }
    throw error;
  }
  return {
    origin: model.origin,
    files: files.map((file) => path.relative(dataDir, file)),
    ...(platform === "pi" ? { model: FAKE_PI_MODEL_REF } : {}),
    ...(platform === "opencode" ? { model: FAKE_OPENCODE_MODEL_REF } : {}),
    stop: async () => {
      try {
        restore();
      } finally {
        await stopChild(model.child);
      }
    },
  };
}
