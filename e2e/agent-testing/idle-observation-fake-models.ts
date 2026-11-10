/**
 * Wiring for `idle-observation-live.spec.ts`'s fake-model mode
 * (`ORKESTRATOR_AGENT_TEST_IDLE_FAKE_MODELS=1`, todo 0049): starts the scripted
 * loopback models and points the profile's own isolated Claude settings or
 * Codex config at them, or installs the Claude model inside a container.
 * Every change is undone by the returned `stop`. Never a real provider home:
 * the paths are under the profile's data directory, or the container's.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import { installFakeClaudeApiFixture } from "./container-fake-claude-install";
import { profilePiAgentDirectory } from "../../scripts/pi-fake-model-shared";
import { PI_FAKE_MODEL, PI_FAKE_PROVIDER, piFakeModelsConfig } from "./idle-observation-fake-pi";
import { mergeOpenCodeFakeProvider, profileOpenCodeConfigFile } from "./opencode-fake-provider";

export interface FakeModelHandle {
  /** Where the model listens, for the evidence record. */
  origin: string;
  stop(): Promise<void>;
}

/** Keep fake acquisition and all later setup inside the same cleanup scope. */
export async function withFakeModelCleanup<T>(
  handles: FakeModelHandle[],
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    await stopFakeModels(handles);
  }
}

async function stopFakeModels(handles: FakeModelHandle[]): Promise<void> {
  const results = await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  const errors = results.filter((result) => result.status === "rejected");
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      "fake cleanup failed",
    );
}

const FAKE_CLAUDE = path.join(import.meta.dirname, "idle-observation-fake-claude.ts");
const FAKE_CODEX = path.join(import.meta.dirname, "idle-observation-fake-codex.ts");
const FAKE_PI = path.join(import.meta.dirname, "idle-observation-fake-pi.ts");
// OpenCode speaks the same chat completions as Pi, through a custom provider.
const FAKE_SCRIPTS = {
  claude: FAKE_CLAUDE,
  codex: FAKE_CODEX,
  pi: FAKE_PI,
  opencode: FAKE_PI,
} as const;
export type FakeModelPlatform = keyof typeof FAKE_SCRIPTS;

/**
 * Where a profile's provider reads the setting that names its model:
 * Claude and Codex homes under `agent-credentials`, and for Pi the default
 * `~/.pi/agent` under the backend's isolated HOME (`<dataDir>/agent-credentials/home`,
 * the directory to-do 0048's soak writes). OpenCode reads its global
 * `opencode.json` under the profile's isolated `XDG_CONFIG_HOME`.
 */
export function fakeModelSettingsFile(platform: FakeModelPlatform, dataDir: string): string {
  if (platform === "opencode") return profileOpenCodeConfigFile(dataDir);
  if (platform === "pi") {
    return path.join(profilePiAgentDirectory(dataDir), "models.json");
  }
  const home = path.join(dataDir, "agent-credentials", platform);
  return path.join(home, platform === "claude" ? "settings.json" : "config.toml");
}
/** The port `installFakeClaudeApiFixture` serves on inside a container. */
const CONTAINER_FAKE_PORT = 47_123;

/** Spawn a fake under the host's Bun and read the address it prints. */
export async function startModel(
  script: string,
  options: { spawnModel?: typeof spawn; timeoutMs?: number } = {},
): Promise<{ origin: string; child: ChildProcess }> {
  const child = (options.spawnModel ?? spawn)("bun", [script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! });
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        lines.off("line", onLine);
        child.off("exit", onExit);
        child.off("error", onError);
        lines.close();
      };
      const onLine = (line: string) => {
        cleanup();
        resolve(line.trim());
      };
      const onExit = () => {
        cleanup();
        reject(new Error("the loopback model exited"));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("the loopback model never started"));
      }, options.timeoutMs ?? 30_000);
      lines.once("line", onLine);
      child.once("exit", onExit);
      child.once("error", onError);
    });
    return { origin, child };
  } catch (error) {
    // A failed spawn has no PID and will never emit exit.
    if (child.pid !== undefined) await stopChild(child);
    throw error;
  }
}

/** Stops only the child this module spawned, through its own handle. */
function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

