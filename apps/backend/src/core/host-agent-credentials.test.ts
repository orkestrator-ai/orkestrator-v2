import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { AGENT_TEST_HOST_PI_AGENT_DIR_ENV } from "./commands-runtime-state.js";
import { applyPiHostCredentialEnvironment, readPiDefaultModel } from "./host-agent-credentials.js";

let root: string;
let hostAgentDir: string;
const previousHostAgentDir = process.env[AGENT_TEST_HOST_PI_AGENT_DIR_ENV];

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return { runtimeFlavor: "production", ...overrides } as CommandContext;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pi-host-credential-"));
  hostAgentDir = path.join(root, "host-home", ".pi", "agent");
  process.env[AGENT_TEST_HOST_PI_AGENT_DIR_ENV] = hostAgentDir;
});

afterEach(async () => {
  if (previousHostAgentDir === undefined) delete process.env[AGENT_TEST_HOST_PI_AGENT_DIR_ENV];
  else process.env[AGENT_TEST_HOST_PI_AGENT_DIR_ENV] = previousHostAgentDir;
  await fs.rm(root, { recursive: true, force: true });
});

async function saveHostDefault(provider: unknown, modelId: unknown): Promise<void> {
  await fs.mkdir(hostAgentDir, { recursive: true });
  await fs.writeFile(
    path.join(hostAgentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: modelId,
      // Everything else in the host's settings stays behind.
      packages: ["npm:host-extension"],
    }),
  );
}

describe("applyPiHostCredentialEnvironment", () => {
  test("leaves a production bridge on Pi's own default directory", async () => {
    await fs.mkdir(hostAgentDir, { recursive: true });
    await fs.writeFile(path.join(hostAgentDir, "auth.json"), "{}");
    await saveHostDefault("openai-codex", "gpt-5.5");
    const env: NodeJS.ProcessEnv = {
      PI_AGENT_DIR: "/leaked",
      PI_BRIDGE_AUTH_FILE: "/leaked",
      PI_BRIDGE_DEFAULT_MODEL: "leaked/model",
    };

    await applyPiHostCredentialEnvironment(context(), env);

    expect(env.PI_AGENT_DIR).toBeUndefined();
    expect(env.PI_BRIDGE_AUTH_FILE).toBeUndefined();
    expect(env.PI_BRIDGE_DEFAULT_MODEL).toBeUndefined();
  });

  test("shares only the host auth file with an authorized agent-test profile", async () => {
    await fs.mkdir(hostAgentDir, { recursive: true });
    await fs.writeFile(path.join(hostAgentDir, "auth.json"), "{}");
    const env: NodeJS.ProcessEnv = { PI_AGENT_DIR: "/leaked" };

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["pi"]) }),
      env,
    );

    expect(env.PI_AGENT_DIR).toBeUndefined();
    expect(env.PI_BRIDGE_AUTH_FILE).toBe(path.join(hostAgentDir, "auth.json"));
  });

  test("carries the host's saved default model with the shared login", async () => {
    await fs.mkdir(hostAgentDir, { recursive: true });
    await fs.writeFile(path.join(hostAgentDir, "auth.json"), "{}");
    await saveHostDefault("openai-codex", "gpt-5.5");
    const env: NodeJS.ProcessEnv = {};

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["pi"]) }),
      env,
    );

    expect(env.PI_BRIDGE_DEFAULT_MODEL).toBe("openai-codex/gpt-5.5");
  });

  test("names no default model without the host login it belongs to", async () => {
    await saveHostDefault("openai-codex", "gpt-5.5");
    const env: NodeJS.ProcessEnv = {};

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["pi"]) }),
      env,
    );

    expect(env.PI_BRIDGE_AUTH_FILE).toBeUndefined();
    expect(env.PI_BRIDGE_DEFAULT_MODEL).toBeUndefined();
  });

  test("gives a profile that did not authorize Pi no host default model", async () => {
    await fs.mkdir(hostAgentDir, { recursive: true });
    await fs.writeFile(path.join(hostAgentDir, "auth.json"), "{}");
    await saveHostDefault("openai-codex", "gpt-5.5");
    const env: NodeJS.ProcessEnv = { PI_BRIDGE_DEFAULT_MODEL: "leaked/model" };

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["claude"]) }),
      env,
    );

    expect(env.PI_BRIDGE_DEFAULT_MODEL).toBeUndefined();
  });

  test("gives a profile that did not authorize Pi no host path", async () => {
    await fs.mkdir(hostAgentDir, { recursive: true });
    await fs.writeFile(path.join(hostAgentDir, "auth.json"), "{}");
    const env: NodeJS.ProcessEnv = {};

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["claude"]) }),
      env,
    );

    expect(env.PI_BRIDGE_AUTH_FILE).toBeUndefined();
  });

  test("never names a host auth file that does not exist", async () => {
    // Pi creates a missing credential file and its directory; the host's Pi
    // home must stay exactly as it was.
    const env: NodeJS.ProcessEnv = {};

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["pi"]) }),
      env,
    );

    expect(env.PI_BRIDGE_AUTH_FILE).toBeUndefined();
    expect(await fs.stat(path.join(root, "host-home")).catch(() => null)).toBeNull();
  });

  test("ignores a directory where the auth file should be", async () => {
    await fs.mkdir(path.join(hostAgentDir, "auth.json"), { recursive: true });
    const env: NodeJS.ProcessEnv = {};

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["pi"]) }),
      env,
    );

    expect(env.PI_BRIDGE_AUTH_FILE).toBeUndefined();
  });
});

describe("readPiDefaultModel", () => {
  const settingsFile = () => path.join(hostAgentDir, "settings.json");

  test("reads a saved provider and model as one id", async () => {
    await saveHostDefault(" openrouter ", "anthropic/claude-opus-4-5");

    expect(await readPiDefaultModel(settingsFile())).toBe("openrouter/anthropic/claude-opus-4-5");
  });

  test("accepts a settings file with a byte-order mark, as Pi does", async () => {
    await fs.mkdir(hostAgentDir, { recursive: true });
    await fs.writeFile(
      settingsFile(),
      `\uFEFF${JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.5" })}`,
    );

    expect(await readPiDefaultModel(settingsFile())).toBe("openai-codex/gpt-5.5");
  });

  test.each([
    ["only a provider", "openai-codex", undefined],
    ["only a model", undefined, "gpt-5.5"],
    ["a blank model", "openai-codex", "  "],
    ["a provider with a slash", "openai/codex", "gpt-5.5"],
    ["a non-string model", "openai-codex", 5],
    ["an oversized id", "openai-codex", "m".repeat(2048)],
  ])("names no default for %s", async (_label, provider, modelId) => {
    await saveHostDefault(provider, modelId);

    expect(await readPiDefaultModel(settingsFile())).toBeUndefined();
  });

  test("names no default for a missing, malformed or non-file settings path", async () => {
    expect(await readPiDefaultModel(settingsFile())).toBeUndefined();

    await fs.mkdir(hostAgentDir, { recursive: true });
    await fs.writeFile(settingsFile(), "{ not json");
    expect(await readPiDefaultModel(settingsFile())).toBeUndefined();

    await fs.writeFile(settingsFile(), "[]");
    expect(await readPiDefaultModel(settingsFile())).toBeUndefined();

    await fs.rm(settingsFile());
    await fs.mkdir(settingsFile());
    expect(await readPiDefaultModel(settingsFile())).toBeUndefined();
  });
});
