/**
 * Switching branches with and without Pi's summary of the branch left, against
 * the fake engine: the real Pi SDK, its tree navigation, its branch
 * summarizer and its JSONL session files, with pi-ai's faux model standing in
 * for the provider (as in `compaction-controls.test.ts`). No credential, no
 * network call and no billed turn.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `config.ts` reads its environment once, at import; see `http.test.ts`.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;
const previousCwd = process.env.CWD;
const projectDirectory = await mkdtemp(join(tmpdir(), "pi-branch-switch-project-"));
process.env.CWD = projectDirectory;

const { server, start, shutdown } = await import("./server.js");
const { setCancelAckTimeoutForTests } = await import("./http.js");
const { authToken: TOKEN } = await import("./config.js");
const { closeSession, detachSession, resumeSession, setAgentSessionTestHooks } =
  await import("./agent-session.js");
const { refreshModels } = await import("./models.js");
const { setModelRuntimeFactoryForTests } = await import("./runtime.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { nativeFetch } = await import("./testing/native-fetch.js");
const { userPrompts } = await import("./testing/fake-engine-responses.js");
const { ModelRuntime, SessionManager } = await import("./pi-sdk.js");
const { fauxAssistantMessage, fauxProvider } = await import("@earendil-works/pi-ai");
const { parseBranchSwitchBody, setBranchSummaryTimeoutForTests } =
  await import("./branch-switch.js");
type AgentSession = import("@earendil-works/pi-coding-agent").AgentSession;

type SessionState = NonNullable<ReturnType<typeof sessions.get>>;
type FauxResponseFactory = import("@earendil-works/pi-ai").FauxResponseFactory;

const MODEL_ID = "faux/faux-1";
const SUMMARY_TEXT = "## Goal\nBranch summarized by the fake engine.";
/** What Pi puts in front of a branch summary in the model's context. */
const SUMMARY_CONTEXT_PREFIX = "The following is a summary of a branch";

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

