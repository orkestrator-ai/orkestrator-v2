import { createNativeAgentProvider } from "./native-agent-provider.js";
import { describe, expect, mock, test } from "bun:test";
import type { UsageLimitStopVerdict } from "@orkestrator/protocol/agent-account-auto-switch";
import {
  NativeAgentUsageLimitResend,
  USAGE_LIMIT_CANDIDATE_MAX_MS,
  type NativeAgentUsageLimitResendDependencies,
} from "./native-agent-usage-limit-resend.js";
import type { PersistedNativeAgentSession } from "./native-agent-service-shared.js";

const LIMIT = "You've hit your limit · resets 3pm";

function sessionWith(
  overrides: Partial<PersistedNativeAgentSession> = {},
): PersistedNativeAgentSession {
  return {
    key: "session-key",
    environmentId: "env-1",
    agent: "claude",
    logicalSessionKey: "env-env-1:tab-1",
    providerSessionId: "provider-session",
    origin: "interactive-native",
    interactionPolicy: {},
    dispatchedRequestIds: ["request-1"],
    lastDispatchedTurn: { requestId: "request-1" },
    ...overrides,
  } as unknown as PersistedNativeAgentSession;
}

function harness(
  options: {
    session?: PersistedNativeAgentSession;
    outcome?: { outcome: string; error?: string };
    verdict?: UsageLimitStopVerdict;
    automatic?: boolean;
    locked?: PersistedNativeAgentSession;
    queue?: unknown;
    observed?: { providerSessionId: string; state: "idle" | "working" };
    dispatch?: NativeAgentUsageLimitResendDependencies["dispatchPrompt"];
  } = {},
) {
  let clock = 1_000;
  const state = {
    session: options.session ?? sessionWith(),
    outcome: options.outcome ?? { outcome: "failed", error: LIMIT },
    verdict: options.verdict ?? ("resend" as UsageLimitStopVerdict),
  };
  const dispatches: Array<{
    prompt: string;
    requestId: string;
    mode?: string;
    decision: unknown;
  }> = [];
  const handleLimitStop = mock(async (_input: { resends: number }) => state.verdict);
  const requestOutcome = mock(async () => state.outcome);
  const noteTurnEnded = mock(() => undefined);
  const resend = new NativeAgentUsageLimitResend({
    storage: {
      getEnvironment: async () => ({ id: "env-1" }),
      getNativeAgentSession: async () => state.session,
      getPromptQueue: async () => options.queue ?? null,
    } as unknown as NativeAgentUsageLimitResendDependencies["storage"],
    stops: () => ({
      automatic: async () => options.automatic ?? true,
      noteTurnEnded,
      handleLimitStop,
    }),
    now: () => clock,
    isStopped: () => false,
    requestOutcome,
    observedActivity: () => options.observed,
    dispatchPrompt:
      options.dispatch ??
      (async (input, prepare) => {
        const decision = await prepare(options.locked ?? state.session, {} as never);
        dispatches.push({
          prompt: input.prompt,
          requestId: input.requestId,
          ...(input.mode ? { mode: input.mode } : {}),
          decision,
        });
      }),
  });
  return {
    resend,
    state,
    dispatches,
    handleLimitStop,
    requestOutcome,
    noteTurnEnded,
    advance: (ms: number) => {
      clock += ms;
    },
    settle: () => Promise.allSettled(resend.pendingTasks()),
  };
}

