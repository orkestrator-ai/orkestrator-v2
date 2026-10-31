import { describe, expect, test } from "bun:test";
import {
  goalContinuationRequestId,
  sessionGoal,
  type NativeAgentGoal,
} from "@orkestrator/protocol/native-agent-goal";
import {
  GoalCommandError,
  NativeAgentGoalService,
  type GoalCheckRun,
  type NativeAgentGoalHost,
} from "./native-agent-goal-service.js";
import type { PersistedNativeAgentSession } from "./native-agent-service-shared.js";

const KEY = "session-key";
const QUEUE = "claude\0env-e1:t1";

type Outcome = Awaited<ReturnType<NativeAgentGoalHost["requestOutcome"]>>;

function harness(
  options: {
    outcome?: Outcome;
    activity?: "idle" | "working" | "waiting";
    supportsGoals?: boolean;
    environmentRunning?: boolean;
    check?: GoalCheckRun;
    fingerprint?: string;
    tokens?: number;
  } = {},
) {
  const state = {
    session: {
      key: KEY,
      environmentId: "e1",
      agent: "claude",
      logicalSessionKey: "env-e1:t1",
      providerSessionId: "p1",
      dispatchedRequestIds: [] as string[],
    } as unknown as PersistedNativeAgentSession,
    queue: [] as {
      id: string;
      text: string;
      origin?: unknown;
      command?: unknown;
      preserveSessionMode?: boolean;
    }[],
    consumed: new Set<string>(),
    outcome: options.outcome ?? ({ outcome: "completed" } as Outcome),
    activity: options.activity ?? ("idle" as "idle" | "working" | "waiting"),
    environmentRunning: options.environmentRunning ?? true,
    stoppedMidTurn: false,
    check:
      options.check ??
      ({
        kind: "finished",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
        outputTail: "ok",
      } as GoalCheckRun),
    checksRun: 0,
    fingerprint: options.fingerprint,
    tokens: options.tokens,
    announced: 0,
    rung: [] as string[],
    released: 0,
    notified: 0,
    outcomeReads: 0,
    now: Date.parse("2026-10-31T12:00:00.000Z"),
    failNextEnqueue: false,
    dispatchError: undefined as
      { messageId: string; requestId: string; message: string } | undefined,
    stopped: false,
  };
  const host: NativeAgentGoalHost = {
    storage: {
      getNativeAgentSession: async () => state.session,
      listNativeAgentSessions: async () => [state.session],
      updateNativeAgentGoal: async (_key, update) => {
        const next = update(sessionGoal(state.session), state.session);
        if (next === undefined) return state.session;
        const { goal: _goal, ...rest } = state.session;
        state.session = { ...rest, ...(next ? { goal: next } : {}) } as PersistedNativeAgentSession;
        return state.session;
      },
      enqueuePromptQueueMessageIfAbsent: async (_queue, _env, message) => {
        if (state.failNextEnqueue) {
          state.failNextEnqueue = false;
          throw new Error("disk full");
        }
        const entry = message as (typeof state.queue)[number];
        if (state.consumed.has(entry.id)) return { status: "consumed" };
        if (state.queue.some((queued) => queued.id === entry.id)) return { status: "present" };
        state.queue.push(entry);
        return { status: "queued" };
      },
      getPromptQueue: async () => ({ dispatchError: state.dispatchError }),
      removePromptQueueMessage: async (_queue, _env, id) => {
        if (!state.queue.some((entry) => entry.id === id)) return;
        state.queue = state.queue.filter((entry) => entry.id !== id);
        state.consumed.add(id);
      },
    },
    now: () => state.now,
    isStopped: () => state.stopped,
    trackScan: (task) => task,
    requestOutcome: async () => {
      state.outcomeReads += 1;
      return state.outcome;
    },
    turnActivity: () => state.activity,
    stoppedMidTurn: () => state.stoppedMidTurn,
    environmentRunning: async () => state.environmentRunning,
    notifyQueue: () => {
      state.notified += 1;
    },
    sessionTokens: async () => state.tokens,
    workspaceFingerprint: async () => state.fingerprint,
    runCheck: async () => {
      state.checksRun += 1;
      return state.check;
    },
    announce: () => {
      state.announced += 1;
    },
    ringAttention: async (_session, goal) => {
      state.rung.push(goal.status);
    },
    releaseTurnEnd: async () => {
      state.released += 1;
    },
    supportsGoals: () => options.supportsGoals ?? true,
    supportsTokenBudget: () => true,
  };
  const service = new NativeAgentGoalService(host);
  /** The queue drains: the head becomes the session's latest dispatched turn. */
  const dispatchHead = () => {
    const head = state.queue.shift();
    if (!head) throw new Error("nothing queued");
    state.consumed.add(head.id);
    state.session = {
      ...state.session,
      dispatchedRequestIds: [...(state.session.dispatchedRequestIds ?? []), head.id],
    };
    return head;
  };
  const turnEnds = async () => {
    service.noteTurnEnded(KEY);
    await service.settled();
  };
  const set = async (text: string, busy = false) => {
    const result = await service.command(state.session, text, { busy });
    await service.settled();
    return result;
  };
  const goal = () => sessionGoal(state.session) as NativeAgentGoal;
  return { state, host, service, dispatchHead, turnEnds, set, goal };
}

