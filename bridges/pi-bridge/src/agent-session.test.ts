import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  applyComposerPatch,
  applyComposerToSession,
  closeSession,
  createSession,
  detachSession,
  ensureSession,
  forkSession,
  newSessionState,
  projectResourceDiscoveryOptions,
  resumeSession,
  sessionManagerFor,
  setAgentSessionTestHooks,
  type AgentSessionTestHooks,
} from "./agent-session.js";
import { workingDirectory } from "./config.js";
import { dispatchPrompt } from "./prompt.js";
import { clientSessionKeys, sessionCreations, sessions } from "./state.js";

let sessionDirectory: string;
let previousSessionDirectory: string | undefined;

beforeEach(async () => {
  sessionDirectory = await mkdtemp(join(tmpdir(), "pi-bridge-agent-session-"));
  previousSessionDirectory = process.env.PI_SESSION_DIR;
  process.env.PI_SESSION_DIR = sessionDirectory;
  sessions.clear();
  clientSessionKeys.clear();
  sessionCreations.clear();
  installTestHooks();
});

afterEach(async () => {
  if (previousSessionDirectory === undefined) delete process.env.PI_SESSION_DIR;
  else process.env.PI_SESSION_DIR = previousSessionDirectory;
  setAgentSessionTestHooks(undefined);
  sessions.clear();
  clientSessionKeys.clear();
  sessionCreations.clear();
  await rm(sessionDirectory, { recursive: true, force: true });
});

