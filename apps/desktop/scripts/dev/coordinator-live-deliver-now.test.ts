import { describe, expect, test } from "bun:test";
import type { CoordinatorTranscriptMessage } from "./coordinator-live.js";
import type {
  DelegationMailMessage,
  DelegationObservation,
} from "./coordinator-live-delegation.js";
import {
  deliverNowApplies,
  deliverNowBodies,
  deliverNowCorrectionPrompt,
  deliverNowDelegatingPrompt,
  deliverNowOutcome,
  deliverNowTerminalApplies,
  deliverNowTerminalLaunchPrompt,
  evaluateDeliverNowScenario,
  launchedTabId,
  type DeliverNowProbe,
  type DeliverNowScenarioInput,
} from "./coordinator-live-deliver-now.js";

const probe: DeliverNowProbe = {
  platform: "codex",
  token: "abc123",
  startedPath: "/tmp/gates/started",
  gatePath: "/tmp/gates/finish.go",
  terminalStartedPath: "/tmp/gates/terminal-started",
  terminalGatePath: "/tmp/gates/terminal-finish.go",
};
const bodies = deliverNowBodies(probe);
const COORDINATOR = "coordinator:c1:conv-1";
const WORKER = "env-worker";
const OPENED = 10_000;
const iso = (at: number) => new Date(at).toISOString();

function mail(overrides: Partial<DelegationMailMessage>): DelegationMailMessage {
  return {
    id: "m",
    createdAt: iso(0),
    from: { kind: "coordinator" },
    toEnvironmentId: WORKER,
    toTabId: "startup-agent",
    placement: "injected",
    ...overrides,
  };
}

function observation(at: number, coordinator: string, worker: string): DelegationObservation {
  return {
    at,
    coordinatorPhase: coordinator,
    queueLength: 0,
    workerPhases: { [WORKER]: worker },
    delegations: [],
    mail: [],
  };
}

type Fixture = Omit<DeliverNowScenarioInput, "observations" | "mail"> & {
  observations: DelegationObservation[];
  mail: DelegationMailMessage[];
};

/** A run that qualifies: steered while parked, one corrected report, one wake. */
function passing(): Fixture {
  return {
    probe,
    coordinatorEnvironmentId: COORDINATOR,
    workerEnvironmentId: WORKER,
    correctionResults: [JSON.stringify({ message: { id: "m1" }, deliverNow: "steered" })],
    correctionEndedAt: 6_000,
    gateOpenedAt: OPENED,
    wakeWindowEndedAt: 30_000,
    observations: [
      observation(1_000, "working", "idle"),
      observation(2_000, "idle", "working"),
      observation(4_000, "working", "working"),
      observation(6_000, "idle", "working"),
      observation(9_000, "idle", "working"),
      observation(12_000, "idle", "idle"),
      observation(14_000, "working", "idle"),
      observation(16_000, "idle", "idle"),
      observation(29_000, "idle", "idle"),
    ],
    mail: [
      mail({
        id: "m1",
        body: bodies.correction,
        injectedAt: iso(5_000),
        injectedVia: "steer",
      }),
      mail({
        id: "r1",
        from: { kind: "tab", environmentId: WORKER, tabId: "startup-agent" },
        toEnvironmentId: COORDINATOR,
        toTabId: "coord-tab",
        body: bodies.corrected,
      }),
    ],
    workerMessages: [
      { role: "user", content: "This is a test worker." },
      { role: "user", content: `<orkestrator-peer-message>${bodies.correction}` },
    ] as CoordinatorTranscriptMessage[],
    delegations: [
      {
        environmentId: WORKER,
        requestedAt: iso(1_500),
        workerTabId: "startup-agent",
        state: "completed",
        wokenAt: iso(13_000),
      },
    ],
    escapedInteractions: [],
    workerInteractions: [],
  };
}

const failed = (input: DeliverNowScenarioInput) =>
  evaluateDeliverNowScenario(input)
    .filter((item) => !item.passed)
    .map((item) => item.name);