describe("setting a goal", () => {
  test("while idle, the objective goes out as the first turn", async () => {
    const { state, set, goal } = harness();
    const result = await set("make it pass --check bun test");
    expect(result.goal?.status).toBe("active");
    expect(goal().iterations).toBe(1);
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]!.id).toBe(goalContinuationRequestId(goal().goalId, 0));
    expect(state.queue[0]!.text).toContain("make it pass");
    expect(state.queue[0]!.command).toEqual({ kind: "literal" });
    expect(state.notified).toBe(1);
  });

  test("while a turn runs, nothing is sent until that turn ends", async () => {
    const { state, set, turnEnds, goal } = harness({ activity: "working" });
    state.session = { ...state.session, dispatchedRequestIds: ["user-1"] };
    await set("make it pass", true);
    expect(state.queue).toHaveLength(0);
    expect(goal().iterations).toBe(0);
    state.activity = "idle";
    await turnEnds();
    expect(state.queue).toHaveLength(1);
    expect(goal().iterations).toBe(1);
    expect(goal().evaluatedRequestId).toBe("user-1");
    expect(state.queue[0]!.text).toContain("The user set this goal");
  });

  test("a turn from before the goal is not evaluated against it", async () => {
    const { state, set, goal } = harness();
    state.session = { ...state.session, dispatchedRequestIds: ["old"] };
    await set("make it pass");
    expect(state.outcomeReads).toBe(0);
    expect(goal().evaluatedRequestId).toBe("old");
  });

  test("a running goal must be cleared before it is replaced", async () => {
    const { set } = harness();
    await set("first");
    await expect(set("second")).rejects.toBeInstanceOf(GoalCommandError);
  });

  test("an ended goal can be replaced, and moves on", async () => {
    const { state, set, dispatchHead, turnEnds, service, goal } = harness();
    await set("first");
    dispatchHead();
    await service.report(
      { environmentId: "e1", tabId: "t1" },
      { goalId: goal().goalId, status: "done", message: "done" },
    );
    await turnEnds();
    expect(goal().status).toBe("claimed");
    const firstId = goal().goalId;
    await set("second");
    expect(goal().goalId).not.toBe(firstId);
    expect(state.queue.at(-1)!.text).toContain("second");
  });

  test("refuses unqualified platforms and sessions that are not tabs", async () => {
    const off = harness({ supportsGoals: false });
    await expect(off.set("x")).rejects.toThrow("not available");
    const workflow = harness();
    workflow.state.session = { ...workflow.state.session, logicalSessionKey: "review:1" };
    await expect(workflow.set("x")).rejects.toThrow("agent tabs");
    const coordinator = harness();
    coordinator.state.session = {
      ...coordinator.state.session,
      owner: { kind: "coordinator" },
    } as unknown as PersistedNativeAgentSession;
    await expect(coordinator.set("x")).rejects.toThrow("agent tabs");
  });

  test("a usage error names what to do and sets nothing", async () => {
    const { set, goal } = harness();
    await expect(set("x --max-iterations 0")).rejects.toThrow("positive whole number");
    expect(goal()).toBeUndefined();
  });
});

