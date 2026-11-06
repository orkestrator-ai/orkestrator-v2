/**
 * Stopping a compaction and the auto-compaction toggle, against the fake
 * engine: the real Pi SDK, its agent loop, its compaction and its JSONL
 * session files, with pi-ai's faux model (the one `testing/fake-engine-server.ts`
 * serves) standing in for the provider. No credential, no network call and no
 * billed turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentModel } from "@orkestrator/protocol/native-agent";

// `config.ts` reads its environment once, at import; see `http.test.ts`.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;
const previousCwd = process.env.CWD;
const projectDirectory = await mkdtemp(join(tmpdir(), "pi-compaction-project-"));
process.env.CWD = projectDirectory;

const { server, start, shutdown } = await import("./server.js");
const { authToken: TOKEN } = await import("./config.js");
const { closeSession, setAgentSessionTestHooks } = await import("./agent-session.js");
const { refreshModels } = await import("./models.js");
const { setModelRuntimeFactoryForTests } = await import("./runtime.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { nativeFetch } = await import("./testing/native-fetch.js");
const { userPrompts } = await import("./testing/fake-engine-responses.js");
const { ModelRuntime, SettingsManager } = await import("./pi-sdk.js");
const { fauxAssistantMessage, fauxProvider } = await import("@earendil-works/pi-ai");
const {
  AUTO_COMPACTION_PARAMETER_ID,
  COMPACTION_CANCELLED_MESSAGE,
  installAutoCompactionOverride,
} = await import("./compaction-controls.js");

type SessionState = NonNullable<ReturnType<typeof sessions.get>>;
type FauxResponseFactory = import("@earendil-works/pi-ai").FauxResponseFactory;

const MODEL_ID = "faux/faux-1";

let origin: string;

beforeAll(async () => {
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await shutdown();
  if (previousCwd === undefined) delete process.env.CWD;
  else process.env.CWD = previousCwd;
  await rm(projectDirectory, { recursive: true, force: true });
});

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return nativeFetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

function post(path: string, body?: unknown): Promise<Response> {
  return call(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** What the faux model was asked, in order. */
interface ModelCall {
  kind: "turn" | "summary";
  prompts: string[];
}

interface FakeEngine {
  state: SessionState;
  calls: ModelCall[];
  /** Hold the next summary request until the bridge aborts it. */
  holdSummaries: (hold: boolean) => void;
  prompt: (text: string) => Promise<void>;
  settingsFile: string;
}

/**
 * One bridge session on the fake engine, in its own agent and session
 * directory. `settings` becomes Pi's `settings.json` there, which is how a
 * test sets a tiny compaction threshold without a large conversation.
 */