/**
 * Point a profile's Claude, Codex, Pi or OpenCode at a scripted loopback model. Call before
 * the environment's bridge starts its CLI, so the first process reads it.
 */
export async function startLocalFakeModel(
  platform: FakeModelPlatform,
  dataDir: string,
  options: Parameters<typeof startModel>[1] = {},
): Promise<FakeModelHandle> {
  const file = fakeModelSettingsFile(platform, dataDir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const restore = snapshotFixtureFiles([file]);
  const model = await startModel(FAKE_SCRIPTS[platform], options);
  try {
    if (platform === "opencode") {
      // Adds one provider and makes it the only one; every other key is kept.
      const earlier = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      writeFileSync(
        file,
        mergeOpenCodeFakeProvider(earlier, {
          // The same `provider/modelId` as Pi's (`PI_FAKE_MODEL_REF`).
          provider: PI_FAKE_PROVIDER,
          providerName: "Idle observation fake",
          baseUrl: model.origin,
          model: PI_FAKE_MODEL,
          modelName: "Idle observation 1",
        }),
        { mode: 0o600 },
      );
    } else if (platform === "pi") {
      // Adds one provider; any the profile already has are kept.
      const earlier = existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as { providers?: Record<string, unknown> })
        : {};
      const providers = { ...earlier.providers, ...piFakeModelsConfig(model.origin).providers };
      writeFileSync(file, `${JSON.stringify({ ...earlier, providers }, null, 2)}\n`, {
        mode: 0o600,
      });
    } else if (platform === "claude") {
      const earlier = existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
        : {};
      const env = {
        ...(earlier.env as Record<string, string> | undefined),
        ANTHROPIC_BASE_URL: model.origin,
        ANTHROPIC_API_KEY: "fixture-only-not-a-key",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
        DISABLE_AUTOUPDATER: "1",
      };
      writeFileSync(file, `${JSON.stringify({ ...earlier, env }, null, 2)}\n`, { mode: 0o600 });
    } else {
      // A top-level key, so it goes before any table Codex has added.
      const earlier = existsSync(file)
        ? readFileSync(file, "utf8").replace(/^openai_base_url = .*\n/m, "")
        : "";
      writeFileSync(file, `openai_base_url = ${JSON.stringify(model.origin)}\n${earlier}`, {
        mode: 0o600,
      });
    }
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
    stop: async () => {
      try {
        restore();
      } finally {
        await stopChild(model.child);
      }
    },
  };
}

function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000, input });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed`);
  return result.stdout.trim();
}

/**
 * Serve the scripted Claude model on a container's loopback and merge its
 * address into the container user's Claude settings, as
 * `container-claude-terminal-signal.spec.ts` does for its fixture.
 */
export async function installContainerFakeClaude(containerId: string): Promise<FakeModelHandle> {
  const ready = () =>
    spawnSync(
      "docker",
      [
        "exec",
        containerId,
        "curl",
        "-fsS",
        "-o",
        "/dev/null",
        "-X",
        "POST",
        "-d",
        "{}",
        `http://127.0.0.1:${CONTAINER_FAKE_PORT}/v1/messages/count_tokens`,
      ],
      { timeout: 5_000 },
    ).status === 0;
  const undo = await installFakeClaudeApiFixture({
    asNode: (script, input) =>
      docker(["exec", "-i", "--user", "node", containerId, "sh", "-c", script], input),
    startServer: (args) => docker(["exec", "-d", "--user", "node", containerId, ...args]),
    // Signals only the fixture this spec copied in: the bracket keeps
    // pkill's own command line from matching.
    stopServer: () => {
      spawnSync(
        "docker",
        ["exec", containerId, "pkill", "-f", "orkestrator-qa-fake-claude-ap[i]"],
        {
          timeout: 15_000,
        },
      );
    },
    source: readFileSync(FAKE_CLAUDE, "utf8"),
    waitUntilReady: async () => {
      for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("the container's loopback model never answered");
    },
  });
  return { origin: `container loopback :${CONTAINER_FAKE_PORT}`, stop: async () => undo() };
}

/** Read a file inside a container as its `node` user; undefined when unreadable. */
export function readContainerFile(containerId: string, file: string): string | undefined {
  const result = spawnSync("docker", ["exec", "--user", "node", containerId, "cat", file], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : undefined;
}