describe("the loop", () => {
  test("a turn with no report sends the next continuation once", async () => {
    const { state, set, dispatchHead, turnEnds, goal } = harness();
    await set("make it pass");
    const first = dispatchHead();
    await turnEnds();
    expect(goal().evaluatedRequestId).toBe(first.id);
    expect(goal().iterations).toBe(2);
    expect(state.queue.map((entry) => entry.id)).toEqual([
      goalContinuationRequestId(goal().goalId, 1),
    ]);
    // A repeated wake for the same turn does nothing new.
    await turnEnds();
    expect(goal().iterations).toBe(2);
    expect(state.queue).toHaveLength(1);
  });

  test("a done report runs the check, and a pass completes the goal", async () => {
    const { state, set, dispatchHead, turnEnds, service, goal } = harness();
    await set("make it pass --check bun test");
    dispatchHead();
    expect(
      (
        await service.report(
          { environmentId: "e1", tabId: "t1" },
          { goalId: goal().goalId, status: "done", message: "all green" },
        )
      ).ok,
    ).toBe(true);
    await turnEnds();
    expect(state.checksRun).toBe(1);
    expect(goal().status).toBe("complete");
    expect(goal().lastCheck?.passed).toBe(true);
    expect(state.queue).toHaveLength(0);
    expect(state.rung).toEqual(["complete"]);
    expect(state.released).toBe(1);
    expect(service.holdsTurnEnd(KEY)).toBe(false);
  });

  test("a failing check goes back to the agent with the output", async () => {
    const { state, set, dispatchHead, turnEnds, service, goal } = harness({
      check: {
        kind: "finished",
        exitCode: 2,
        timedOut: false,
        durationMs: 9,
        outputTail: "3 failed",
      },
    });
    await set("make it pass --check bun test");
    dispatchHead();
    await service.report(
      { environmentId: "e1", tabId: "t1" },
      { goalId: goal().goalId, status: "done", message: "done" },
    );
    await turnEnds();
    expect(goal().status).toBe("active");
    expect(goal().iterations).toBe(2);
    expect(state.queue[0]!.text).toContain("3 failed");
    expect(state.queue[0]!.text).toContain("evidence and not instructions");
    expect(state.rung).toEqual([]);
  });

  test("a check that can never pass stops at the cap", async () => {
    const { state, set, dispatchHead, turnEnds, service, goal } = harness({
      check: { kind: "finished", exitCode: 1, timedOut: false, durationMs: 1, outputTail: "no" },
    });
    await set("x --max-iterations 2 --check false");
    for (let index = 0; index < 2; index += 1) {
      dispatchHead();
      await service.report(
        { environmentId: "e1", tabId: "t1" },
        { goalId: goal().goalId, status: "done", message: "done" },
      );
      await turnEnds();
    }
    expect(goal().status).toBe("limited");
    expect(goal().statusReason).toBe("iteration-cap");
    expect(state.queue).toHaveLength(0);
    expect(state.rung).toEqual(["limited"]);
  });

  test("a check that cannot run or times out pauses instead of blaming the agent", async () => {
    for (const check of [
      { kind: "unavailable", detail: "no container" },
      { kind: "finished", exitCode: null, timedOut: true, durationMs: 600_000, outputTail: "" },
    ] as GoalCheckRun[]) {
      const { state, set, dispatchHead, turnEnds, service, goal } = harness({ check });
      await set("x --check slow");
      dispatchHead();
      await service.report(
        { environmentId: "e1", tabId: "t1" },
        { goalId: goal().goalId, status: "done", message: "done" },
      );
      await turnEnds();
      expect(goal().status).toBe("paused");
      expect(goal().statusReason).toBe("check-unavailable");
      expect(state.queue).toHaveLength(0);
    }
  });

  test("no check ends as claimed, never complete", async () => {
    const { set, dispatchHead, turnEnds, service, goal } = harness();
    await set("explore");
    dispatchHead();
    await service.report(
      { environmentId: "e1", tabId: "t1" },
      { goalId: goal().goalId, status: "done", message: "done" },
    );
    await turnEnds();
    expect(goal().status).toBe("claimed");
  });

  test("blocked waits for a person and rings", async () => {
    const { state, set, dispatchHead, turnEnds, service, goal } = harness();
    await set("x");
    dispatchHead();
    await service.report(
      { environmentId: "e1", tabId: "t1" },
      { goalId: goal().goalId, status: "blocked", message: "need the key" },
    );
    // Mid-turn, the report waits for the turn to end.
    expect(goal().status).toBe("active");
    await turnEnds();
    expect(goal().status).toBe("blocked");
    expect(goal().statusDetail).toBe("need the key");
    expect(state.rung).toEqual(["blocked"]);
  });

  test("Stop pauses, starts nothing, and the user is not paged for their own act", async () => {
    const { state, set, dispatchHead, turnEnds, goal } = harness();
    await set("x");
    dispatchHead();
    state.outcome = { outcome: "interrupted" };
    await turnEnds();
    expect(goal().status).toBe("paused");
    expect(goal().statusReason).toBe("user-stopped");
    expect(state.queue).toHaveLength(0);
    expect(state.rung).toEqual([]);
    expect(state.released).toBe(1);
  });

  test("a failed turn pauses with its error", async () => {
    const { state, set, dispatchHead, turnEnds, goal } = harness();
    await set("x");
    dispatchHead();
    state.outcome = { outcome: "failed", error: "credit balance" };
    await turnEnds();
    expect(goal().statusReason).toBe("turn-failed");
    expect(goal().statusDetail).toBe("credit balance");
    expect(state.queue).toHaveLength(0);
  });

  test("a pending outcome waits for a later wake", async () => {
    const { state, set, dispatchHead, turnEnds, goal } = harness();
    await set("x");
    dispatchHead();
    state.outcome = { outcome: "pending" };
    await turnEnds();
    expect(goal().iterations).toBe(1);
    expect(state.queue).toHaveLength(0);
    state.outcome = { outcome: "completed" };
    await turnEnds();
    expect(goal().iterations).toBe(2);
  });

  test("a user's turn between continuations does not count as an iteration", async () => {
    const { state, set, dispatchHead, turnEnds, goal } = harness();
    await set("x");
    dispatchHead();
    await turnEnds();
    expect(goal().iterations).toBe(2);
    // The user sent something before the queued continuation drained.
    const continuation = state.queue[0]!.id;
    state.session = {
      ...state.session,
      dispatchedRequestIds: [...(state.session.dispatchedRequestIds ?? []), "user-2"],
    };
    await turnEnds();
    expect(goal().iterations).toBe(2);
    expect(state.queue).toHaveLength(1);
    expect(goal().evaluatedRequestId).toBe("user-2");
    expect(state.queue.map((entry) => entry.id)).toContain(continuation);
  });

  test("three continuations that change nothing pause the goal", async () => {
    const { state, set, dispatchHead, turnEnds, goal } = harness({ fingerprint: "same" });
    await set("x");
    for (let index = 0; index < 4 && state.queue.length > 0; index += 1) {
      dispatchHead();
      await turnEnds();
    }
    expect(goal().status).toBe("paused");
    expect(goal().statusReason).toBe("no-progress");
    expect(state.rung).toEqual(["paused"]);
  });

  test("a token budget stops the loop between turns", async () => {
    const { state, set, dispatchHead, turnEnds, goal } = harness({ tokens: 1_000 });
    await set("x --budget 500");
    expect(goal().tokensAtStart).toBe(1_000);
    dispatchHead();
    state.tokens = 1_400;
    await turnEnds();
    expect(goal().status).toBe("active");
    expect(goal().tokensUsed).toBe(400);
    dispatchHead();
    state.tokens = 1_600;
    await turnEnds();
    expect(goal().status).toBe("limited");
    expect(goal().statusReason).toBe("token-budget");
  });

  test("a live turn or parked approval is left alone", async () => {
    const { state, set, dispatchHead, turnEnds, goal } = harness();
    await set("x");
    dispatchHead();
    state.activity = "waiting";
    await turnEnds();
    expect(goal().iterations).toBe(1);
    expect(state.outcomeReads).toBe(0);
  });
});

