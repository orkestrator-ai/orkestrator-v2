import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  applyComposerToSession,
  createSession,
  defaultModelIds,
  detachSession,
  ensureSession,
  expireComposerHydrationRetryForTests,
  hydrateSessionComposer,
  newSessionState,
  resumeSession,
  setAgentSessionTestHooks,
} from "./agent-session.js";
import { fallbackDefaultModelId, MAX_MODEL_ID_BYTES, workingDirectory } from "./config.js";
import { refreshModels } from "./models.js";
import { dispatchPrompt } from "./prompt.js";
import { setModelRuntimeFactoryForTests } from "./runtime.js";
import { clientSessionKeys, sessionCreations, sessions } from "./state.js";

function installRuntimeWithModels(available: Model<Api>[]): void {
  setModelRuntimeFactoryForTests(
    async () =>
      ({
        getProviders: () => [],
        hasConfiguredAuth: () => true,
        checkAuth: async () => ({ source: "environment", type: "api_key" }),
        getAvailable: async () => available,
        getProvider: () => undefined,
        getModel: () => undefined,
        refresh: async () => undefined,
      }) as unknown as ModelRuntime,
  );
  refreshModels();
}

function model(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_000,
  } as Model<Api>;
}

describe("default model", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;
  let sessionDirectory: string;
  const envNames = [
    "PI_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "PI_SESSION_DIR",
    "PI_BRIDGE_DEFAULT_MODEL",
  ] as const;
  let previousEnv: Partial<Record<(typeof envNames)[number], string>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-bridge-default-model-"));
    agentDir = join(root, "agent");
    cwd = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    sessionDirectory = join(root, "sessions");
    await mkdir(sessionDirectory);
    previousEnv = {};
    for (const name of envNames) previousEnv[name] = process.env[name];
    process.env.PI_SESSION_DIR = sessionDirectory;
    sessions.clear();
    clientSessionKeys.clear();
    sessionCreations.clear();
    setAgentSessionTestHooks(undefined);
    process.env.PI_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_BRIDGE_DEFAULT_MODEL;
  });

  afterEach(async () => {
    for (const name of envNames) {
      if (previousEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
    setAgentSessionTestHooks(undefined);
    setModelRuntimeFactoryForTests();
    refreshModels();
    sessions.clear();
    clientSessionKeys.clear();
    sessionCreations.clear();
    await rm(root, { recursive: true, force: true });
  });

  async function saveDefault(directory: string, provider: string, modelId: string): Promise<void> {
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ defaultProvider: provider, defaultModel: modelId }),
    );
  }

  test("prefers Pi's saved default, then the backend's fallback", async () => {
    await saveDefault(agentDir, "opencode-go", "kimi-k3");
    process.env.PI_BRIDGE_DEFAULT_MODEL = "openai-codex/gpt-5.5";

    expect(defaultModelIds(newSessionState(), cwd, agentDir)).toEqual([
      "opencode-go/kimi-k3",
      "openai-codex/gpt-5.5",
    ]);
  });

  test("uses the fallback alone when the settings name no default", () => {
    process.env.PI_BRIDGE_DEFAULT_MODEL = "openai-codex/gpt-5.5";

    expect(defaultModelIds(newSessionState(), cwd, agentDir)).toEqual(["openai-codex/gpt-5.5"]);
  });

  test("ignores a fallback that names no provider", () => {
    process.env.PI_BRIDGE_DEFAULT_MODEL = "gpt-5.5";

    expect(defaultModelIds(newSessionState(), cwd, agentDir)).toEqual([]);
  });

  test.each([
    ["a leading slash", "/model"],
    ["a trailing slash", "provider/"],
    ["an oversized id", `provider/${"é".repeat(MAX_MODEL_ID_BYTES / 2)}`],
  ])("rejects a fallback with %s", (_label, value) => {
    process.env.PI_BRIDGE_DEFAULT_MODEL = value;

    expect(fallbackDefaultModelId()).toBeUndefined();
    expect(defaultModelIds(newSessionState(), cwd, agentDir)).toEqual([]);
  });

  test("accepts a fallback at the model id byte limit", () => {
    const value = `provider/${"m".repeat(MAX_MODEL_ID_BYTES - "provider/".length)}`;
    process.env.PI_BRIDGE_DEFAULT_MODEL = value;

    expect(fallbackDefaultModelId()).toBe(value);
  });

  test("names a default once when the settings and the fallback agree", async () => {
    await saveDefault(agentDir, "openai-codex", "gpt-5.5");
    process.env.PI_BRIDGE_DEFAULT_MODEL = "openai-codex/gpt-5.5";

    expect(defaultModelIds(newSessionState(), cwd, agentDir)).toEqual(["openai-codex/gpt-5.5"]);
  });

  test("reads a project's default only when the session trusts the project", async () => {
    await saveDefault(agentDir, "openai-codex", "gpt-5.5");
    await saveDefault(join(cwd, ".pi"), "opencode-go", "kimi-k3");

    expect(defaultModelIds(newSessionState(), cwd, agentDir)).toEqual(["openai-codex/gpt-5.5"]);
    expect(defaultModelIds({ policy: { projectResources: true } as never }, cwd, agentDir)).toEqual(
      ["opencode-go/kimi-k3"],
    );
  });

  test("starts a new session on the default instead of the catalogue's first model", async () => {
    // The 2026-10-22 failure: a ChatGPT-backed Codex login lists Spark first,
    // and the account cannot use it.
    process.env.PI_BRIDGE_DEFAULT_MODEL = "openai-codex/gpt-5.5";
    installRuntimeWithModels([
      model("openai-codex", "gpt-5.3-codex-spark"),
      model("openai-codex", "gpt-5.5"),
    ]);

    const state = await createSession("default-model", undefined);

    expect(state.composer.selectedModelId).toBe("openai-codex/gpt-5.5");
  });

  test.each(["saved", "host fallback"])("resumes on the %s preference", async (source) => {
    await saveDefault(agentDir, source === "saved" ? "opencode-go" : "signed-out", "kimi-k3");
    process.env.PI_BRIDGE_DEFAULT_MODEL = "openai-codex/gpt-5.5";
    installRuntimeWithModels([
      model("openai-codex", "gpt-5.3-codex-spark"),
      model("openai-codex", "gpt-5.5"),
      model("opencode-go", "kimi-k3"),
    ]);
    const sessionFile = join(sessionDirectory, "default-resume.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "default-resume",
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd: workingDirectory,
      })}\n`,
    );

    const state = await resumeSession(sessionFile, undefined);

    expect(state.composer.selectedModelId).toBe(
      source === "saved" ? "opencode-go/kimi-k3" : "openai-codex/gpt-5.5",
    );
  });

  test("retries an empty catalogue using the isolated Pi settings default", async () => {
    await saveDefault(agentDir, "openai-codex", "gpt-5.5");
    installRuntimeWithModels([]);
    const state = newSessionState();
    await hydrateSessionComposer(state);
    expect(state.composer.selectedModelId).toBeUndefined();

    installRuntimeWithModels([
      model("openai-codex", "gpt-5.3-codex-spark"),
      model("openai-codex", "gpt-5.5"),
    ]);
    // Polling stays throttled until the previous empty read's retry expires.
    await hydrateSessionComposer(state);
    expect(state.composer.models).toEqual([]);
    expireComposerHydrationRetryForTests(state);
    await hydrateSessionComposer(state);

    expect(state.composer.selectedModelId).toBe("openai-codex/gpt-5.5");
  });

  test.each([
    ["no selection", undefined],
    ["a stale selection", "stale/unavailable"],
  ])(
    "applies the saved default to an attached session with %s",
    async (_label, selectedModelId) => {
      await saveDefault(agentDir, "openai-codex", "gpt-5.5");
      const preferred = model("openai-codex", "gpt-5.5");
      installRuntimeWithModels([model("openai-codex", "gpt-5.3-codex-spark"), preferred]);
      const state = newSessionState();
      const session = {
        model: model("openai-codex", "gpt-5.3-codex-spark"),
        thinkingLevel: "medium",
        async setModel(next: Model<Api>) {
          this.model = next;
        },
        getAvailableThinkingLevels: () => ["medium"],
      } as unknown as AgentSession;
      state.session = session;
      state.composer.selectedModelId = selectedModelId;

      await applyComposerToSession(state);

      expect(session.model).toBe(preferred);
      expect(state.composer.selectedModelId).toBe("openai-codex/gpt-5.5");
    },
  );

  test("constructs a Pi session on the host fallback and carries it to prompt dispatch", async () => {
    await saveDefault(agentDir, "signed-out", "unavailable");
    process.env.PI_BRIDGE_DEFAULT_MODEL = "openai-codex/gpt-5.5";
    const preferred = model("openai-codex", "gpt-5.5");
    installRuntimeWithModels([model("openai-codex", "gpt-5.3-codex-spark"), preferred]);
    // Start without composer hydration so SDK construction must resolve the
    // preference itself, rather than inherit an already-selected model.
    const state = newSessionState();
    try {
      const attached = await ensureSession(state);
      expect(attached.model).toBe(preferred);
      expect(state.composer.selectedModelId).toBe("openai-codex/gpt-5.5");
      let promptedModel: Model<Api> | undefined;
      // Keep SDK construction real; replace only the network-bound turn.
      const prompt = spyOn(attached, "prompt").mockImplementation(async (_text, options) => {
        promptedModel = attached.model;
        options?.preflightResult?.("started");
      });
      try {
        state.status = "running";
        state.promptSequence = 1;
        const handle = await dispatchPrompt(state, attached, { prompt: "hello", images: [] });
        await handle.completion;
        expect(promptedModel).toBe(preferred);
        expect(state.status).toBe("idle");
      } finally {
        prompt.mockRestore();
      }
    } finally {
      await detachSession(state);
    }
  });

  test("keeps the model a caller asked for", async () => {
    process.env.PI_BRIDGE_DEFAULT_MODEL = "openai-codex/gpt-5.5";
    installRuntimeWithModels([
      model("openai-codex", "gpt-5.3-codex-spark"),
      model("openai-codex", "gpt-5.5"),
    ]);

    const state = await createSession("explicit-model", {
      modelId: "openai-codex/gpt-5.3-codex-spark",
    });

    expect(state.composer.selectedModelId).toBe("openai-codex/gpt-5.3-codex-spark");
  });
});
