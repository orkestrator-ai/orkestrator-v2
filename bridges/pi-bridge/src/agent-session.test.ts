import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  applyComposerPatch,
  applyComposerToSession,
  closeSession,
  createSession,
  detachSession,
  ensureSession,
  expireComposerHydrationRetryForTests,
  forkSession,
  hydrateSessionComposer,
  newSessionState,
  projectResourceDiscoveryOptions,
  resumeSession,
  sessionManagerFor,
  setAgentSessionTestHooks,
  type AgentSessionTestHooks,
} from "./agent-session.js";
import { workingDirectory } from "./config.js";
import { catalogReadFailed, refreshModels } from "./models.js";
import { dispatchPrompt } from "./prompt.js";
import { setModelRuntimeFactoryForTests } from "./runtime.js";
import { clientSessionKeys, sessionCreations, sessions, type SessionState } from "./state.js";

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
  // Restores the real SDK factory and drops both the catalogue memo and the
  // failed-read verdict derived from whatever fake a test installed.
  setModelRuntimeFactoryForTests();
  refreshModels();
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

/**
 * Install a runtime the real catalogue path can read, or fail against.
 *
 * Tests that need the *failed read* verdict cannot use the `hydrateComposer`
 * hook: the verdict is produced by `listModels`, which the hook replaces.
 */
function installRuntimeWithModels(available: Model<Api>[] | Error): void {
  setModelRuntimeFactoryForTests(
    async () =>
      ({
        getProviders: () => [],
        hasConfiguredAuth: () => true,
        checkAuth: async () => ({ source: "environment", type: "api_key" }),
        getAvailable: async () => {
          if (available instanceof Error) throw available;
          return available;
        },
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

describe("composer hydration", () => {
  /** A composer carrying the rows a catalogue read would have produced. */
  function hydratedComposer(
    composer: SessionState["composer"],
    ids: string[],
  ): SessionState["composer"] {
    return {
      ...composer,
      models: ids.map((id) => ({
        platform: "pi" as const,
        id,
        label: id,
        defaultReasoningId: "medium",
      })),
      selectedModelId: composer.selectedModelId ?? ids[0],
      selectedReasoningId: composer.selectedReasoningId ?? "medium",
      fastModeAvailable: false,
    };
  }

  test("keeps a selection recorded while the catalogue read was in flight", async () => {
    // The read is unbounded and nothing serializes it against the other
    // composer writers. Assigning the object it was derived from would revert
    // whatever landed meanwhile — here the user's own model pick, but in
    // production also the attach-time reconciliation that stops the picker
    // naming a model the turn is not running.
    let release: (() => void) | undefined;
    installTestHooks({
      hydrateComposer: async (composer) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return hydratedComposer(composer, ["provider/from-catalogue"]);
      },
    });
    const state = newSessionState();

    const hydration = hydrateSessionComposer(state);
    await Promise.resolve();
    expect(applyComposerPatch(state, { modelId: "provider/chosen-meanwhile" })).toBe(true);
    release!();
    await hydration;

    expect(state.composer.selectedModelId).toBe("provider/chosen-meanwhile");
    expect(state.composer.models.map((entry) => entry.id)).toEqual(["provider/from-catalogue"]);
  });

  test("shares one probe across the backend's concurrent projection reads", async () => {
    let hydrations = 0;
    let release: (() => void) | undefined;
    installTestHooks({
      hydrateComposer: async (composer) => {
        hydrations += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return hydratedComposer(composer, ["provider/one"]);
      },
    });
    const state = newSessionState();

    const reads = [
      hydrateSessionComposer(state),
      hydrateSessionComposer(state),
      hydrateSessionComposer(state),
    ];
    await Promise.resolve();
    expect(hydrations).toBe(1);
    release!();
    await Promise.all(reads);

    expect(hydrations).toBe(1);
    expect(state.composer.models).toHaveLength(1);
  });

  test("does not probe again once the session already has rows", async () => {
    let hydrations = 0;
    installTestHooks({
      hydrateComposer: async (composer) => {
        hydrations += 1;
        return hydratedComposer(composer, ["provider/one"]);
      },
    });
    const state = newSessionState();

    await hydrateSessionComposer(state);
    await hydrateSessionComposer(state);
    await hydrateSessionComposer(state);

    expect(hydrations).toBe(1);
  });

  test("suppresses retries after an empty read until the deadline passes", async () => {
    // Empty is retryable — a provider signed into later must be able to appear
    // — but not on every 500ms projection poll.
    let hydrations = 0;
    installTestHooks({
      hydrateComposer: async (composer) => {
        hydrations += 1;
        return composer;
      },
    });
    const state = newSessionState();

    await hydrateSessionComposer(state);
    await hydrateSessionComposer(state);
    expect(hydrations).toBe(1);

    expireComposerHydrationRetryForTests(state);
    await hydrateSessionComposer(state);
    expect(hydrations).toBe(2);
  });

  test("a forced refresh re-reads instead of adopting an in-flight probe", async () => {
    // The in-flight read started before `/global/refresh-catalog` dropped the
    // catalogue, so it answers with exactly the rows the refresh was asked to
    // replace. Adopting it would also give the session models, which is the
    // condition that stops every later unforced hydration — leaving the tab
    // stale until the user refreshed a second time.
    let hydrations = 0;
    let release: (() => void) | undefined;
    installTestHooks({
      hydrateComposer: async (composer) => {
        hydrations += 1;
        if (hydrations === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return hydratedComposer(composer, ["provider/before"]);
        }
        return hydratedComposer(composer, ["provider/after"]);
      },
    });
    const state = newSessionState();

    const polled = hydrateSessionComposer(state);
    await Promise.resolve();
    const forced = hydrateSessionComposer(state, { force: true });
    release!();
    await Promise.all([polled, forced]);

    expect(hydrations).toBe(2);
    expect(state.composer.models.map((entry) => entry.id)).toEqual(["provider/after"]);
  });

  test("a forced refresh clears the rows when the account really has none", async () => {
    installRuntimeWithModels([]);
    installTestHooks({ hydrateComposer: undefined });
    const state = newSessionState();
    state.composer = hydratedComposer(state.composer, ["provider/stale"]);

    await hydrateSessionComposer(state, { force: true });

    expect(state.composer.models).toEqual([]);
  });

  test("a forced refresh keeps the rows when the catalogue read merely failed", async () => {
    // `listModels` answers a failed probe with `[]` once the refresh route has
    // dropped the cache that would otherwise have absorbed it. Emptying a
    // working picker because a provider timed out is worse than one stale
    // retry interval, and the user cannot tell the two apart from the UI.
    installRuntimeWithModels(new Error("Pi catalogue read timed out"));
    installTestHooks({ hydrateComposer: undefined });
    const state = newSessionState();
    state.composer = hydratedComposer(state.composer, ["provider/stale"]);

    await hydrateSessionComposer(state, { force: true });

    expect(catalogReadFailed()).toBe(true);
    expect(state.composer.models.map((entry) => entry.id)).toEqual(["provider/stale"]);
  });
});