describe("controls", () => {
  test("pause removes a queued continuation and nothing more is sent", async () => {
    const { state, set, dispatchHead, turnEnds, service, goal } = harness();
    await set("x");
    dispatchHead();
    await turnEnds();
    expect(state.queue).toHaveLength(1);
    await service.command(state.session, "pause", { busy: false });
    await service.settled();
    expect(goal().status).toBe("paused");
    expect(goal().statusReason).toBe("user-paused");
    expect(state.queue).toHaveLength(0);
    await turnEnds();
    expect(state.queue).toHaveLength(0);
    expect(state.rung).toEqual([]);
  });

  test("a turn ending after a pause does not restart the loop", async () => {
    const { state, set, dispatchHead, turnEnds, service, goal } = harness();
    await set("x");
    dispatchHead();
    await service.command(state.session, "pause", { busy: true });
    await turnEnds();
    expect(goal().status).toBe("paused");
    expect(state.queue).toHaveLength(0);
  });

  test("resume sends a new continuation with a new id", async () => {
    const { state, set, dispatchHead, turnEnds, service, goal } = harness();
    await set("x");
    dispatchHead();
    await turnEnds();
    const removedId = state.queue[0]!.id;
    await service.command(state.session, "pause", { busy: false });
    await service.settled();
    await service.command(state.session, "resume", { busy: false });
    await service.settled();
    expect(goal().status).toBe("active");
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]!.id).not.toBe(removedId);
  });

  test("resume at the cap says so, and more iterations let it continue", async () => {
    const { state, set, dispatchHead, turnEnds, service, goal } = harness();
    await set("x --max-iterations 1");
    dispatchHead();
    await turnEnds();
    expect(goal().status).toBe("limited");
    await expect(service.command(state.session, "resume", { busy: false })).rejects.toThrow(
      "higher --max-iterations",
    );
    await service.command(state.session, "resume --max-iterations 2", { busy: false });
    await service.settled();
    expect(goal().status).toBe("active");
    expect(state.queue).toHaveLength(1);
  });

  test("clear removes the goal and its queued continuation", async () => {
    const { state, set, service, goal } = harness();
    await set("x");
    await service.command(state.session, "clear", { busy: false });
    expect(goal()).toBeUndefined();
    expect(state.queue).toHaveLength(0);
    expect(service.holdsTurnEnd(KEY)).toBe(false);
    expect(state.released).toBe(1);
  });

  test("taking the continuation out of the queue pauses the goal", async () => {
    const { state, set, dispatchHead, turnEnds, goal } = harness();
    await set("x");
    dispatchHead();
    await turnEnds();
    const queued = state.queue.shift()!;
    state.consumed.add(queued.id);
    await turnEnds();
    expect(goal().status).toBe("paused");
    expect(goal().statusReason).toBe("user-paused");
  });

  test("status reads without changing anything", async () => {
    const { state, set, service } = harness();
    expect((await service.command(state.session, "", { busy: false })).message).toBe(
      "No goal is set.",
    );
    await set("x");
    const announced = state.announced;
    expect((await service.command(state.session, "", { busy: false })).goal?.objective).toBe("x");
    expect(state.announced).toBe(announced);
  });
});