async function withFakeEngine(
  options: {
    clientSessionKey: string;
    settings: Record<string, unknown>;
    projectSettings?: Record<string, unknown>;
  },
  body: (engine: FakeEngine) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-compaction-controls-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousSessionDir = process.env.PI_SESSION_DIR;
  process.env.PI_AGENT_DIR = directory;
  process.env.PI_SESSION_DIR = directory;
  const settingsFile = join(directory, "settings.json");
  await writeFile(settingsFile, JSON.stringify(options.settings));
  if (options.projectSettings) {
    await mkdir(join(projectDirectory, ".pi"), { recursive: true });
    await writeFile(
      join(projectDirectory, ".pi/settings.json"),
      JSON.stringify(options.projectSettings),
    );
  }
  const calls: ModelCall[] = [];
  let holdSummaries = false;
  let state: SessionState | undefined;
  setAgentSessionTestHooks(undefined);
  try {
    // The fake engine's model: one faux provider with a small context window,
    // so Pi's compaction threshold is reachable from a short conversation.
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", name: "Faux 1", contextWindow: 32_000 }],
    });
    const respond: FauxResponseFactory = async (context, requestOptions) => {
      faux.appendResponses([respond]);
      const prompts = userPrompts(context.messages);
      const last = prompts.at(-1) ?? "";
      // Pi's summary requests carry the conversation and the instructions as
      // one user message; every one of them asks for a checkpoint.
      const summary = /context checkpoint|concise checkpoint/.test(last);
      calls.push({ kind: summary ? "summary" : "turn", prompts });
      if (!summary) return fauxAssistantMessage(`Answer to: ${last}`);
      const signal = requestOptions?.signal;
      if (holdSummaries && signal && !signal.aborted) {
        // A summary request that never answers: the "stuck compaction" a
        // user needs Stop for. Released only by the abort.
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return fauxAssistantMessage("## Goal\nSummarized by the fake engine.");
    };
    faux.setResponses([respond]);
    const runtime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: join(directory, "models.json"),
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey("faux", "fake-engine-no-provider-requests");
    setModelRuntimeFactoryForTests(async () => runtime);
    refreshModels();

    const created = await post("/session/create", {
      clientSessionKey: options.clientSessionKey,
      modelId: MODEL_ID,
    });
    expect(created.status).toBe(201);
    const current = sessions.get(((await created.json()) as { sessionId: string }).sessionId)!;
    state = current;
    await body({
      state: current,
      calls,
      settingsFile,
      holdSummaries: (hold) => {
        holdSummaries = hold;
      },
      prompt: async (text) => {
        const prompted = await post(`/session/${current.id}/prompt`, { prompt: text });
        expect(prompted.status).toBe(202);
        await waitFor(
          () =>
            current.status === "idle" &&
            current.promptClaim === undefined &&
            !current.compacting &&
            !current.dispatching,
        );
      },
    });
  } finally {
    if (state) {
      await closeSession(state);
      sessions.delete(state.id);
      if (state.clientSessionKey) clientSessionKeys.delete(state.clientSessionKey);
    }
    setAgentSessionTestHooks(undefined);
    setModelRuntimeFactoryForTests();
    refreshModels();
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_SESSION_DIR;
    else process.env.PI_SESSION_DIR = previousSessionDir;
    await rm(join(projectDirectory, ".pi"), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

/** Compaction entries Pi wrote to the session's own JSONL file. */
async function compactionEntries(state: SessionState): Promise<number> {
  if (!state.sessionFile || !existsSync(state.sessionFile)) return 0;
  const lines = (await readFile(state.sessionFile, "utf8")).split("\n").filter(Boolean);
  return lines.filter((line) => (JSON.parse(line) as { type?: unknown }).type === "compaction")
    .length;
}

async function readStatus(state: SessionState): Promise<Record<string, unknown>> {
  const response = await call(`/session/${state.id}/status`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function readConfig(state: SessionState): Promise<{
  models: AgentModel[];
  parameterValues?: Record<string, string | boolean>;
}> {
  const response = await call(`/session/${state.id}/config`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    models: AgentModel[];
    parameterValues?: Record<string, string | boolean>;
  };
}

// Manual compaction only: auto-compaction is off so the turns that build the
// conversation do not compact it first.
const MANUAL_ONLY = { compaction: { enabled: false, keepRecentTokens: 1 } };

describe("stopping a compaction", () => {
  test("Stop ends a manual compaction whose summary never answers", async () => {
    await withFakeEngine(
      { clientSessionKey: "compaction-stop", settings: MANUAL_ONLY },
      async ({ state, calls, holdSummaries, prompt }) => {
        await prompt("first question");
        await prompt("second question");
        holdSummaries(true);

        const compacting = post(`/session/${state.id}/compact`);
        await waitFor(() => calls.some((entry) => entry.kind === "summary"));
        // A manual compaction owns no prompt claim; it still reports as
        // running, with its activity, so the tab offers Stop.
        const busy = await readStatus(state);
        expect(busy.status).toBe("running");
        expect(busy.activity).toBe("compacting");

        const cancelled = await post(`/session/${state.id}/cancel`);
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toEqual({ cancelled: true });

        const answer = await compacting;
        expect(answer.status).toBe(409);
        expect(await answer.json()).toEqual({
          error: COMPACTION_CANCELLED_MESSAGE,
          cancelled: true,
        });
        expect(await compactionEntries(state)).toBe(0);
        const idle = await readStatus(state);
        expect(idle.status).toBe("idle");
        expect(idle.activity).toBeUndefined();
        expect(state.manualCompaction).toBeUndefined();

        // Not wedged: the next turn and the next compaction both run.
        holdSummaries(false);
        await prompt("third question");
        const again = await post(`/session/${state.id}/compact`);
        expect(again.status).toBe(200);
        expect(await again.json()).toEqual({ compacted: true });
        expect(await compactionEntries(state)).toBe(1);
      },
    );
  });

  test("a cancel that lands before Pi starts compacting stops it without a summary request", async () => {
    await withFakeEngine(
      { clientSessionKey: "compaction-stop-early", settings: MANUAL_ONLY },
      async ({ state, calls, prompt }) => {
        await prompt("first question");
        await prompt("second question");
        const before = calls.length;
        // Pi's `compact()` aborts the current operation before it creates
        // its own abort controller; a cancel inside that window reaches no
        // controller and has to be applied on `compaction_start`.
        const session = state.session!;
        const abort = session.abort.bind(session);
        let cancel: Promise<Response> | undefined;
        session.abort = async () => {
          cancel ??= post(`/session/${state.id}/cancel`);
          await waitFor(() => state.manualCompaction?.cancelRequested === true);
          return abort();
        };
        try {
          const answer = await post(`/session/${state.id}/compact`);
          expect(answer.status).toBe(409);
          expect(((await answer.json()) as { cancelled?: unknown }).cancelled).toBe(true);
        } finally {
          session.abort = abort;
        }
        expect(cancel).toBeDefined();
        expect(await (await cancel!).json()).toEqual({ cancelled: true });
        expect(calls.slice(before).filter((entry) => entry.kind === "summary")).toEqual([]);
        expect(await compactionEntries(state)).toBe(0);
      },
    );
  });

  test("a cancel with nothing compacting still answers that nothing was cancelled", async () => {
    await withFakeEngine(
      { clientSessionKey: "compaction-stop-idle", settings: MANUAL_ONLY },
      async ({ state, prompt }) => {
        await prompt("first question");
        const cancelled = await post(`/session/${state.id}/cancel`);
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toEqual({ cancelled: false });
      },
    );
  });
});

// A threshold every turn crosses: Pi's system prompt alone is over a thousand
// tokens, and the faux model's window is 32 000.
const LOW_THRESHOLD = { compaction: { reserveTokens: 31_000, keepRecentTokens: 1 } };

describe("auto-compaction toggle", () => {
  for (const enabled of [true, false]) {
    test(`attachment ignores untrusted project settings when the saved default is ${enabled}`, async () => {
      await withFakeEngine(
        {
          clientSessionKey: `auto-compaction-trust-${enabled}`,
          settings: { compaction: { enabled } },
          projectSettings: { compaction: { enabled: !enabled } },
        },
        async ({ state, prompt }) => {
          expect(state.policy?.projectResources).toBe(false);
          expect((await readConfig(state)).parameterValues?.[AUTO_COMPACTION_PARAMETER_ID]).toBe(
            enabled,
          );
          await prompt("attach with untrusted project settings");
          expect(state.session!.autoCompactionEnabled).toBe(enabled);
          const config = await readConfig(state);
          expect(config.parameterValues?.[AUTO_COMPACTION_PARAMETER_ID]).toBe(
            state.session!.autoCompactionEnabled,
          );
          expect(
            config.models[0]?.parameters?.find(
              (parameter) => parameter.id === AUTO_COMPACTION_PARAMETER_ID,
            )?.defaultValue,
          ).toBe(enabled);
        },
      );
    });
  }

  test("resume publishes the saved default before attaching or prompting", async () => {
    await withFakeEngine(
      { clientSessionKey: "auto-compaction-resume", settings: MANUAL_ONLY },
      async ({ state, prompt }) => {
        await prompt("create a persisted conversation");
        const sessionFile = state.sessionFile;
        await closeSession(state);
        sessions.delete(state.id);
        const response = await post("/session/resume", { sessionId: sessionFile });
        expect(response.status).toBe(201);
        const resumed = sessions.get(((await response.json()) as { sessionId: string }).sessionId)!;
        try {
          expect(resumed.session).toBeNull();
          expect(resumed.autoCompaction).toBeUndefined();
          expect(resumed.composer.models.length).toBeGreaterThan(0);
          expect((await readConfig(resumed)).parameterValues?.[AUTO_COMPACTION_PARAMETER_ID]).toBe(
            false,
          );
          const status = await readStatus(resumed);
          expect(
            (status.composer as { parameterValues?: Record<string, unknown> }).parameterValues?.[
              AUTO_COMPACTION_PARAMETER_ID
            ],
          ).toBe(false);
          expect(resumed.session).toBeNull();
        } finally {
          await closeSession(resumed);
          sessions.delete(resumed.id);
        }
      },
    );
  });

  test("every model offers the toggle, defaulting to Pi's own setting", async () => {
    await withFakeEngine(
      { clientSessionKey: "auto-compaction-default", settings: MANUAL_ONLY },
      async ({ state }) => {
        const config = await readConfig(state);
        expect(config.models.length).toBeGreaterThan(0);
        for (const model of config.models) {
          expect(model.parameters).toContainEqual({
            id: AUTO_COMPACTION_PARAMETER_ID,
            label: "Auto-compact",
            kind: "toggle",
            defaultValue: false,
            scope: "session",
          });
        }
        expect(config.parameterValues?.[AUTO_COMPACTION_PARAMETER_ID]).toBe(false);
      },
    );
  });

  test("off stops Pi compacting on its own, on turns it back on, and Pi's settings file is untouched", async () => {
    await withFakeEngine(
      { clientSessionKey: "auto-compaction-toggle", settings: LOW_THRESHOLD },
      async ({ state, calls, prompt, settingsFile }) => {
        expect((await readConfig(state)).parameterValues?.[AUTO_COMPACTION_PARAMETER_ID]).toBe(
          true,
        );
        const off = await post(`/session/${state.id}/config`, {
          parameterValues: { [AUTO_COMPACTION_PARAMETER_ID]: false },
        });
        expect(off.status).toBe(200);
        expect(
          ((await off.json()) as { parameterValues?: Record<string, unknown> }).parameterValues?.[
            AUTO_COMPACTION_PARAMETER_ID
          ],
        ).toBe(false);

        await prompt("first question");
        await prompt("second question");
        await prompt("third question");
        expect(state.session!.autoCompactionEnabled).toBe(false);
        expect(calls.filter((entry) => entry.kind === "summary")).toEqual([]);
        expect(await compactionEntries(state)).toBe(0);

        // On again, from a prompt's own parameters as the backend sends them.
        const prompted = await post(`/session/${state.id}/prompt`, {
          prompt: "fourth question",
          parameterValues: { [AUTO_COMPACTION_PARAMETER_ID]: true },
        });
        expect(prompted.status).toBe(202);
        await waitFor(() => calls.some((entry) => entry.kind === "summary"));
        await waitFor(
          () => state.status === "idle" && state.promptClaim === undefined && !state.compacting,
        );
        expect(state.session!.autoCompactionEnabled).toBe(true);
        expect(await compactionEntries(state)).toBeGreaterThan(0);
        // The toggle never reaches Pi's account-wide file. (Attaching writes
        // the steering and follow-up modes there, which is older behaviour.)
        const settingsAfter = JSON.parse(await readFile(settingsFile, "utf8")) as {
          compaction?: unknown;
        };
        expect(settingsAfter.compaction).toEqual(LOW_THRESHOLD.compaction);
      },
    );
  });
});

describe("installAutoCompactionOverride", () => {
  test("holds across the settings manager's own save, and follows the choice live", () => {
    const settings = SettingsManager.inMemory({ compaction: { enabled: true } });
    let choice: boolean | undefined = false;
    expect(installAutoCompactionOverride(settings, () => choice)).toBe(true);
    expect(settings.getCompactionEnabled()).toBe(false);
    // `save()` recomputes the merged settings, which would drop an
    // `applyOverrides` patch; the override is on the reader instead.
    settings.setTransport("sse");
    expect(settings.getCompactionSettings(undefined).enabled).toBe(false);
    choice = true;
    expect(settings.getCompactionEnabled()).toBe(true);
    choice = undefined;
    settings.setCompactionEnabled(false);
    expect(settings.getCompactionEnabled()).toBe(false);
  });
});