describe("a native tab the weekly limit stopped", () => {
  test("resends in the mode its turn ran in, whatever the session's controls say", async () => {
    const h = harness({
      session: sessionWith({
        controls: { mode: "build" },
        lastDispatchedTurn: { requestId: "request-1", mode: "plan" },
      }),
    });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]?.mode).toBe("plan");
  });

  test("tabs stopped together send one at a time, so the second finds the new bridge", async () => {
    const order: string[] = [];
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const h = harness({
      dispatch: async (input) => {
        order.push(`start ${input.requestId}`);
        if (input.requestId.endsWith("request-1")) await first;
        order.push(`end ${input.requestId}`);
      },
    });
    h.resend.noteActivity(h.state.session, "idle", "working");
    const otherTab = sessionWith({
      key: "env-1\0claude\0tab-2",
      dispatchedRequestIds: ["request-2"],
      lastDispatchedTurn: { requestId: "request-2" },
    });
    const pending = h.resend.pendingTasks();
    await Promise.resolve();
    h.state.session = otherTab;
    h.resend.noteActivity(otherTab, "idle", "working");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start usage-limit-resend:1:request-1"]);
    releaseFirst();
    await Promise.allSettled([...pending, ...h.resend.pendingTasks()]);
    expect(order).toEqual([
      "start usage-limit-resend:1:request-1",
      "end usage-limit-resend:1:request-1",
      "start usage-limit-resend:1:request-2",
      "end usage-limit-resend:1:request-2",
    ]);
  });

  test("a turn with no record of its mode stays stopped rather than guess", async () => {
    const h = harness({
      session: sessionWith({ lastDispatchedTurn: { requestId: "an-older-request" } }),
    });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.dispatches).toEqual([]);
    expect(h.handleLimitStop).not.toHaveBeenCalled();
  });

  test("says when the turn was first seen running, not when it stopped", async () => {
    const h = harness();
    h.resend.noteActivity(h.state.session, "working", "idle");
    h.advance(60_000);
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.handleLimitStop.mock.calls[0]?.[0]).toMatchObject({
      turnStartedAt: new Date(1_000).toISOString(),
    });
  });

  test("resends once on the new account, continuing rather than repeating the prompt", async () => {
    const h = harness();
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.dispatches).toEqual([
      {
        prompt: expect.stringContaining("Do not repeat work"),
        requestId: "usage-limit-resend:1:request-1",
        decision: { dispatch: true },
      },
    ]);
    expect(h.handleLimitStop).toHaveBeenCalledWith({
      platform: "claude",
      environmentId: "env-1",
      requestId: "request-1",
      error: LIMIT,
      resends: 0,
      turnStartedAt: new Date(1_000).toISOString(),
    });
    expect(h.resend.hasCandidate("session-key")).toBe(false);

    // The same stop seen again is not another stop.
    h.resend.noteActivity(h.state.session, "idle", "idle");
    await h.settle();
    expect(h.dispatches).toHaveLength(1);
  });

  test("a turn refused between two sweeps still counts, with no busy state seen", async () => {
    const h = harness({ outcome: { outcome: "completed" } });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    h.state.outcome = { outcome: "failed", error: LIMIT };
    h.state.session = sessionWith({
      dispatchedRequestIds: ["request-1", "request-2"],
      lastDispatchedTurn: { requestId: "request-2" },
    });
    h.resend.noteActivity(h.state.session, "idle", "idle");
    await h.settle();
    expect(h.dispatches.map((entry) => entry.requestId)).toEqual([
      "usage-limit-resend:1:request-2",
    ]);
  });

  test.each([
    ["the user stopped", "interrupted"],
    ["a later prompt followed", "superseded"],
    ["its outcome is unknown", "unknown"],
    ["it finished", "completed"],
  ])("nothing is sent when %s", async (_name, outcome) => {
    const h = harness({ outcome: { outcome } });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.dispatches).toEqual([]);
    expect(h.handleLimitStop).not.toHaveBeenCalled();
    expect(h.resend.hasCandidate("session-key")).toBe(false);
  });

  test("a pending outcome is asked again, never guessed at", async () => {
    const h = harness({ outcome: { outcome: "pending" } });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.dispatches).toEqual([]);
    expect(h.resend.hasCandidate("session-key")).toBe(true);
    expect(h.resend.isPending("session-key")).toBe(true);

    h.state.outcome = { outcome: "failed", error: LIMIT };
    // Not yet due.
    h.resend.noteActivity(h.state.session, "idle", "idle");
    await h.settle();
    expect(h.dispatches).toEqual([]);
    h.advance(15_000);
    h.resend.noteActivity(h.state.session, "idle", "idle");
    await h.settle();
    expect(h.dispatches).toHaveLength(1);
  });

  test("a decision that never comes is abandoned, letting the queue go", async () => {
    const h = harness({ outcome: { outcome: "pending" } });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.resend.isPending("session-key")).toBe(true);
    h.advance(USAGE_LIMIT_CANDIDATE_MAX_MS);
    h.resend.noteActivity(h.state.session, "idle", "idle");
    await h.settle();
    expect(h.resend.isPending("session-key")).toBe(false);
    expect(h.dispatches).toEqual([]);
  });

  test("a stop that is not the weekly limit stays stopped", async () => {
    const h = harness({ verdict: "stop" });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.dispatches).toEqual([]);
    expect(h.resend.hasCandidate("session-key")).toBe(false);
  });

  test("a verdict that has to wait keeps the session observed until it is decided", async () => {
    const h = harness({ verdict: "wait" });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.resend.hasCandidate("session-key")).toBe(true);
    h.state.verdict = "resend";
    h.advance(15_000);
    h.resend.noteActivity(h.state.session, "idle", "idle");
    await h.settle();
    expect(h.dispatches).toHaveLength(1);
  });

  test("with the tick off it reads no provider at all", async () => {
    const h = harness({ automatic: false });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.requestOutcome).not.toHaveBeenCalled();
    expect(h.dispatches).toEqual([]);
  });

  test("a stop from before a restart stays stopped", async () => {
    const h = harness();
    h.resend.noteActivity(h.state.session, "idle", undefined);
    await h.settle();
    expect(h.requestOutcome).not.toHaveBeenCalled();
    expect(h.dispatches).toEqual([]);
  });

  test("a chain of refusals counts up to the budget", async () => {
    const h = harness({
      session: sessionWith({
        dispatchedRequestIds: ["usage-limit-resend:2:request-1"],
        lastDispatchedTurn: { requestId: "usage-limit-resend:2:request-1" },
      }),
    });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.handleLimitStop.mock.calls[0]?.[0].resends).toBe(2);
    expect(h.dispatches[0]?.requestId).toBe("usage-limit-resend:3:request-1");
  });

  test.each([
    ["a prompt the user just sent", { dispatchedRequestIds: ["request-1", "typed"] }],
    ["a Stop the user just pressed", { interruptedRequestIds: ["request-1"] }],
    ["another session mapped there", { providerSessionId: "other" }],
  ])("%s wins inside the session's fence", async (_name, change) => {
    const h = harness({ locked: sessionWith(change) });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.dispatches[0]?.decision).toEqual({ dispatch: false });
    expect(h.resend.hasCandidate("session-key")).toBe(false);
  });

  test("a turn already running in the session wins too", async () => {
    const h = harness({ observed: { providerSessionId: "provider-session", state: "working" } });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.dispatches[0]?.decision).toEqual({ dispatch: false });
  });

  test("an unsettled dispatch or queue claim keeps it waiting, never sends past it", async () => {
    const pending = harness({
      locked: sessionWith({ pendingDispatch: { requestId: "x" } as never }),
    });
    pending.resend.noteActivity(pending.state.session, "idle", "working");
    await pending.settle();
    expect(pending.dispatches[0]?.decision).toEqual({ dispatch: false });
    expect(pending.resend.hasCandidate("session-key")).toBe(true);

    const queued = harness({ queue: { inFlight: { requestId: "q" }, messages: [] } });
    queued.resend.noteActivity(queued.state.session, "idle", "working");
    await queued.settle();
    expect(queued.dispatches[0]?.decision).toEqual({ dispatch: false });
    expect(queued.resend.hasCandidate("session-key")).toBe(true);

    // A queue holding prompts behind this stop goes after the resend.
    const waiting = harness({ queue: { messages: [{ id: "later" }] } });
    waiting.resend.noteActivity(waiting.state.session, "idle", "working");
    await waiting.settle();
    expect(waiting.dispatches[0]?.decision).toEqual({ dispatch: true });
  });

  test("a resend that fails to send is left as it stopped, with no retry loop", async () => {
    const dispatch = mock(async () => {
      throw new Error("bridge refused");
    });
    const h = harness({ dispatch });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    h.resend.noteActivity(h.state.session, "idle", "idle");
    await h.settle();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(h.resend.hasCandidate("session-key")).toBe(false);
  });

  test.each([
    ["a coordinator's conversation", { origin: "coordinator" }],
    ["a build or review session", { origin: "build-pipeline" }],
    ["an automated review", { origin: "automated-review" }],
    ["a terminal CLI", { origin: "interactive-tmux" }],
    ["a provider without accounts", { agent: "opencode" }],
  ])("%s is not a native tab", async (_name, change) => {
    const h = harness({ session: sessionWith(change as never) });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.dispatches).toEqual([]);
  });

  test("a turn ending anywhere prompts the between-turns check, a workflow's included", async () => {
    const h = harness({ session: sessionWith({ origin: "build-pipeline" }) });
    h.resend.noteActivity(h.state.session, "idle", "working");
    expect(h.noteTurnEnded).toHaveBeenCalledWith("claude");
  });
});