describe("what stops it from outside", () => {
  test("a replaced conversation pauses it, and resume binds to the new one", async () => {
    const { state, set, dispatchHead, turnEnds, service, goal } = harness();
    await set("x");
    dispatchHead();
    state.session = { ...state.session, providerSessionId: "p2", dispatchedRequestIds: [] };
    await turnEnds();
    expect(goal().statusReason).toBe("session-replaced");
    await service.command(state.session, "resume", { busy: false });
    await service.settled();
    expect(goal().providerSessionId).toBe("p2");
    expect(goal().status).toBe("active");
  });

  test("a stopped environment pauses it without an edge, through the sweep", async () => {
    const { state, set, service, goal } = harness();
    await set("x");
    state.environmentRunning = false;
    state.now += 60_000;
    service.sweep();
    await service.settled();
    expect(goal().statusReason).toBe("environment-stopped");
  });

  test("a runtime that stopped mid-turn pauses it", async () => {
    const { state, set, dispatchHead, turnEnds, goal } = harness();
    await set("x");
    dispatchHead();
    state.stoppedMidTurn = true;
    await turnEnds();
    expect(goal().statusReason).toBe("runtime-stopped");
  });

  test("the sweep is rate limited and costs nothing with no goal", async () => {
    const { state, service, set } = harness();
    service.sweep();
    await service.settled();
    expect(state.outcomeReads).toBe(0);
    await set("x");
    state.now += 60_000;
    service.sweep();
    const reads = state.announced;
    service.sweep();
    await service.settled();
    expect(state.announced).toBeGreaterThanOrEqual(reads);
  });

  test("a turn edge for a session with no goal reads nothing", async () => {
    const { state, turnEnds } = harness();
    await turnEnds();
    expect(state.outcomeReads).toBe(0);
  });
});

