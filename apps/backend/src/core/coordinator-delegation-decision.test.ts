import { describe, expect, test } from "bun:test";

import {
  decideDelegation,
  type DelegationDecision,
  type DelegationDecisionState,
  type DelegationEvidence,
  type DelegationObservations,
} from "./coordinator-delegation-decision.js";

const NOW = 1_000_000;
const GRACE = 15_000;
const HOLD = 120_000;

function decide(
  evidence: DelegationEvidence,
  observations: Partial<DelegationObservations> = {},
  state: Partial<DelegationDecisionState> = {},
): DelegationDecision {
  return decideDelegation(
    { askedAt: NOW - GRACE, stopRequested: false, seenWorking: false, ...state },
    {
      now: NOW,
      evidence,
      undeliveredRequest: false,
      goalRunning: false,
      needsHuman: false,
      graceMs: GRACE,
      backgroundHoldMs: HOLD,
      ...observations,
    },
  );
}

const closes = (state: string, extra: object = {}) => ({ action: "close", state, ...extra });
const stays = (reason: string, extra: object = {}) => ({ action: "stay-open", reason, ...extra });
const CHECK = { action: "check-background" };
const QUIET = { backgroundWork: { running: false, reportHeld: false } };
const BUSY = { backgroundWork: { running: true, reportHeld: false } };

const END = { source: "turn-end", outcome: "completed" } as const;
const read = (
  source: "sweep" | "remote",
  environment: "missing" | "deleting" | "error" | "stopped" | "running" | "creating",
  turn: "working" | "waiting" | "idle" | "stopped" | "unknown" = "idle",
) => ({ source, environment, turn }) as const;
const LOCAL_IDLE = read("sweep", "running");
const REMOTE_IDLE = read("remote", "running");
const OLD = { askedAt: NOW - GRACE };
const FRESH = { askedAt: NOW - GRACE + 1 };

type Row = [
  name: string,
  evidence: DelegationEvidence,
  observations: Partial<DelegationObservations>,
  state: Partial<DelegationDecisionState>,
  expected: object,
];

