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
  const dispatches: Array<{ prompt: string; requestId: string; decision: unknown }> = [];
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
        dispatches.push({ prompt: input.prompt, requestId: input.requestId, decision });
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
    h.state.session = sessionWith({ dispatchedRequestIds: ["request-1", "request-2"] });
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
      session: sessionWith({ dispatchedRequestIds: ["usage-limit-resend:2:request-1"] }),
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