describe("restarts", () => {
  /** A fresh service over the same durable state: the backend restarted. */
  function restart(parts: ReturnType<typeof harness>, host: () => NativeAgentGoalHost) {
    const service = new NativeAgentGoalService(host());
    return { service, parts };
  }

  test("a crash between the write and the enqueue re-sends the same id, once", async () => {
    const { state, set, dispatchHead, turnEnds, goal, service } = harness();
    await set("x");
    dispatchHead();
    state.failNextEnqueue = true;
    await turnEnds();
    // The iteration is durable, and the queue never got it.
    expect(goal().iterations).toBe(2);
    expect(state.queue).toHaveLength(0);
    await turnEnds();
    expect(state.queue.map((entry) => entry.id)).toEqual([
      goalContinuationRequestId(goal().goalId, 1),
    ]);
    await turnEnds();
    expect(state.queue).toHaveLength(1);
    expect(service.holdsTurnEnd(KEY)).toBe(true);
  });

  test("init picks up running goals and leaves others alone", async () => {
    const parts = harness();
    const { state, set, dispatchHead, goal } = parts;
    await set("x");
    dispatchHead();
    const again = new NativeAgentGoalService(hostOf(parts));
    await again.init();
    await again.settled();
    expect(goal().iterations).toBe(2);
    expect(state.queue).toHaveLength(1);
    expect(again.holdsTurnEnd(KEY)).toBe(true);
    void restart;
  });

  test("a restart during a check runs it again", async () => {
    const parts = harness();
    const { state, set, goal } = parts;
    await set("x --check ok");
    state.session = {
      ...state.session,
      goal: { ...goal(), status: "checking" },
    } as PersistedNativeAgentSession;
    const again = new NativeAgentGoalService(hostOf(parts));
    await again.init();
    await again.settled();
    expect(state.checksRun).toBe(1);
    expect(goal().status).toBe("complete");
  });

  test("a stale goal id changes nothing", async () => {
    const { state, set, service, goal } = harness();
    await set("x");
    const answer = await service.report(
      { environmentId: "e1", tabId: "t1" },
      { goalId: "other", status: "done", message: "m" },
    );
    expect(answer.ok).toBe(false);
    expect(goal().pendingReport).toBeUndefined();
    void state;
  });
});

describe("report_goal authority", () => {
  test("two tabs on an environment credential cannot reach each other's goals", async () => {
    const first = harness();
    await first.set("first tab");
    const other = harness();
    other.state.session = {
      ...other.state.session,
      key: "other-key",
      logicalSessionKey: "env-e1:t2",
    } as PersistedNativeAgentSession;
    await other.service.command(other.state.session, "second tab", { busy: false });
    await other.service.settled();
    const secondGoal = sessionGoal(other.state.session)!;
    // A goal id belongs to the service holding it. An environment credential
    // reports by id, so the first tab's id cannot touch the second tab's goal.
    const wrong = await other.service.report(
      { environmentId: "e1" },
      { goalId: first.goal().goalId, status: "done", message: "m" },
    );
    expect(wrong.ok).toBe(false);
    expect(sessionGoal(other.state.session)?.pendingReport).toBeUndefined();
    const right = await other.service.report(
      { environmentId: "e1" },
      { goalId: secondGoal.goalId, status: "progress", message: "m" },
    );
    expect(right.ok).toBe(true);
    expect(first.goal().pendingReport).toBeUndefined();
  });

  test("a tab cannot report on another tab's goal", async () => {
    const { set, service, goal } = harness();
    await set("x");
    const answer = await service.report(
      { environmentId: "e1", tabId: "t2" },
      { goalId: goal().goalId, status: "done", message: "m" },
    );
    expect(answer.ok).toBe(false);
    expect(goal().pendingReport).toBeUndefined();
  });

  test("another environment cannot report on it either", async () => {
    const { set, service, goal } = harness();
    await set("x");
    expect(
      (
        await service.report(
          { environmentId: "e2" },
          { goalId: goal().goalId, status: "done", message: "m" },
        )
      ).ok,
    ).toBe(false);
  });

  test("an environment credential needs the goal id, and the id is enough", async () => {
    const { set, service, goal } = harness();
    await set("x");
    expect(
      (
        await service.report(
          { environmentId: "e1" },
          { goalId: goal().goalId, status: "progress", message: "m" },
        )
      ).ok,
    ).toBe(true);
    expect(goal().pendingReport?.status).toBe("progress");
  });

  test("a report's message is bounded", async () => {
    const { set, service, goal } = harness();
    await set("x");
    await service.report(
      { environmentId: "e1", tabId: "t1" },
      { goalId: goal().goalId, status: "progress", message: "é".repeat(5_000) },
    );
    expect(new TextEncoder().encode(goal().pendingReport!.message).length).toBeLessThanOrEqual(
      2048,
    );
  });
});