const TABLE: Row[] = [
  // A turn-end edge.
  ["edge failed", { source: "turn-end", outcome: "failed" }, {}, {}, closes("failed")],
  [
    "edge failed, even with a request undelivered",
    { source: "turn-end", outcome: "failed" },
    { undeliveredRequest: true },
    {},
    closes("failed"),
  ],
  ["edge stopped", { source: "turn-end", outcome: "stopped" }, {}, {}, closes("stopped")],
  [
    "edge stopped, request undelivered: it may still start and read it",
    { source: "turn-end", outcome: "stopped" },
    { undeliveredRequest: true },
    {},
    stays("request-undelivered"),
  ],
  [
    "edge completed, request undelivered",
    END,
    { undeliveredRequest: true },
    {},
    stays("request-undelivered"),
  ],
  ["edge completed needs the background read", END, {}, {}, CHECK],
  ["edge completed, quiet", END, QUIET, {}, closes("completed")],
  ["edge ignores grace", END, QUIET, FRESH, closes("completed")],
  [
    "edge ignores a running goal: its caller decided",
    END,
    { goalRunning: true, ...QUIET },
    {},
    closes("completed"),
  ],

  // The environment can no longer finish.
  ["sweep missing", read("sweep", "missing", "unknown"), {}, {}, closes("stopped")],
  ["sweep deleting", read("sweep", "deleting", "unknown"), {}, {}, closes("stopped")],
  ["sweep error", read("sweep", "error", "unknown"), {}, {}, closes("failed")],
  [
    "missing, even with a request undelivered",
    read("sweep", "missing", "unknown"),
    { undeliveredRequest: true },
    {},
    closes("stopped"),
  ],
  [
    "error, even with a request undelivered",
    read("remote", "error", "unknown"),
    { undeliveredRequest: true },
    {},
    closes("failed"),
  ],
  ["remote missing", read("remote", "missing", "unknown"), {}, {}, closes("stopped")],
  ["remote deleting", read("remote", "deleting", "unknown"), {}, {}, closes("stopped")],
  ["remote error", read("remote", "error", "unknown"), {}, {}, closes("failed")],
  ["remote creating", read("remote", "creating", "unknown"), {}, {}, stays("turn-running")],

  // A stopped environment.
  ["sweep stopped", read("sweep", "stopped", "unknown"), {}, FRESH, closes("stopped")],
  [
    "sweep stopped, request undelivered",
    read("sweep", "stopped", "unknown"),
    { undeliveredRequest: true },
    {},
    stays("request-undelivered"),
  ],
  [
    "remote stopped inside grace may just be launching",
    read("remote", "stopped", "unknown"),
    {},
    FRESH,
    stays("not-started"),
  ],
  ["remote stopped past grace", read("remote", "stopped", "unknown"), {}, OLD, closes("stopped")],
  [
    "remote stopped, seen working",
    read("remote", "stopped", "unknown"),
    {},
    { ...FRESH, seenWorking: true },
    closes("stopped"),
  ],
  [
    "remote stopped, request undelivered",
    read("remote", "stopped", "unknown"),
    { undeliveredRequest: true },
    OLD,
    stays("request-undelivered"),
  ],

  // A running environment, read rather than seen ending.
  [
    "working starts a fresh hold budget",
    read("sweep", "running", "working"),
    {},
    {},
    stays("turn-running", { resetBackgroundHold: true }),
  ],
  ["waiting is not finished", read("sweep", "running", "waiting"), {}, {}, stays("turn-running")],
  ["unknown is no news", read("sweep", "running", "unknown"), {}, {}, stays("turn-running")],
  [
    "remote stopped tab is no news",
    read("remote", "running", "stopped"),
    {},
    {},
    stays("turn-running"),
  ],
  ["idle inside grace", LOCAL_IDLE, {}, FRESH, stays("not-started")],
  [
    "idle with an unreadable request time",
    LOCAL_IDLE,
    {},
    { askedAt: Number.NaN },
    stays("not-started"),
  ],
  ["idle past grace needs the background read", LOCAL_IDLE, {}, OLD, CHECK],
  ["idle past grace, quiet", LOCAL_IDLE, QUIET, OLD, closes("completed")],
  [
    "idle, request undelivered",
    LOCAL_IDLE,
    { undeliveredRequest: true },
    OLD,
    stays("request-undelivered"),
  ],
  ["idle, goal running", LOCAL_IDLE, { goalRunning: true, ...QUIET }, OLD, stays("goal-running")],
  ["remote idle inside grace", REMOTE_IDLE, {}, FRESH, stays("not-started")],
  [
    "remote idle after working needs no grace",
    REMOTE_IDLE,
    QUIET,
    { ...FRESH, seenWorking: true },
    closes("completed"),
  ],
  ["remote idle past grace", REMOTE_IDLE, QUIET, OLD, closes("completed")],
  [
    "remote idle, request pending",
    REMOTE_IDLE,
    { undeliveredRequest: true },
    OLD,
    stays("request-undelivered"),
  ],
  ["remote idle, goal running", REMOTE_IDLE, { goalRunning: true }, OLD, stays("goal-running")],

  // Background work, on every path that can reach it.
  [
    "the coordinator stopped it: no read, no hold",
    END,
    {},
    { stopRequested: true },
    closes("completed"),
  ],
  [
    "a person is needed: no read, no hold",
    LOCAL_IDLE,
    { needsHuman: true },
    OLD,
    closes("completed"),
  ],
  [
    "a held report is the answer",
    END,
    { backgroundWork: { running: true, reportHeld: true } },
    {},
    closes("completed"),
  ],
  [
    "first seen running starts a hold",
    END,
    BUSY,
    {},
    stays("background-work", { backgroundHoldSince: NOW }),
  ],
  [
    "a hold keeps its start",
    LOCAL_IDLE,
    BUSY,
    { ...OLD, backgroundHoldSince: NOW - HOLD + 1 },
    stays("background-work", { backgroundHoldSince: NOW - HOLD + 1 }),
  ],
  [
    "a hold runs out and says so",
    REMOTE_IDLE,
    BUSY,
    { ...OLD, backgroundHoldSince: NOW - HOLD },
    closes("completed", { backgroundWorkTimeoutMs: HOLD }),
  ],
];

describe("decideDelegation", () => {
  test.each(TABLE)("%s", (_name, evidence, observations, state, expected) => {
    expect(decide(evidence, observations, state)).toEqual(expected as DelegationDecision);
  });

  test("a hold of no length closes at once", () => {
    expect(decide(END, { ...BUSY, backgroundHoldMs: 0 })).toEqual({
      action: "close",
      state: "completed",
      backgroundWorkTimeoutMs: 0,
    });
  });
});