afterEach(() => {
  setBranchSummaryTimeoutForTests();
  setCancelAckTimeoutForTests();
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

interface ModelCall {
  kind: "turn" | "summary";
  prompts: string[];
}

interface FakeEngine {
  state: SessionState;
  calls: ModelCall[];
  /** Hold every summary request until the bridge aborts it. */
  holdSummaries: (hold: boolean) => void;
  failSummary: (diagnostic: string) => void;
  holdNextAttach: (until: Promise<void>) => void;
  prompt: (text: string) => Promise<void>;
  /** The Pi entry id of the branch a rewind left, from the bridge's own list. */
  otherBranch: () => Promise<string>;
}

/**
 * One bridge session on the fake engine with two branches: `first`, then
 * `second` (left by a rewind), then `third` on the active branch.
 */
async function withTwoBranches(
  clientSessionKey: string,
  body: (engine: FakeEngine) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-branch-switch-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousSessionDir = process.env.PI_SESSION_DIR;
  process.env.PI_AGENT_DIR = directory;
  process.env.PI_SESSION_DIR = directory;
  const calls: ModelCall[] = [];
  let holdSummaries = false;
  let summaryDiagnostic: string | undefined;
  let state: SessionState | undefined;
  setAgentSessionTestHooks(undefined);
  try {
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", name: "Faux 1", contextWindow: 32_000 }],
    });
    const respond: FauxResponseFactory = async (context, requestOptions) => {
      faux.appendResponses([respond]);
      const prompts = userPrompts(context.messages);
      const last = prompts.at(-1) ?? "";
      const summary = /structured summary of this conversation branch/.test(last);
      calls.push({ kind: summary ? "summary" : "turn", prompts });
      if (!summary) return fauxAssistantMessage(`Answer to: ${last}`);
      if (summaryDiagnostic) {
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: summaryDiagnostic });
      }
      const signal = requestOptions?.signal;
      if (holdSummaries && signal && !signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return fauxAssistantMessage(SUMMARY_TEXT);
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

    const created = await post("/session/create", { clientSessionKey, modelId: MODEL_ID });
    expect(created.status).toBe(201);
    const current = sessions.get(((await created.json()) as { sessionId: string }).sessionId)!;
    state = current;
    const prompt = async (text: string) => {
      const prompted = await post(`/session/${current.id}/prompt`, { prompt: text });
      expect(prompted.status).toBe(202);
      await waitFor(
        () =>
          current.status === "idle" && current.promptClaim === undefined && !current.dispatching,
      );
    };
    await prompt("first");
    await prompt("second");
    const secondRow = current.messages.find(
      (row) => row.role === "user" && row.content === "second",
    );
    expect(secondRow).toBeDefined();
    const rewound = await post(`/session/${current.id}/rewind-messages`, {
      messageId: secondRow!.id,
    });
    expect(rewound.status).toBe(200);
    await prompt("third");
    calls.length = 0;
    await body({
      state: current,
      calls,
      prompt,
      holdSummaries: (hold) => {
        holdSummaries = hold;
      },
      failSummary: (diagnostic) => {
        summaryDiagnostic = diagnostic;
      },
      holdNextAttach: (until) => {
        setModelRuntimeFactoryForTests(async () => {
          await until;
          return runtime;
        });
      },
      otherBranch: async () => {
        const listed = (await (await call(`/session/${current.id}/branches`)).json()) as {
          branches: Array<{ entryId: string; prompt: string }>;
        };
        const branch = listed.branches.find((entry) => entry.prompt === "second");
        expect(branch).toBeDefined();
        return branch!.entryId;
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
    await rm(directory, { recursive: true, force: true });
  }
}

/** The `branch_summary` entries Pi wrote to the session's own JSONL file. */
async function summaryEntries(
  state: SessionState,
): Promise<Array<{ id: string; parentId: string; summary: string }>> {
  if (!state.sessionFile || !existsSync(state.sessionFile)) return [];
  return (await readFile(state.sessionFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { type?: string; id: string; parentId: string; summary: string },
    )
    .filter((entry) => entry.type === "branch_summary");
}

async function readStatus(state: SessionState): Promise<Record<string, unknown>> {
  const response = await call(`/session/${state.id}/status`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function renderedSummaryRows(state: SessionState): string[] {
  return state.messages
    .map((row) => row.content)
    .filter((content) => content.startsWith("Branch summary:"));
}

function pauseTreeHook(session: AgentSession, summary?: string) {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const runner = session.extensionRunner;
  const hasHandlers = runner.hasHandlers.bind(runner);
  spyOn(runner, "hasHandlers").mockImplementation(
    (event) => event === "session_before_tree" || hasHandlers(event),
  );
  const originalEmit = runner.emit.bind(runner);
  spyOn(runner, "emit").mockImplementation((async (event: Parameters<typeof originalEmit>[0]) => {
    if (event.type !== "session_before_tree") return originalEmit(event);
    entered.resolve();
    await gate.promise;
    return summary ? { summary: { summary } } : undefined;
  }) as typeof runner.emit);
  return { entered: entered.promise, release: gate.resolve };
}

describe("switching branches with a summary", () => {
  test("an ordinary switch makes no model call and writes no summary", async () => {
    await withTwoBranches("branch-switch-plain", async ({ state, calls, otherBranch }) => {
      const target = await otherBranch();
      const switched = await post(`/session/${state.id}/branches/${target}`);
      expect(switched.status).toBe(200);
      expect(await switched.json()).toEqual({ switched: true, summarized: false });
      expect(calls).toEqual([]);
      expect(await summaryEntries(state)).toEqual([]);
      expect(state.session!.sessionManager.getLeafId()).toBe(target);
      expect(renderedSummaryRows(state)).toEqual([]);
    });
  });

  test("an explicit summarize: false is an ordinary switch", async () => {
    await withTwoBranches("branch-switch-false", async ({ state, calls, otherBranch }) => {
      const target = await otherBranch();
      const switched = await post(`/session/${state.id}/branches/${target}`, { summarize: false });
      expect(switched.status).toBe(200);
      expect(await switched.json()).toEqual({ switched: true, summarized: false });
      expect(calls).toEqual([]);
      expect(await summaryEntries(state)).toEqual([]);
    });
  });

  test("a summarized switch keeps Pi's summary through a reload and into the next turn", async () => {
    await withTwoBranches(
      "branch-switch-summary",
      async ({ state, calls, otherBranch, prompt }) => {
        const target = await otherBranch();
        const switched = await post(`/session/${state.id}/branches/${target}`, {
          summarize: true,
        });
        expect(switched.status).toBe(200);
        expect(await switched.json()).toEqual({ switched: true, summarized: true });

        // One summary request, over the branch being left.
        expect(calls.map((entry) => entry.kind)).toEqual(["summary"]);
        expect(calls[0]!.prompts.join("\n")).toContain("third");

        // Pi wrote it as the new leaf, a child of the selected entry.
        const written = await summaryEntries(state);
        expect(written).toHaveLength(1);
        expect(written[0]!.parentId).toBe(target);
        expect(written[0]!.summary).toContain("Branch summarized by the fake engine.");
        const manager = state.session!.sessionManager;
        expect(manager.getLeafId()).toBe(written[0]!.id);
        expect(state.historyLeaf?.entryId).toBe(written[0]!.id);
        expect(renderedSummaryRows(state)).toHaveLength(1);
        expect(state.messages.map((row) => row.content)).toContain("second");
        expect(state.messages.map((row) => row.content)).not.toContain("third");

        // The file alone, as a restart reads it, ends on the summary.
        const reopened = SessionManager.open(state.sessionFile!, process.env.PI_SESSION_DIR!);
        expect(reopened.getLeafId()).toBe(written[0]!.id);

        // A reload: the bridge lets go of the session and resumes it from the file.
        const file = state.sessionFile!;
        await detachSession(state);
        sessions.delete(state.id);
        const resumed = await resumeSession(file, undefined);
        try {
          expect(renderedSummaryRows(resumed)).toHaveLength(1);
          expect(resumed.messages.map((row) => row.content)).toContain("second");
          expect(resumed.messages.map((row) => row.content)).not.toContain("third");
        } finally {
          await detachSession(resumed);
          sessions.delete(resumed.id);
        }
        sessions.set(state.id, state);

        // The next turn carries the summary in its context.
        await prompt("fourth");
        const turn = calls.at(-1)!;
        expect(turn.kind).toBe("turn");
        expect(turn.prompts.some((text) => text.startsWith(SUMMARY_CONTEXT_PREFIX))).toBe(true);
        expect(turn.prompts).toContain("second");
        expect(turn.prompts).not.toContain("third");
      },
    );
  });

  test("Stop during the summary leaves the conversation where it was and says so", async () => {
    await withTwoBranches(
      "branch-switch-stop",
      async ({ state, calls, otherBranch, holdSummaries, prompt }) => {
        const target = await otherBranch();
        const leafBefore = state.session!.sessionManager.getLeafId();
        const rowsBefore = state.messages.map((row) => row.content);
        holdSummaries(true);
        const switching = post(`/session/${state.id}/branches/${target}`, { summarize: true });
        await waitFor(() => calls.some((entry) => entry.kind === "summary"));

        // The summary is work the user can stop: it reports as running.
        expect((await readStatus(state)).status).toBe("running");
        const prompted = await post(`/session/${state.id}/prompt`, { prompt: "too soon" });
        expect(prompted.status).toBe(409);

        const cancelled = await post(`/session/${state.id}/cancel`);
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toEqual({ cancelled: true });

        const answer = await switching;
        expect(answer.status).toBe(409);
        expect(await answer.json()).toEqual({
          error: expect.stringContaining("stopped before Pi finished the summary"),
          cancelled: true,
          reason: "cancelled",
        });
        expect(state.session!.sessionManager.getLeafId()).toBe(leafBefore);
        expect(await summaryEntries(state)).toEqual([]);
        expect(state.messages.map((row) => row.content)).toEqual(rowsBefore);
        expect((await readStatus(state)).status).toBe("idle");
        expect(state.branchSummary).toBeUndefined();
        expect(state.dispatching).toBe(false);

        // Not wedged: a turn and a later summarized switch both run.
        holdSummaries(false);
        await prompt("after the stop");
        const again = await post(`/session/${state.id}/branches/${target}`, { summarize: true });
        expect(again.status).toBe(200);
        expect(await again.json()).toEqual({ switched: true, summarized: true });
        expect(await summaryEntries(state)).toHaveLength(1);
      },
    );
  });

  test("a summary that outlasts the bridge's bound stops the switch as a timeout", async () => {
    await withTwoBranches(
      "branch-switch-timeout",
      async ({ state, calls, otherBranch, holdSummaries }) => {
        const target = await otherBranch();
        const leafBefore = state.session!.sessionManager.getLeafId();
        holdSummaries(true);
        setBranchSummaryTimeoutForTests(50);
        const answer = await post(`/session/${state.id}/branches/${target}`, { summarize: true });
        expect(answer.status).toBe(409);
        expect(await answer.json()).toEqual({
          error: expect.stringContaining("took too long"),
          cancelled: true,
          reason: "timeout",
        });
        expect(calls.map((entry) => entry.kind)).toEqual(["summary"]);
        expect(state.session!.sessionManager.getLeafId()).toBe(leafBefore);
        expect(await summaryEntries(state)).toEqual([]);
      },
    );
  });

  test.each(["cancelled", "timeout"] as const)(
    "auth preparation rejection reports %s",
    async (reason) => {
      await withTwoBranches(`branch-auth-${reason}`, async ({ state, calls, otherBranch }) => {
        const target = await otherBranch();
        const session = state.session!;
        const leaf = session.sessionManager.getLeafId();
        const authEntered = Promise.withResolvers<void>();
        // The normal faux runtime supplies its own stream function, so inject
        // the abortable SDK preparation step before that stream starts.
        const sdk = session as unknown as {
          _getSummarizationRequestAuth(model: unknown, signal: AbortSignal): Promise<never>;
        };
        spyOn(sdk, "_getSummarizationRequestAuth").mockImplementation(async (_model, signal) => {
          authEntered.resolve();
          return new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        });
        if (reason === "timeout") setBranchSummaryTimeoutForTests(50);
        const switching = post(`/session/${state.id}/branches/${target}`, { summarize: true });
        await authEntered.promise;
        if (reason === "cancelled") {
          const stop = await post(`/session/${state.id}/cancel`);
          expect(stop.status).toBe(200);
          expect(await stop.json()).toEqual({ cancelled: true });
        }
        const answer = await switching;
        expect(answer.status).toBe(409);
        expect(await answer.json()).toMatchObject({ cancelled: true, reason });
        expect(session.sessionManager.getLeafId()).toBe(leaf);
        expect(calls).toEqual([]);
      });
    },
  );

  test.each(["cancelled", "timeout"] as const)(
    "a late extension summary cannot commit after %s",
    async (reason) => {
      await withTwoBranches(
        `branch-late-extension-${reason}`,
        async ({ state, calls, otherBranch }) => {
          const target = await otherBranch();
          const leaf = state.session!.sessionManager.getLeafId();
          const hook = pauseTreeHook(state.session!, SUMMARY_TEXT);
          setCancelAckTimeoutForTests(10);
          if (reason === "timeout") setBranchSummaryTimeoutForTests(50);
          const switching = post(`/session/${state.id}/branches/${target}`, { summarize: true });
          try {
            await hook.entered;
            if (reason === "cancelled") {
              const stop = await post(`/session/${state.id}/cancel`);
              expect(stop.status).toBe(202);
              expect(await stop.json()).toEqual({ cancelled: false, pending: true });
            } else {
              await waitFor(() => state.branchSummary?.stopReason === "timeout");
            }
            expect((await readStatus(state)).status).toBe("running");
          } finally {
            hook.release();
          }
          const answer = await switching;
          expect(answer.status).toBe(409);
          expect(await answer.json()).toMatchObject({ cancelled: true, reason });
          expect(state.session!.sessionManager.getLeafId()).toBe(leaf);
          expect(await summaryEntries(state)).toEqual([]);
          expect(calls).toEqual([]);
        },
      );
    },
  );

  test("Stop during cold attach prevents navigation after the session attaches", async () => {
    await withTwoBranches(
      "branch-stop-cold-attach",
      async ({ state, calls, otherBranch, holdNextAttach }) => {
        const target = await otherBranch();
        const leaf = state.session!.sessionManager.getLeafId();
        await detachSession(state);
        const attach = Promise.withResolvers<void>();
        holdNextAttach(attach.promise);
        setCancelAckTimeoutForTests(10);
        const switching = post(`/session/${state.id}/branches/${target}`, { summarize: true });
        try {
          await waitFor(() => state.attaching !== undefined && state.branchSummary !== undefined);
          const stop = await post(`/session/${state.id}/cancel`);
          expect(stop.status).toBe(202);
          expect(await stop.json()).toEqual({ cancelled: false, pending: true });
        } finally {
          attach.resolve();
        }
        const answer = await switching;
        expect(answer.status).toBe(409);
        expect(await answer.json()).toMatchObject({ cancelled: true, reason: "cancelled" });
        expect(state.session!.sessionManager.getLeafId()).toBe(leaf);
        expect(calls).toEqual([]);
      },
    );
  });

  test("a failed summary write leaves the source leaf, context and next prompt parent intact", async () => {
    await withTwoBranches(
      "branch-summary-write-failed",
      async ({ state, calls, otherBranch, prompt }) => {
        const target = await otherBranch();
        const manager = state.session!.sessionManager;
        const leaf = manager.getLeafId();
        const rows = state.messages.map((row) => row.content);
        const file = state.sessionFile!;
        const backup = `${file}.test-backup`;
        await rename(file, backup);
        await mkdir(file);
        try {
          const answer = await post(`/session/${state.id}/branches/${target}`, { summarize: true });
          expect(answer.status).toBe(422);
          expect(await answer.json()).toMatchObject({ kind: "branch-summary-failed" });
          expect(manager.getLeafId()).toBe(leaf);
          // The bridge appends a write-loss advisory without changing the
          // conversation rows that were already rendered.
          expect(state.messages.slice(0, rows.length).map((row) => row.content)).toEqual(rows);
          expect(renderedSummaryRows(state)).toEqual([]);
        } finally {
          await rm(file, { recursive: true });
          await rename(backup, file);
        }
        await prompt("after failed write");
        const nextPrompt = manager
          .getEntries()
          .findLast((entry) => entry.type === "message" && entry.message.role === "user");
        expect(nextPrompt?.parentId).toBe(leaf);
        expect(calls.at(-1)?.prompts).toContain("after failed write");
        expect(calls.at(-1)?.prompts).toContain("third");
        expect(calls.at(-1)?.prompts).not.toContain("second");
        expect(await summaryEntries(state)).toEqual([]);
      },
    );
  });

  test("a provider diagnostic stays out of the bridge error", async () => {
    await withTwoBranches(
      "branch-provider-diagnostic",
      async ({ state, calls, otherBranch, failSummary }) => {
        const target = await otherBranch();
        const leaf = state.session!.sessionManager.getLeafId();
        failSummary("Provider refused request with synthetic-sensitive-marker");
        const answer = await post(`/session/${state.id}/branches/${target}`, { summarize: true });
        expect(answer.status).toBe(422);
        const body = await answer.text();
        expect(body).toContain("could not summarize");
        expect(body).not.toContain("synthetic-sensitive-marker");
        expect(calls.some((call) => call.kind === "summary")).toBe(true);
        expect(state.session!.sessionManager.getLeafId()).toBe(leaf);
      },
    );
  });

  test("navigation refuses to enter Pi during an active command reload", async () => {
    await withTwoBranches("branch-during-reload", async ({ state, otherBranch }) => {
      const target = await otherBranch();
      const session = state.session!;
      const navigate = spyOn(session, "navigateTree");
      const gate = Promise.withResolvers<void>();
      spyOn(session, "reload").mockImplementation(() => gate.promise);
      const refresh = post(`/session/${state.id}/commands/refresh`);
      try {
        await waitFor(() => state.commandReload !== undefined);
        const answer = await post(`/session/${state.id}/branches/${target}`, { summarize: true });
        expect(answer.status).toBe(409);
        expect(navigate).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        await refresh;
      }
    });
  });

  test("rewind drains the command refresh it deferred", async () => {
    await withTwoBranches("rewind-drains-reload", async ({ state }) => {
      const session = state.session!;
      const row = state.messages.find((message) => message.content === "third")!;
      const hook = pauseTreeHook(session);
      const reload = spyOn(session, "reload").mockImplementation(async () => {});
      const rewinding = post(`/session/${state.id}/rewind-messages`, { messageId: row.id });
      try {
        await hook.entered;
        const refresh = await post(`/session/${state.id}/commands/refresh`);
        expect(await refresh.json()).toMatchObject({ outcome: "deferred" });
        expect(state.commandCatalogue.status).toBe("stale");
        expect(state.commandReloadPending).toBe(true);
        expect(reload).not.toHaveBeenCalled();
      } finally {
        hook.release();
      }
      expect((await rewinding).status).toBe(200);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(state.commandCatalogue.status).toBe("ready");
      expect(state.commandReloadPending).toBe(false);
    });
  });

  test("a branch ending on a prompt with no reply is refused before any model call", async () => {
    await withTwoBranches("branch-switch-prompt-leaf", async ({ state, calls }) => {
      const session = state.session!;
      const manager = session.sessionManager;
      const active = manager.getLeafId()!;
      const prompt = manager.appendMessage({ role: "user", content: "unanswered", timestamp: 0 });
      manager.branch(active);
      session.refreshContext();

      const refused = await post(`/session/${state.id}/branches/${prompt}`, { summarize: true });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({
        error: expect.stringContaining("Switch without a summary"),
        kind: "branch-summary-failed",
        reason: "prompt-leaf",
      });
      expect(calls).toEqual([]);
      expect(manager.getLeafId()).toBe(active);
      expect(state.dispatching).toBe(false);
      expect(state.branchSummary).toBeUndefined();

      // Without a summary the same switch keeps the prompt, as before.
      const switched = await post(`/session/${state.id}/branches/${prompt}`);
      expect(switched.status).toBe(200);
      expect(manager.getLeafId()).toBe(prompt);
    });
  });

  test("a malformed body is refused before anything moves", async () => {
    await withTwoBranches("branch-switch-bad-body", async ({ state, calls, otherBranch }) => {
      const target = await otherBranch();
      const leafBefore = state.session!.sessionManager.getLeafId();
      const refused = await post(`/session/${state.id}/branches/${target}`, { summarize: "yes" });
      expect(refused.status).toBe(400);
      expect(calls).toEqual([]);
      expect(state.session!.sessionManager.getLeafId()).toBe(leafBefore);
    });
  });
});

describe("parseBranchSwitchBody", () => {
  test("no body, an empty body and summarize: false are an ordinary switch", () => {
    expect(parseBranchSwitchBody(undefined)).toEqual({ ok: true, summarize: false });
    expect(parseBranchSwitchBody({})).toEqual({ ok: true, summarize: false });
    expect(parseBranchSwitchBody({ summarize: false })).toEqual({ ok: true, summarize: false });
  });

  test("only a boolean true asks for a summary", () => {
    expect(parseBranchSwitchBody({ summarize: true })).toEqual({ ok: true, summarize: true });
    expect(parseBranchSwitchBody({ summarize: "true" }).ok).toBe(false);
    expect(parseBranchSwitchBody([]).ok).toBe(false);
    expect(parseBranchSwitchBody("summarize").ok).toBe(false);
  });
});