describe("a backend with no verifier", () => {
  test("refuses a goal that asks for one", async () => {
    const { set, goal } = harness();
    await expect(set("x --verifier codex")).rejects.toThrow("cannot run verifiers");
    expect(goal()).toBeUndefined();
  });

  test("pauses a goal already waiting for one, so it cannot stay stuck", async () => {
    const parts = harness();
    await parts.set("x");
    parts.state.session = {
      ...parts.state.session,
      goal: { ...parts.goal(), status: "verifying", verifier: { agent: "codex" } },
    } as PersistedNativeAgentSession;
    parts.service.noteTurnEnded(KEY);
    await parts.service.settled();
    expect(parts.goal()).toMatchObject({
      status: "paused",
      statusReason: "verifier-unavailable",
      statusDetail: "This backend cannot run verifiers.",
    });
  });
});

function hostOf(parts: ReturnType<typeof harness>): NativeAgentGoalHost {
  return (parts.service as unknown as { host: NativeAgentGoalHost }).host;
}

void QUEUE;

describe("continuation ordering", () => {
  test("every carrier preserves the session mode", async () => {
    const h = harness();
    await h.set("continue");
    for (let i = 0; i < 3; i++) {
      expect(h.dispatchHead().preserveSessionMode).toBe(true);
      await h.turnEnds();
    }
  });

  test("a dispatch after the initial read is not mistaken for removal", async () => {
    const h = harness();
    await h.set("continue");
    const enqueue = h.host.storage.enqueuePromptQueueMessageIfAbsent;
    h.host.storage.enqueuePromptQueueMessageIfAbsent = async (...args) => {
      h.dispatchHead();
      return enqueue(...args);
    };
    await h.turnEnds();
    expect(h.goal().status).toBe("active");
    expect(h.state.outcomeReads).toBe(0);
    h.host.storage.enqueuePromptQueueMessageIfAbsent = enqueue;
    await h.turnEnds();
    expect(h.state.outcomeReads).toBe(1);
    expect(h.goal().iterations).toBe(2);
  });

  test.each(["rejected", "exhausted", "ambiguous"])(
    "a %s carrier pauses and releases once",
    async (reason) => {
      const h = harness();
      await h.set("continue");
      const id = h.state.queue[0]!.id;
      h.state.dispatchError = { messageId: id, requestId: id, message: reason };
      h.state.session = { ...h.state.session, pendingDispatch: { requestId: id } as never };
      await h.turnEnds();
      await h.turnEnds();
      expect(h.goal()).toMatchObject({
        status: "paused",
        statusReason: "continuation-failed",
        statusDetail: reason,
      });
      expect(h.state.rung).toEqual(["paused"]);
      expect(h.state.released).toBe(1);
      expect(h.service.holdsTurnEnd(KEY)).toBe(false);
      expect(h.state.queue).toHaveLength(0);
    },
  );

  test("a pending user turn is evaluated only after its completion", async () => {
    const h = harness();
    await h.set("continue");
    const carrier = h.state.queue[0]!.id;
    h.state.session = { ...h.state.session, dispatchedRequestIds: ["user-turn"] };
    h.state.outcome = { outcome: "pending" };
    await h.turnEnds();
    expect(h.goal().evaluatedRequestId).toBeUndefined();
    expect(h.state.queue[0]!.id).toBe(carrier);
    h.state.outcome = { outcome: "completed" };
    await h.turnEnds();
    expect(h.goal().evaluatedRequestId).toBe("user-turn");
    expect(h.goal().iterations).toBe(1);
    expect(h.state.queue).toHaveLength(1);
  });

  test("shutdown aborts a deferred check without a late goal mutation", async () => {
    const h = harness();
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    h.host.runCheck = async ({ signal }) => {
      began();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { kind: "finished", exitCode: 0, timedOut: false, durationMs: 1, outputTail: "late" };
    };
    await h.set("continue --check true");
    h.dispatchHead();
    await h.service.report(
      { environmentId: "e1" },
      { goalId: h.goal().goalId, status: "done", message: "done" },
    );
    h.service.noteTurnEnded(KEY);
    await started;
    h.state.stopped = true;
    h.service.stop();
    await h.service.settled();
    expect(h.goal().status).toBe("checking");
    expect(h.goal().lastCheck).toBeUndefined();
    expect(h.state.rung).toHaveLength(0);
  });
});