function installTestHooks(hooks: AgentSessionTestHooks = {}): void {
  setAgentSessionTestHooks({
    hydrateComposer: async (composer) => composer,
    ...hooks,
  });
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

interface FakeSessionControl {
  session: AgentSession;
  emit: (event: unknown) => void;
  subscribed: () => number;
  unsubscribed: () => number;
  disposed: () => number;
}

function fakeSession(overrides: Record<string, unknown> = {}): FakeSessionControl {
  let subscribed = 0;
  let unsubscribed = 0;
  let disposed = 0;
  let listener: ((event: unknown) => void) | undefined;
  const session = {
    sessionId: "pi-session-1",
    sessionFile: join(sessionDirectory, "attached.jsonl"),
    model: model("available", "actual"),
    thinkingLevel: "medium",
    promptTemplates: [],
    subscribe: (nextListener: (event: unknown) => void) => {
      subscribed += 1;
      listener = nextListener;
      return () => {
        unsubscribed += 1;
        listener = undefined;
      };
    },
    dispose: () => {
      disposed += 1;
    },
    setModel: async function (next: Model<Api>) {
      this.model = next;
    },
    setThinkingLevel: function (next: string) {
      this.thinkingLevel = next;
    },
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    ...overrides,
  } as unknown as AgentSession;
  return {
    session,
    emit: (event) => listener?.(event),
    subscribed: () => subscribed,
    unsubscribed: () => unsubscribed,
    disposed: () => disposed,
  };
}

describe("session ownership", () => {
  test("shares one creation across concurrent retries with the same client key", async () => {
    let release: (() => void) | undefined;
    let hydrations = 0;
    installTestHooks({
      hydrateComposer: async (composer) => {
        hydrations += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return composer;
      },
    });

    const first = createSession("tab-1", { modelId: "provider/model" });
    const second = createSession("tab-1", { modelId: "ignored/retry" });
    expect(hydrations).toBe(1);
    release!();

    const [firstState, secondState] = await Promise.all([first, second]);
    expect(firstState).toBe(secondState);
    expect(firstState.composer.selectedModelId).toBe("provider/model");
    expect(clientSessionKeys.get("tab-1")).toBe(firstState.id);
    expect(sessionCreations.size).toBe(0);
  });

  test("shares one SDK construction and subscription across concurrent attaches", async () => {
    const fake = fakeSession();
    let release: (() => void) | undefined;
    let creations = 0;
    installTestHooks({
      createAgentSession: async () => {
        creations += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return fake.session;
      },
    });
    const state = newSessionState();

    const first = ensureSession(state);
    const second = ensureSession(state);
    expect(creations).toBe(1);
    release!();

    expect(await first).toBe(fake.session);
    expect(await second).toBe(fake.session);
    expect(fake.subscribed()).toBe(1);
    expect(state.piSessionId).toBe("pi-session-1");
  });

  test("shares one bridge state across concurrent resumes of the same Pi file", async () => {
    const sessionFile = join(sessionDirectory, "conversation.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "resume-race",
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd: workingDirectory,
      })}\n`,
      "utf8",
    );

    const [first, second] = await Promise.all([
      resumeSession(sessionFile, undefined),
      resumeSession(sessionFile, undefined),
    ]);

    expect(first).toBe(second);
    expect(Array.from(sessions.values())).toEqual([first]);
  });

  test("waits for a cold attach and disposes it when the owner closes", async () => {
    const state = newSessionState();
    let publish: (() => void) | undefined;
    let disposed = 0;
    const attached = {
      dispose: () => {
        disposed += 1;
      },
    } as unknown as AgentSession;
    state.attaching = new Promise<AgentSession>((resolve) => {
      publish = () => {
        state.session = attached;
        resolve(attached);
      };
    });

    const closing = closeSession(state);
    await expect(ensureSession(state)).rejects.toThrow(/closed/);
    publish!();
    await closing;

    expect(disposed).toBe(1);
    expect(state.session).toBeNull();
    await expect(ensureSession(state)).rejects.toThrow(/closed/);
  });
});

describe("Pi SDK lifecycle", () => {
  test("fails project resource discovery closed unless explicitly enabled", () => {
    expect(projectResourceDiscoveryOptions(false)).toEqual({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
    });
    expect(projectResourceDiscoveryOptions(true)).toEqual({
      noExtensions: false,
      noSkills: false,
      noPromptTemplates: false,
    });
  });

  test("reopens a valid session file and falls back from an invalid one", async () => {
    const validFile = join(sessionDirectory, "valid.jsonl");
    await writeFile(
      validFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "persisted-session",
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd: workingDirectory,
      })}\n`,
      "utf8",
    );
    const resumedState = newSessionState();
    resumedState.sessionFile = validFile;
    expect(sessionManagerFor(resumedState).getSessionId()).toBe("persisted-session");

    const invalidFile = join(sessionDirectory, "invalid.jsonl");
    await writeFile(invalidFile, `${JSON.stringify({ type: "not-a-session" })}\n`, "utf8");
    const fallbackState = newSessionState();
    fallbackState.sessionFile = invalidFile;
    const fresh = sessionManagerFor(fallbackState);
    expect(fallbackState.sessionFile).toBeUndefined();
    expect(fresh.getSessionId()).not.toBe("persisted-session");
  });

  test("forks at the newest user entry and preserves the composer selection", async () => {
    const forkedFile = join(sessionDirectory, "forked.jsonl");
    await writeFile(
      forkedFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "forked-session",
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd: workingDirectory,
      })}\n`,
      "utf8",
    );
    let branchedAt = "";
    const fake = fakeSession({
      thinkingLevel: "high",
      sessionManager: {
        createBranchedSession: (entryId: string) => {
          branchedAt = entryId;
          return forkedFile;
        },
      },
      getUserMessagesForForking: () => [{ entryId: "first-user" }, { entryId: "newest-user" }],
    });
    installTestHooks({ createAgentSession: async () => fake.session });
    const state = newSessionState();
    state.composer = {
      ...state.composer,
      selectedModelId: "available/actual",
      selectedReasoningId: "high",
    };

    const forked = await forkSession(state, undefined);
    expect(branchedAt).toBe("newest-user");
    expect(forked).not.toBe(state);
    expect(forked.sessionFile?.endsWith("forked.jsonl")).toBe(true);
    expect(forked.composer.selectedModelId).toBe("available/actual");
    expect(forked.composer.selectedReasoningId).toBe("high");

    const explicit = await forkSession(state, " first-user ");
    expect(branchedAt).toBe("first-user");
    expect(explicit).toBe(forked);
  });

  test("updates live model and thinking selections to what the session accepts", async () => {
    const fake = fakeSession();
    const nextModel = model("next", "selected");
    installTestHooks({
      createAgentSession: async () => fake.session,
      resolveModel: async () => nextModel,
    });
    const state = newSessionState();
    state.composer = {
      ...state.composer,
      selectedModelId: "stale/unavailable",
      selectedReasoningId: "max",
    };

    await ensureSession(state);
    expect(state.composer.selectedModelId).toBe("available/actual");
    applyComposerPatch(state, { modelId: "next/selected", reasoningId: "high" });
    await applyComposerToSession(state);

    expect(state.composer.selectedModelId).toBe("next/selected");
    expect(state.composer.selectedReasoningId).toBe("high");
    expect(fake.session.model).toBe(nextModel);
    expect(fake.session.thinkingLevel).toBe("high");
  });

  test("unsubscribes and disposes an attached session exactly once", async () => {
    const fake = fakeSession({
      promptTemplates: [{ name: "review", description: "Review files" }],
    });
    installTestHooks({ createAgentSession: async () => fake.session });
    const state = newSessionState();

    await ensureSession(state);
    expect(state.slashCommands).toEqual([{ name: "/review", description: "Review files" }]);
    state.status = "running";
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "subscribed output" },
    });
    expect(state.messages.at(-1)?.content).toBe("subscribed output");
    await detachSession(state);
    await detachSession(state);

    expect(fake.subscribed()).toBe(1);
    expect(fake.unsubscribed()).toBe(1);
    expect(fake.disposed()).toBe(1);
    expect(state.session).toBeNull();
  });

  test("supports a mocked create, attach and accepted prompt through completion", async () => {
    let finish: (() => void) | undefined;
    let promptedWith = "";
    const run = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fake = fakeSession({
      prompt: async (text: string, options: { preflightResult?: (accepted: boolean) => void }) => {
        promptedWith = text;
        options.preflightResult?.(true);
        await run;
      },
      abort: async () => undefined,
    });
    installTestHooks({ createAgentSession: async () => fake.session });
    const state = newSessionState();

    const attached = await ensureSession(state);
    state.status = "running";
    state.promptSequence = 1;
    state.currentTurnUsage = {};
    const handle = await dispatchPrompt(state, attached, {
      prompt: "ship the change",
      images: [],
      requestId: "req-happy",
    });

    expect(promptedWith).toBe("ship the change");
    expect(state.cancelTurn).toBeDefined();
    finish!();
    await handle.completion;
    expect(state.status).toBe("idle");
    expect(state.promptJournal.get("req-happy")?.state).toBe("completed");
  });
});