describe("deliver-now prompts", () => {
  test("the worker parks on the gate and reports the body it was told to use", () => {
    const prompt = deliverNowDelegatingPrompt(probe);
    expect(prompt).toContain('agent "codex"');
    expect(prompt).toContain("deliver-now-abc123");
    expect(prompt).toContain("/tmp/gates/started");
    expect(prompt).toContain("/tmp/gates/finish.go");
    expect(prompt).toContain(bodies.uncorrected);
    expect(deliverNowCorrectionPrompt(probe, WORKER)).toContain("deliverNow true");
    expect(deliverNowCorrectionPrompt(probe, WORKER)).toContain(JSON.stringify(bodies.correction));
    expect(bodies.correction).toContain(bodies.corrected);
  });

  test("the steering providers run it; Grok and OpenCode, which cannot steer, are skipped", () => {
    for (const platform of ["claude", "codex", "pi", "cursor"] as const) {
      expect(deliverNowApplies(platform)).toBe(true);
    }
    for (const platform of ["grok", "opencode"] as const) {
      expect(deliverNowApplies(platform)).toBe(false);
    }
  });

  test("the terminal case is Claude's alone and launches claude-tmux", () => {
    expect(deliverNowTerminalApplies("claude")).toBe(true);
    for (const platform of ["codex", "pi", "cursor"] as const) {
      expect(deliverNowTerminalApplies(platform)).toBe(false);
    }
    expect(deliverNowTerminalLaunchPrompt(probe, WORKER)).toContain('tabType "claude-tmux"');
  });

  test("tool outputs yield the outcome and the launched tab", () => {
    expect(deliverNowOutcome('{"deliverNow": "unsupported, queued"}')).toBe("unsupported, queued");
    expect(deliverNowOutcome('{"message":{}}')).toBeNull();
    expect(launchedTabId('{"environmentId":"e","tabId":"tmux-1"}')).toBe("tmux-1");
  });
});

describe("deliver-now verdict", () => {
  test("a steer into the parked turn, a corrected report and one wake qualify", () => {
    expect(failed(passing())).toEqual([]);
  });

  test("a correction that waited for idle fails, however the report reads", () => {
    const input = passing();
    input.correctionResults = ['{"deliverNow":"queued until idle"}'];
    input.mail[0] = { ...input.mail[0]!, injectedVia: undefined, injectedAt: iso(12_000) };
    expect(failed(input)).toEqual(["correction-steered", "steered-into-running-turn"]);
  });

  test("verifying is not a pass: it does not prove the turn read the mail", () => {
    const input = passing();
    input.correctionResults = ['{"deliverNow":"verifying"}'];
    expect(failed(input)).toEqual(["correction-steered"]);
  });

  test("a worker that went idle before the gate opened fails", () => {
    const input = passing();
    input.observations.splice(4, 0, observation(8_000, "idle", "idle"));
    expect(failed(input)).toEqual(["worker-busy-until-gate"]);
  });

  test("an uncorrected report, a missing transcript row and a second wake each fail", () => {
    const input = passing();
    input.mail[1] = { ...input.mail[1]!, body: bodies.uncorrected };
    input.workerMessages = [{ role: "user", content: "This is a test worker." }];
    input.observations.push(observation(20_000, "working", "idle"));
    expect(failed(input)).toEqual([
      "correction-in-worker-transcript",
      "report-reflects-correction",
      "one-wake-at-turn-end",
    ]);
  });

  test("turns after the wake window (the terminal case) are not wakes", () => {
    const input = passing();
    input.observations.push(observation(31_000, "working", "idle"));
    expect(failed(input)).toEqual([]);
  });

  test("Claude's terminal case needs unsupported, the hold note and delivery after its gate", () => {
    const tmux = (placement: string, extra: Partial<DelegationMailMessage> = {}) =>
      mail({
        toTabId: "tmux-1",
        body: bodies.terminalCorrection,
        placement,
        ...extra,
      });
    const input: DeliverNowScenarioInput = {
      ...passing(),
      probe: { ...probe, platform: "claude" },
      terminal: {
        tabId: "tmux-1",
        correctionResults: ['{"deliverNow":"unsupported, queued"}'],
        mailReads: [
          [tmux("pending-inject", { placementReason: "steer-unsupported" })],
          [tmux("injected", { injectedAt: iso(50_000) })],
        ],
        gateOpenedAt: 40_000,
      },
    };
    // The bodies carry the probe's token, which the platform does not change.
    expect(failed(input)).toEqual([]);

    input.terminal = {
      ...input.terminal!,
      correctionResults: ['{"deliverNow":"delivered"}'],
      mailReads: [[tmux("injected", { injectedAt: iso(35_000) })]],
    };
    expect(failed(input)).toEqual([
      "terminal-unsupported-queued",
      "terminal-held-for-turn-end",
      "terminal-delivered-at-turn-end",
    ]);
  });

  test("a run that never launched its worker fails without throwing", () => {
    const input = passing();
    delete input.workerEnvironmentId;
    input.correctionResults = [];
    expect(failed(input)).toContain("worker-launched");
  });
});