test("native continuation reaches the replacement HTTP bridge with its new token", async () => {
  const sends: string[] = [];
  let activeToken = "old";
  const provider = createNativeAgentProvider(
    { agent: "claude", baseUrl: "http://native-replacement", authToken: "old" },
    {
      refreshConnection: async () => ({
        agent: "claude",
        baseUrl: "http://native-replacement",
        authToken: activeToken,
      }),
      fetch: (async (url: unknown, init?: RequestInit) => {
        if (String(url).endsWith("/prompt"))
          sends.push(new Headers(init?.headers).get("X-Orkestrator-Claude-Token")!);
        return Response.json({ status: "processing" });
      }) as typeof fetch,
    },
  );
  const h = harness({
    dispatch: async (input, prepare) => {
      activeToken = "replacement";
      const decision = await prepare(sessionWith(), provider);
      if (decision.dispatch) {
        await provider.prepareDispatch!("provider-session");
        await provider.send("provider-session", input.prompt, { requestId: input.requestId });
      }
    },
  });
  try {
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(sends).toEqual(["replacement"]);
  } finally {
    provider.dispose?.();
  }
});

test.each(["steer", "recovered"] as const)(
  "%s dispatch retains its turn mode for one weekly-limit resend",
  async (kind) => {
    const { StorageService } = await import("./storage.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "resend-record-"));
    const storage = new StorageService(directory);
    await storage.init();
    try {
      const input = {
        key: "session-key",
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "tab",
        origin: "interactive-native" as const,
      };
      await storage.addEnvironment({
        id: "env-1",
        projectId: "project-1",
        name: "test",
        branch: "main",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "local",
        setupPhase: "ready",
      });
      await storage.getOrCreateNativeAgentSession(input, async () => "provider-session");
      await storage.dispatchNativeAgentPromptOnce(input.key, "original", async () => ({
        dispatched: true,
        mode: "plan",
      }));
      if (kind === "steer") {
        await storage.dispatchNativeAgentSteerOnce(
          input.key,
          {
            requestId: "latest",
            text: "steer",
            inputDigest: new Bun.CryptoHasher("sha256").update("steer").digest("hex"),
            expectedRunId: "run",
            state: "prepared",
            createdAt: new Date().toISOString(),
          },
          async () => ({ outcome: "applied" }),
        );
      } else {
        await storage
          .dispatchNativeAgentPromptOnce(
            input.key,
            "latest",
            async () => {
              throw new Error("lost reply");
            },
            {
              requestId: "latest",
              prompt: "work",
              mode: "plan",
              createdAt: new Date().toISOString(),
            },
          )
          .catch(() => undefined);
        expect(await storage.confirmNativeAgentDispatch(input.key, "latest")).toBe(true);
      }
      const session = (await storage.getNativeAgentSession(input.key))!;
      expect(session.lastDispatchedTurn).toEqual({ requestId: "latest", mode: "plan" });
      const h = harness({ session });
      h.resend.noteActivity(session, "idle", "working");
      await h.settle();
      expect(h.dispatches).toHaveLength(1);
      expect(h.dispatches[0]?.mode).toBe("plan");
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("native recovery waits for a workflow on the shared bridge, then continues once", async () => {
  const { workflowBridgeRunning } = await import("./native-agent-provider.js");
  const workflow = createNativeAgentProvider(
    { agent: "claude", baseUrl: "http://shared-workflow", authToken: "a" },
    {
      bridgeEnvironmentId: "env-1",
      refreshConnection: async () => ({
        agent: "claude",
        baseUrl: "http://shared-workflow",
        authToken: "a",
      }),
      fetch: (async () => Response.json({ status: "idle" })) as unknown as typeof fetch,
    },
  );
  const h = harness();
  h.handleLimitStop.mockImplementation(async () =>
    workflowBridgeRunning("env-1", "claude") ? "wait" : "resend",
  );
  try {
    await workflow.send("review", "work", { requestId: "review" });
    h.resend.noteActivity(h.state.session, "idle", "working");
    await h.settle();
    expect(h.dispatches).toHaveLength(0);
    expect(h.resend.hasCandidate(h.state.session.key)).toBe(true);
    await workflow.status("review");
    h.advance(15_000);
    h.resend.noteActivity(h.state.session, "idle", "idle");
    await h.settle();
    expect(h.dispatches).toHaveLength(1);
    h.resend.noteActivity(h.state.session, "idle", "idle");
    await h.settle();
    expect(h.dispatches).toHaveLength(1);
  } finally {
    workflow.dispose?.();
  }
});
