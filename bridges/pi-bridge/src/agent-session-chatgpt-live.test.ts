import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionState } from "./state.js";

// Opt-in: one real provider turn. No prompt, runtime or transport is stubbed.
// Only the openai credential is copied; its refresh token is replaced so this
// disposable runtime cannot rotate the host's token. Require a fresh access
// token and never print credentials or the provider's raw response.
test.skipIf(process.env.ORKESTRATOR_PI_CHATGPT_LIVE !== "1")(
  "a current openai ChatGPT login answers its first prompt without a model preference",
  async () => {
    const authPath = resolve(
      process.env.ORKESTRATOR_PI_CHATGPT_AUTH_FILE ?? join(homedir(), ".pi/agent/auth.json"),
    );
    const credentials = JSON.parse(await readFile(authPath, "utf8"));
    const oauth = credentials.openai;
    if (
      oauth?.type !== "oauth" ||
      typeof oauth.access !== "string" ||
      typeof oauth.expires !== "number" ||
      oauth.expires < Date.now() + 600_000
    ) {
      throw new Error(
        "Live qualification requires a current openai ChatGPT OAuth login with at least ten minutes remaining; a legacy openai-codex login cannot substitute.",
      );
    }

    const root = await mkdtemp(join(tmpdir(), "pi-chatgpt-live-"));
    const agentDir = join(root, "agent");
    const env = {
      HOME: root,
      CWD: join(root, "workspace"),
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SESSION_DIR: join(root, "sessions"),
      PI_BRIDGE_AUTH_FILE: undefined,
      PI_BRIDGE_DEFAULT_MODEL: undefined,
      PI_BRIDGE_STATE_DIR: undefined,
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    let state: SessionState | undefined;
    let detach: ((state: SessionState) => Promise<void>) | undefined;
    let resetRuntime: (() => void) | undefined;
    let resetCatalogue: (() => void) | undefined;
    try {
      await mkdir(agentDir);
      await mkdir(env.CWD);
      await mkdir(env.PI_SESSION_DIR);
      await writeFile(
        join(agentDir, "auth.json"),
        JSON.stringify({ openai: { ...oauth, refresh: "disabled-for-live-qualification" } }),
        { mode: 0o600 },
      );
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      // Import after isolation: config.ts captures CWD at module evaluation.
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      const { modelRuntime, setModelRuntimeFactoryForTests } = await import("./runtime.js");
      const { listModels, refreshModels } = await import("./models.js");
      const { createSession, defaultModelIds, detachSession, ensureSession } =
        await import("./agent-session.js");
      const { dispatchPrompt } = await import("./prompt.js");
      detach = detachSession;
      resetRuntime = () => setModelRuntimeFactoryForTests();
      resetCatalogue = refreshModels;
      setModelRuntimeFactoryForTests(() =>
        ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
          allowModelNetwork: false,
        }),
      );
      refreshModels();
      expect((await modelRuntime()).isUsingSubscription("openai")).toBe(true);
      expect((await listModels())[0]?.id).toBe("openai/gpt-4");
      state = await createSession("chatgpt-live-default", undefined);
      expect(defaultModelIds(state)).toEqual([]);
      expect(state.composer.selectedModelId).toBe("openai/gpt-6.1-sol");
      const session = await ensureSession(state);
      expect(session.model?.provider).toBe("openai");
      expect(session.model?.id).toBe("gpt-6.1-sol");

      state.status = "running";
      state.promptSequence = 1;
      const handle = await dispatchPrompt(
        state,
        session,
        {
          prompt: "Reply with exactly OK. Do not use tools.",
          images: [],
        },
        90_000,
        30_000,
      );
      await handle.completion;

      // Pi can resolve a failed provider turn; completion alone proves nothing.
      expect(String(state.status)).toBe("idle");
      expect(state.turnError === undefined).toBe(true);
      expect(state.turnAborted === true).toBe(false);
      const response = session.messages.filter((message) => message.role === "assistant").pop();
      expect(response?.role).toBe("assistant");
      if (response?.role !== "assistant") throw new Error("No assistant response");
      expect(response.provider).toBe("openai");
      expect(response.model).toBe("gpt-6.1-sol");
      expect(response.stopReason).toBe("stop");
      expect(
        response.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
          .trim() === "OK",
      ).toBe(true);
    } finally {
      try {
        if (state && detach) await detach(state);
      } finally {
        resetRuntime?.();
        resetCatalogue?.();
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
