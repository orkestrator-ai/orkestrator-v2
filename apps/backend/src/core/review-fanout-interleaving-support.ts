/**
 * Seeded interleaving harness for the reviewer fan-out (0027, Code item 4).
 *
 * Every asynchronous operation the runner reaches — the host's commits, the
 * provider's session creation, prompt sends, status and result reads, aborts,
 * and the result-slot calls — returns a promise that stays pending until the
 * driver settles it. The driver settles one pending operation per step, chosen
 * by a seeded PRNG, so concurrent reviewer tasks interleave differently for
 * every seed and identically for the same seed.
 *
 * On top of that order the scenario injects, at seed-chosen steps:
 * - user cancellation (applied at the next pass boundary, because the service
 *   serializes `cancel` with passes on the workflow lock), and stopping one
 *   reviewer, the same way;
 * - controller fence loss: another controller takes the lease, the old
 *   runner's saves and fence checks start throwing a `*FenceError`, its
 *   in-flight provider calls keep settling, and the new owner starts from the
 *   last committed state at once;
 * - a backend crash: the runner's pending operations never settle; each
 *   in-flight send or save independently did or did not take effect; a new
 *   runner starts from the last committed state.
 *
 * The fake provider keeps its own state across owners, like an environment
 * that outlives the backend, and checks the dispatch invariants at the moment
 * each call is made. Violations are collected rather than thrown, because a
 * throw inside the provider would be absorbed by the runner as a reviewer
 * failure and hide the bug it was meant to report.
 *
 * Nothing here patches a module: the runner sees only its public host and
 * provider contracts.
 */
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { ProviderSessionFailedError, ProviderUnreachableError } from "./agent-provider-contract.js";
import {
  AmbiguousPromptDispatchError,
  ProviderDispatchPreparationError,
  type BuildPipelineProvider,
  type ProviderSendOptions,
} from "./build-pipeline-provider.js";
import { efficiencyPlatform } from "./multi-review-efficiency.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { flushMicrotasks } from "./recurring-test-support.js";
import {
  ReviewFanoutRunner,
  type ReviewFanoutHost,
  type ReviewFanoutOutcome,
} from "./review-fanout.js";
import {
  clearReviewerAdmission,
  compactReviewerAdmissionQueue,
} from "./review-fanout-admission.js";
import {
  reviewFanoutConcurrency,
  type ReviewFanoutConcurrency,
} from "./review-fanout-scheduler.js";

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** mulberry32: a tiny, well-distributed 32-bit PRNG. Never `Math.random`. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class SeededRandom {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** Integer in `[0, maxExclusive)`. */
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** Integer in `[min, max]`. */
  between(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)]!;
  }
}

/**
 * The seeds a suite runs. CI runs `defaultCount` seeds starting at 1.
 *
 * `ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS` widens a local run: a number runs
 * that many seeds (`=500`), and a comma-separated list runs exactly those
 * (`=17,4242`), which is how a failure reported as "seed N" is replayed.
 */
export function interleavingSeeds(defaultCount: number): number[] {
  const configured = process.env.ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS?.trim();
  if (configured) {
    if (configured.includes(",")) {
      return configured
        .split(",")
        .map((entry) => Number.parseInt(entry.trim(), 10))
        .filter((seed) => Number.isSafeInteger(seed));
    }
    const count = Number.parseInt(configured, 10);
    if (Number.isSafeInteger(count) && count > 0) {
      return Array.from({ length: count }, (_, index) => index + 1);
    }
  }
  return Array.from({ length: defaultCount }, (_, index) => index + 1);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export type ReviewerAgent = "claude" | "codex" | "opencode";

/** What the provider does with one reviewer's turns. */
export type ReviewerScript =
  /** The first turn submits a valid report. */
  | "complete"
  /** The first turn fails for a real reason (a usage limit). */
  | "fail"
  /** A provider restart cuts the first turn short; the continuation reports. */
  | "restartOnce"
  /** A restart cuts the first turn and the continuation short. */
  | "restartTwice"
  /** The first report is malformed; the schema repair reports. */
  | "invalidOnce"
  /** The first turn ends without submitting; the reminder (tool mode) reports. */
  | "noSubmit"
  /** The first send's acknowledgement is lost; the turn may or may not run. */
  | "ambiguous"
  /** The first send is refused before the prompt was written. */
  | "prepFail"
  /** The bridge is unreachable for a few status reads, then recovers. */
  | "unreachable"
  /** Session creation fails. */
  | "createFail";

export type PromptKind = "original" | "repair" | "reminder" | "continuation";

export interface ReviewerPlan {
  id: string;
  agent: ReviewerAgent;
  script: ReviewerScript;
  /** Status reads a turn answers `running` before it finishes. */
  runningPolls: number;
  unreachablePolls: number;
  /** For `ambiguous`: whether the provider ran the turn it did not acknowledge. */
  ambiguousRan: boolean;
}

export type DisruptionKind = "cancel" | "stop" | "takeover" | "crash";

export interface Disruption {
  kind: DisruptionKind;
  /** Driver step at which it happens; skipped if the panel settled first. */
  atStep: number;
}

export interface Scenario {
  seed: number;
  reviewers: ReviewerPlan[];
  concurrency: Partial<ReviewFanoutConcurrency>;
  reviewerMode: "plan" | "build";
  disruptions: Disruption[];
}

export type ScenarioFlavour = "plain" | "cancellation" | "fence-loss" | "restart" | "chaos";

const RESTART_SCRIPTS: readonly ReviewerScript[] = ["restartOnce", "restartTwice"];
const SCRIPTS: readonly ReviewerScript[] = [
  "complete",
  "complete",
  "complete",
  "fail",
  "restartOnce",
  "restartTwice",
  "invalidOnce",
  "noSubmit",
  "ambiguous",
  "prepFail",
  "unreachable",
  "createFail",
];

/** A seed's panel, limits and disruptions. Planned from its own PRNG stream. */
export function planScenario(seed: number, flavour: ScenarioFlavour): Scenario {
  const rng = new SeededRandom(seed * 7_919 + flavour.length);
  const size = rng.between(2, 8);
  const reviewers: ReviewerPlan[] = Array.from({ length: size }, (_, index) => {
    const agent = rng.pick<ReviewerAgent>(["claude", "codex", "opencode"]);
    let script = rng.pick(SCRIPTS);
    // Only the Codex and Claude bridges report a restart interruption.
    if (agent === "opencode" && RESTART_SCRIPTS.includes(script)) script = "complete";
    return {
      id: `reviewer-${index + 1}`,
      agent,
      script,
      runningPolls: rng.between(0, 3),
      unreachablePolls: rng.between(1, 3),
      ambiguousRan: rng.chance(0.5),
    };
  });
  const concurrency: Partial<ReviewFanoutConcurrency> = rng.chance(0.25)
    ? {}
    : {
        admission: rng.between(1, 3),
        observation: rng.between(1, 4),
        provider: rng.between(1, 3),
      };
  const at = () => rng.between(1, 90);
  const disruptions: Disruption[] = [];
  const add = (kind: DisruptionKind) => disruptions.push({ kind, atStep: at() });
  switch (flavour) {
    case "plain":
      break;
    case "cancellation":
      add("cancel");
      if (rng.chance(0.5)) add("stop");
      break;
    case "fence-loss":
      add("takeover");
      if (rng.chance(0.3)) add("takeover");
      break;
    case "restart":
      add("crash");
      if (rng.chance(0.3)) add("crash");
      break;
    case "chaos":
      for (const kind of ["takeover", "crash", "stop", "cancel"] as const) {
        if (rng.chance(kind === "cancel" ? 0.35 : 0.6)) add(kind);
      }
      break;
  }
  disruptions.sort((left, right) => left.atStep - right.atStep);
  return {
    seed,
    reviewers,
    concurrency,
    reviewerMode: rng.chance(0.5) ? "plan" : "build",
    disruptions,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RESTARTED =
  "Codex restarted before this turn finished, so its work stopped partway. Send a message to continue.";

const policy = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "full" },
  "looped-review",
);

/** The report a reviewer's provider submits; the summary names the reviewer. */
export function interleavingReport(reviewerId: string): StructuredReviewReport {
  return {
    reviewScope: {
      targetBranch: "main",
      baseRef: "origin/main...HEAD",
      commit: null,
      filesReviewed: ["src/a.ts"],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [],
      commandsNotRun: [],
      limitations: [],
    },
    whatChanged: {
      overview: "Change",
      before: "Before",
      after: "After",
      keyCodeChanges: [],
      userImpact: "Impact",
    },
    riskProfile: {
      changeTypes: ["feature"],
      riskAreas: [],
      overallRisk: "low",
      reasoning: "Small",
    },
    testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
    strengths: [],
    issues: [],
    testCoverageGaps: [],
    verdict: { ready: "yes", reasoning: "Ready" },
    summaryOfChange: "Change",
    reviewSummary: `Report from ${reviewerId}`,
  };
}

export class InterleavingFenceError extends Error {
  constructor() {
    super("The interleaving controller lease was lost");
    this.name = "InterleavingFenceError";
  }
}

function isFenceError(error: unknown): boolean {
  return error instanceof Error && error.name.endsWith("FenceError");
}

function classifyPrompt(prompt: string): PromptKind {
  if (prompt.includes("Continue the review from where it stopped")) return "continuation";
  if (prompt.includes("Orkestrator has not received your structured report")) return "reminder";
  if (prompt.includes("Only the structured report you emitted was rejected")) return "repair";
  return "original";
}

function settled(reviewer: Pick<ReviewerRecord, "status">): boolean {
  return (
    reviewer.status === "completed" ||
    reviewer.status === "failed" ||
    reviewer.status === "cancelled"
  );
}

/** Mirrors the runner's pool choice for a reviewer at the start of a pass. */
function poolFor(reviewer: ReviewerRecord): "admission" | "observation" {
  return reviewer.status === "pending" ||
    reviewer.dispatchState === "prepared" ||
    reviewer.dispatchState === "dispatching"
    ? "admission"
    : "observation";
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

type TurnOutcome = "report" | "invalid" | "none" | "fail" | "restart";

interface Turn {
  requestId: string;
  kind: PromptKind;
  tool: boolean;
  remainingRunning: number;
  outcome: TurnOutcome;
  finished: boolean;
  /**
   * False between the bridge journaling the request and the turn starting.
   * Status in that window still describes the previous turn, as it does on
   * the real bridges, which clear a restart notice only when the next turn
   * starts.
   */
  started: boolean;
}

interface FakeSession {
  id: string;
  reviewerId: string;
  turns: Turn[];
  /** Sends whose call has started and not settled: the ambiguous window. */
  inTransit: Set<string>;
  unreachableLeft: number;
  messageTick: number;
  structured: Map<string, StructuredOutputResult<unknown>>;
}

interface ResultSlot {
  reviewerId: string;
  open: boolean;
  value?: StructuredOutputResult<unknown>;
}

interface Committed {
  phase: "reviewing" | "cancelling" | "cancelled";
  reviewers: ReviewerRecord[];
}

interface Owner {
  token: number;
  phase: Committed["phase"];
  reviewers: ReviewerRecord[];
  tracker: MultiReviewProgressTracker;
  host: ReviewFanoutHost;
  alive: boolean;
  activity?: { kind: "pass" | "control"; settled: boolean };
  passes: number;
  pools: Map<string, { pool: "admission" | "observation"; group: string }>;
  savesInFlight: number;
}

interface PendingOp {
  owner: Owner;
  reviewerId?: string;
  label: string;
  settle(): void;
  crash(): void;
}

export interface ReviewerLedger {
  accepted: Record<PromptKind, number>;
  sendAttempts: Map<string, { calls: number; refused: number }>;
  createFailed: boolean;
  firstSendSeen: boolean;
  /** A crash dropped one of its sends, or a non-owner aborted its session. */
  tainted: boolean;
  /** An owner change happened while its committed state was unsettled. */
  switchedWhileLive: boolean;
  /** Request ids the store ever held as `dispatching`, in commit order. */
  durableDispatches: string[];
  /**
   * Durable `dispatching` requests the provider never ran: no send was
   * attempted (the fence was lost, or the backend died, between the durable
   * write and the send), or every attempt was refused before the prompt was
   * written and the reset to `prepared` never committed.
   */
  unsentDispatches: string[];
  /** Turn kinds in the order the provider accepted them. */
  acceptedKinds: PromptKind[];
  /**
   * Status reads answered while one of its sends was still in transit, so
   * the answer described the previous turn. The recovery gate makes this
   * unreachable: a recovered `dispatching` request is observed only once the
   * provider confirms it.
   */
  staleObservations: number;
  /**
   * Status reads answered after a request was journaled but before its turn
   * started, so the answer described the previous turn (0112, item 2).
   */
  lateStartReads: number;
}

export interface InterleavingResult {
  scenario: Scenario;
  violations: string[];
  finalReviewers: ReviewerRecord[];
  committed: Committed;
  outcome?: ReviewFanoutOutcome;
  cancelled: boolean;
  stopped: string[];
  unsettledAtCancel: string[];
  fired: DisruptionKind[];
  steps: number;
  sends: number;
  commits: number;
  maxConcurrentReviewers: number;
  owners: number;
  ledgers: Record<string, ReviewerLedger>;
  /** Op labels in settle order; equal for equal seeds. */
  trace: string[];
  /** A fenced owner's pass resolved instead of rejecting with its fence error. */
  fencedPassesResolved: number;
  /** Provider I/O a fenced owner started after it lost the lease. */
  fencedIo: string[];
}

const MAX_PASSES = 60;
const MAX_STEPS = 40_000;
const FLUSH_ROUNDS = 64;

export class InterleavingWorld {
  private readonly rng: SeededRandom;
  /**
   * Its own stream, so modelling late turn starts leaves every other draw,
   * and so every seed's interleaving, as it was without them.
   */
  private readonly startRng: SeededRandom;
  private readonly plans = new Map<string, ReviewerPlan>();
  private readonly ledgers = new Map<string, ReviewerLedger>();
  private readonly sessions = new Map<string, FakeSession>();
  private readonly sessionsByKey = new Map<string, FakeSession>();
  private readonly results = new Map<string, ResultSlot>();
  private readonly acceptedRequests = new Map<string, string>();
  private readonly limits: ReviewFanoutConcurrency;
  private pending: PendingOp[] = [];
  private readonly owners: Owner[] = [];
  private current!: Owner;
  private nextToken = 0;
  private ownerToken = 0;
  private committed: Committed;
  private readonly terminalCommitted = new Map<string, ReviewerRecord["status"]>();
  private readonly violations: string[] = [];
  private readonly trace: string[] = [];
  private readonly fired: DisruptionKind[] = [];
  /** Durably stopped reviewers. */
  private readonly stopped = new Set<string>();
  /** Reviewers a stop picked, whether or not its save landed. */
  private readonly stopPicked = new Set<string>();
  private readonly unsettledAtCancel = new Set<string>();
  private cancelRequested = false;
  private cancelled = false;
  private stopRequested = false;
  private finished = false;
  private outcome?: ReviewFanoutOutcome;
  private steps = 0;
  private sends = 0;
  private commits = 0;
  private maxConcurrentReviewers = 0;
  private fencedPassesResolved = 0;
  private readonly fencedIo: string[] = [];
  private sessionCount = 0;

  constructor(private readonly scenario: Scenario) {
    this.rng = new SeededRandom(scenario.seed ^ 0x5bd1e995);
    this.startRng = new SeededRandom(scenario.seed ^ 0x27d4eb2f);
    this.limits = reviewFanoutConcurrency(scenario.concurrency);
    for (const plan of scenario.reviewers) {
      this.plans.set(plan.id, plan);
      this.ledgers.set(plan.id, {
        accepted: { original: 0, repair: 0, reminder: 0, continuation: 0 },
        sendAttempts: new Map(),
        createFailed: false,
        firstSendSeen: false,
        tainted: false,
        switchedWhileLive: false,
        durableDispatches: [],
        unsentDispatches: [],
        acceptedKinds: [],
        staleObservations: 0,
        lateStartReads: 0,
      });
    }
    this.committed = {
      phase: "reviewing",
      reviewers: scenario.reviewers.map((plan) => ({
        id: plan.id,
        agent: plan.agent,
        model: "model",
        status: "pending",
      })),
    };
  }

  private violate(message: string): void {
    this.violations.push(`step ${this.steps}: ${message}`);
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  private op<T>(
    owner: Owner,
    reviewerId: string | undefined,
    label: string,
    effect: () => T,
    onCrash?: () => void,
  ): Promise<T> {
    if (!owner.alive) return new Promise<T>(() => {});
    if (owner.token !== this.ownerToken && label !== "save" && label !== "fence") {
      // Provider I/O started after the lease moved. Recorded, not failed:
      // fence reads take no lease, so a check-then-call window is by design.
      this.fencedIo.push(`${label}${reviewerId ? `:${reviewerId}` : ""}`);
    }
    return new Promise<T>((resolve, reject) => {
      const entry: PendingOp = {
        owner,
        ...(reviewerId ? { reviewerId } : {}),
        label,
        settle: () => {
          this.trace.push(`${owner.token}:${label}${reviewerId ? `:${reviewerId}` : ""}`);
          try {
            resolve(effect());
          } catch (error) {
            reject(error);
          }
        },
        crash: () => onCrash?.(),
      };
      this.pending.push(entry);
      this.checkConcurrency(owner);
    });
  }

  /**
   * The scheduler bounds reviewer tasks, not calls, so the number of distinct
   * reviewers with a call in flight is a lower bound on its active tasks.
   */
  private checkConcurrency(owner: Owner): void {
    if (owner.activity?.kind !== "pass" || owner.activity.settled) return;
    const byPool = {
      admission: new Set<string>(),
      observation: new Set<string>(),
    };
    const byGroup = new Map<string, Set<string>>();
    for (const entry of this.pending) {
      if (entry.owner !== owner || !entry.reviewerId) continue;
      const placement = owner.pools.get(entry.reviewerId);
      if (!placement) continue;
      byPool[placement.pool].add(entry.reviewerId);
      const group = byGroup.get(placement.group) ?? new Set<string>();
      group.add(entry.reviewerId);
      byGroup.set(placement.group, group);
    }
    const total = byPool.admission.size + byPool.observation.size;
    this.maxConcurrentReviewers = Math.max(this.maxConcurrentReviewers, total);
    if (byPool.admission.size > this.limits.admission) {
      this.violate(
        `${byPool.admission.size} reviewers in admission (limit ${this.limits.admission})`,
      );
    }
    if (byPool.observation.size > this.limits.observation) {
      this.violate(
        `${byPool.observation.size} reviewers in observation (limit ${this.limits.observation})`,
      );
    }
    for (const [group, members] of byGroup) {
      if (members.size > this.limits.provider) {
        this.violate(`${members.size} ${group} reviewers active (limit ${this.limits.provider})`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------

  private apply(owner: Owner, snapshot: Committed): void {
    if (owner.token !== this.ownerToken) {
      this.violate(`owner ${owner.token} committed without the lease`);
      return;
    }
    for (const reviewer of snapshot.reviewers) {
      const before = this.terminalCommitted.get(reviewer.id);
      if (before && before !== reviewer.status) {
        this.violate(`${reviewer.id} regressed from durable ${before} to ${reviewer.status}`);
      }
      if (settled(reviewer)) this.terminalCommitted.set(reviewer.id, reviewer.status);
      // A stop is durable once its save lands, even one a crash completed.
      if (
        snapshot.phase === "reviewing" &&
        reviewer.status === "cancelled" &&
        this.stopPicked.has(reviewer.id)
      ) {
        this.stopped.add(reviewer.id);
      }
      const ledger = this.ledgers.get(reviewer.id);
      if (
        ledger &&
        reviewer.dispatchState === "dispatching" &&
        reviewer.requestId &&
        !ledger.durableDispatches.includes(reviewer.requestId)
      ) {
        ledger.durableDispatches.push(reviewer.requestId);
      }
    }
    this.committed = snapshot;
    this.commits += 1;
  }

  private save(owner: Owner): Promise<void> {
    if (owner.savesInFlight > 0) this.violate(`owner ${owner.token} overlapped two saves`);
    owner.savesInFlight += 1;
    // A save serializes the record when it runs, not when it lands.
    const snapshot: Committed = {
      phase: owner.phase,
      reviewers: structuredClone(owner.reviewers),
    };
    return this.op(
      owner,
      undefined,
      "save",
      () => {
        owner.savesInFlight -= 1;
        // The commit re-checks the fence inside its own transaction.
        if (owner.token !== this.ownerToken) throw new InterleavingFenceError();
        this.apply(owner, snapshot);
      },
      () => {
        owner.savesInFlight -= 1;
        // The transaction either landed before the process died or it did not.
        if (owner.token === this.ownerToken && this.rng.chance(0.5)) this.apply(owner, snapshot);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Provider
  // -------------------------------------------------------------------------

  private session(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }

  private reviewerForKey(key: string | undefined): string {
    const id = key?.replace(/^key-/, "");
    if (!id || !this.plans.has(id)) throw new Error(`unknown session key ${key}`);
    return id;
  }

  private assertMayStartTurn(reviewerId: string, what: string): void {
    if (this.committed.phase !== "reviewing") {
      this.violate(`${what} for ${reviewerId} after cancellation was committed`);
    }
    if (this.stopped.has(reviewerId)) this.violate(`${what} for stopped ${reviewerId}`);
  }

  private createSession(owner: Owner, key: string | undefined): Promise<string> {
    const reviewerId = this.reviewerForKey(key);
    this.assertMayStartTurn(reviewerId, "session creation");
    return this.op(owner, reviewerId, "create", () => {
      const plan = this.plans.get(reviewerId)!;
      const ledger = this.ledgers.get(reviewerId)!;
      if (plan.script === "createFail" && !ledger.createFailed) {
        ledger.createFailed = true;
        throw new Error(`The ${plan.agent} bridge could not create the reviewer session`);
      }
      // Bridges key sessions by the client session key, so a re-create after
      // a lost commit lands in the same session.
      const existing = this.sessionsByKey.get(key!);
      if (existing) return existing.id;
      this.sessionCount += 1;
      const session: FakeSession = {
        id: `session-${this.sessionCount}`,
        reviewerId,
        turns: [],
        inTransit: new Set(),
        unreachableLeft: plan.script === "unreachable" ? plan.unreachablePolls : 0,
        messageTick: 0,
        structured: new Map(),
      };
      this.sessions.set(session.id, session);
      this.sessionsByKey.set(key!, session);
      return session.id;
    });
  }

  private send(
    owner: Owner,
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void> {
    const session = this.session(sessionId);
    const reviewerId = session.reviewerId;
    const requestId = options.requestId;
    const ledger = this.ledgers.get(reviewerId)!;
    const plan = this.plans.get(reviewerId)!;
    const kind = classifyPrompt(prompt);
    this.sends += 1;
    if (!requestId) {
      this.violate(`${reviewerId} sent a prompt without a request id`);
      return Promise.resolve();
    }
    // Invariant 3: the send is the next fallible step after a durable
    // `dispatching` for exactly this request id.
    const durable = this.committed.reviewers.find((reviewer) => reviewer.id === reviewerId);
    if (durable?.requestId !== requestId || durable.dispatchState !== "dispatching") {
      this.violate(
        `${reviewerId} sent ${kind} while the store held ${durable?.dispatchState ?? "nothing"} for ${
          durable?.requestId === requestId ? "it" : "another request"
        }`,
      );
    }
    if (owner.token !== this.ownerToken) {
      this.violate(`${reviewerId} sent ${kind} from a fenced controller`);
    }
    this.assertMayStartTurn(reviewerId, `a ${kind} prompt`);
    const attempts = ledger.sendAttempts.get(requestId) ?? {
      calls: 0,
      refused: 0,
    };
    if (attempts.calls > attempts.refused) {
      this.violate(`${reviewerId} re-sent request ${kind} that was not refused`);
    }
    attempts.calls += 1;
    ledger.sendAttempts.set(requestId, attempts);
    for (const other of session.inTransit) {
      this.violate(`${reviewerId} sent ${kind} while an earlier send (${other}) was ambiguous`);
    }
    session.inTransit.add(requestId);
    const firstOriginal = kind === "original" && !ledger.firstSendSeen;
    ledger.firstSendSeen ||= kind === "original";
    // The tool transport sends no schema; the result arrives through its slot.
    const tool = options.schema === undefined;
    const accept = () => this.acceptTurn(session, requestId, kind, tool);
    return this.op(
      owner,
      reviewerId,
      "send",
      () => {
        session.inTransit.delete(requestId);
        if (firstOriginal && plan.script === "prepFail") {
          attempts.refused += 1;
          throw new ProviderDispatchPreparationError("MCP registration failed before the prompt");
        }
        if (firstOriginal && plan.script === "ambiguous") {
          if (plan.ambiguousRan) accept();
          throw new AmbiguousPromptDispatchError("The prompt acknowledgement was lost");
        }
        accept();
      },
      () => {
        session.inTransit.delete(requestId);
        // The request reached the bridge before the backend died, or it did
        // not; either way the script's own answer to it no longer applies.
        if (firstOriginal && plan.script === "ambiguous") ledger.tainted = true;
        if (this.rng.chance(0.5)) accept();
        else ledger.tainted = true;
      },
    );
  }

  private acceptTurn(session: FakeSession, requestId: string, kind: PromptKind, tool: boolean) {
    const reviewerId = session.reviewerId;
    const plan = this.plans.get(reviewerId)!;
    const ledger = this.ledgers.get(reviewerId)!;
    if (this.acceptedRequests.has(requestId)) {
      this.violate(`${reviewerId} request ${kind} was accepted twice`);
    }
    this.acceptedRequests.set(requestId, reviewerId);
    ledger.accepted[kind] += 1;
    ledger.acceptedKinds.push(kind);
    const bound = { original: 1, repair: 3, reminder: 1, continuation: 1 }[kind];
    if (ledger.accepted[kind] > bound) {
      this.violate(
        `${reviewerId} received ${ledger.accepted[kind]} ${kind} turns (bound ${bound})`,
      );
    }
    const outcome: TurnOutcome =
      kind === "original"
        ? (
            {
              complete: "report",
              fail: "fail",
              restartOnce: "restart",
              restartTwice: "restart",
              invalidOnce: "invalid",
              noSubmit: "none",
              ambiguous: "report",
              prepFail: "report",
              unreachable: "report",
              createFail: "report",
            } as const
          )[plan.script]
        : kind === "continuation" && plan.script === "restartTwice"
          ? "restart"
          : "report";
    session.turns.push({
      requestId,
      kind,
      tool,
      remainingRunning: plan.runningPolls,
      outcome,
      finished: false,
      // A continuation follows a restart notice, which is what a late start
      // can be mistaken for.
      started: kind !== "continuation" || this.startRng.chance(0.5),
    });
  }

  private finishTurn(session: FakeSession, turn: Turn): void {
    turn.finished = true;
    const plan = this.plans.get(session.reviewerId)!;
    let result: StructuredOutputResult<unknown> | undefined;
    if (turn.outcome === "report" || turn.outcome === "invalid") {
      result = {
        ok: true,
        provider: plan.agent,
        requestId: turn.requestId,
        value:
          turn.outcome === "report" ? interleavingReport(session.reviewerId) : { malformed: true },
      };
    } else if (turn.outcome === "restart" && !turn.tool) {
      result = {
        ok: false,
        provider: plan.agent,
        requestId: turn.requestId,
        error: {
          code: "provider_error",
          provider: plan.agent,
          message: RESTARTED,
          retryable: true,
        },
      };
    }
    if (!result) return;
    if (turn.tool) {
      const slot = this.results.get(turn.requestId);
      if (slot?.open) slot.value = result;
    } else {
      session.structured.set(turn.requestId, result);
    }
  }

  private observe(sessionId: string) {
    const session = this.session(sessionId);
    const plan = this.plans.get(session.reviewerId)!;
    const ledger = this.ledgers.get(session.reviewerId)!;
    let turn = session.turns.at(-1);
    if (session.inTransit.size > 0) {
      ledger.staleObservations += 1;
      // The answer belongs to an earlier turn; nothing about it is this
      // reviewer's own outcome.
      ledger.tainted = true;
    }
    if (turn && session.unreachableLeft > 0) {
      session.unreachableLeft -= 1;
      throw new ProviderUnreachableError(`${plan.agent} bridge is not reachable`);
    }
    if (turn && !turn.started) {
      // Journaled, not started: this read still sees the previous turn, and
      // the next one sees this turn running.
      turn.started = true;
      ledger.lateStartReads += 1;
      turn = session.turns.at(-2);
      if (!turn?.finished) return { status: "idle" as const };
    } else if (turn && !turn.finished) {
      if (turn.remainingRunning > 0) {
        turn.remainingRunning -= 1;
        return { status: "running" as const };
      }
      this.finishTurn(session, turn);
    }
    if (turn?.outcome === "fail") {
      throw new ProviderSessionFailedError(plan.agent, "usage limit reached");
    }
    if (turn?.outcome === "restart") {
      // As the Claude and Codex bridges report it: naming the request whose
      // turn the restart cut short.
      throw new ProviderSessionFailedError(plan.agent, RESTARTED, {
        interruption: "restart",
        interruptedRequestId: turn.requestId,
      });
    }
    return { status: "idle" as const };
  }

  private abort(owner: Owner, reviewerId: string, sessionId: string): Promise<void> {
    const abortNow = () => {
      if (owner.token !== this.ownerToken) this.ledgers.get(reviewerId)!.tainted = true;
      const turn = this.session(sessionId).turns.at(-1);
      if (turn && !turn.finished) {
        turn.finished = true;
        turn.outcome = "none";
      }
    };
    return this.op(owner, reviewerId, "abandon", abortNow, () => {
      if (this.rng.chance(0.5)) {
        this.ledgers.get(reviewerId)!.tainted = true;
        abortNow();
      }
    });
  }

  private provider(owner: Owner): BuildPipelineProvider {
    const reviewerOf = (sessionId: string) => this.session(sessionId).reviewerId;
    return {
      createSession: (_phase: string, _label: string, options: { clientSessionKey?: string }) =>
        this.createSession(owner, options.clientSessionKey),
      send: (sessionId: string, prompt: string, options: ProviderSendOptions) =>
        this.send(owner, sessionId, prompt, options),
      status: async () => "idle" as const,
      observeSession: (sessionId: string) =>
        this.op(owner, reviewerOf(sessionId), "status", () => this.observe(sessionId)),
      // Completion is unproven only while the request is still in transit.
      settleTurn: async (sessionId: string, requestId: string) =>
        !this.session(sessionId).inTransit.has(requestId),
      // As the HTTP bridges answer: positive evidence or `unknown`, never
      // "not sent".
      dispatchStatus: async (_sessionId: string, requestId: string) =>
        this.acceptedRequests.has(requestId) ? ("dispatched" as const) : ("unknown" as const),
      messages: (sessionId: string) =>
        this.op(owner, reviewerOf(sessionId), "messages", () => {
          const session = this.session(sessionId);
          session.messageTick += 1;
          return [
            {
              id: `message-${session.messageTick}`,
              role: "assistant",
              text: "working",
            },
          ];
        }),
      structured: (sessionId: string, requestId: string) =>
        this.op(
          owner,
          reviewerOf(sessionId),
          "structured",
          () => this.session(sessionId).structured.get(requestId) ?? null,
        ),
      abort: async () => {},
    } as unknown as BuildPipelineProvider;
  }

  // -------------------------------------------------------------------------
  // Owners
  // -------------------------------------------------------------------------

  private spawnOwner(): Owner {
    this.nextToken += 1;
    this.ownerToken = this.nextToken;
    for (const reviewer of this.committed.reviewers) {
      if (!settled(reviewer) && this.owners.length > 0) {
        this.ledgers.get(reviewer.id)!.switchedWhileLive = true;
      }
    }
    const owner: Owner = {
      token: this.nextToken,
      phase: this.committed.phase,
      reviewers: structuredClone(this.committed.reviewers),
      // Probe every pass, so running reviewers interleave transcript reads too.
      tracker: new MultiReviewProgressTracker(0, () => 0),
      host: undefined as unknown as ReviewFanoutHost,
      alive: true,
      passes: 0,
      pools: new Map(),
      savesInFlight: 0,
    };
    const provider = this.provider(owner);
    const reviewerIdOf = (selection: unknown) => (selection as ReviewerRecord).id;
    const slotReviewer = (requestId: string) => this.results.get(requestId)?.reviewerId;
    owner.host = {
      workflowId: "workflow-interleaving",
      targetBranch: "main",
      label: "Interleaving review",
      reviewerMode: this.scenario.reviewerMode,
      sessionKeyFor: (reviewer) => `key-${reviewer.id}`,
      sessionLabelFor: (_reviewer, index) => `Reviewer ${index + 1}`,
      provider: (selection) => this.op(owner, reviewerIdOf(selection), "provider", () => provider),
      providerUnavailable: async () => {},
      executionPolicy: async () => policy,
      supportsToolResult: (selection) => selection.agent !== "codex",
      prepareResult: (selection, requestId) =>
        this.op(owner, reviewerIdOf(selection), "prepare-result", () => {
          this.results.set(requestId, {
            reviewerId: reviewerIdOf(selection),
            open: true,
          });
        }),
      readResult: <T>(requestId: string) =>
        this.op(
          owner,
          slotReviewer(requestId),
          "read-result",
          () => (this.results.get(requestId)?.value ?? null) as StructuredOutputResult<T> | null,
        ),
      projectResult: async (requestId) =>
        this.results.get(requestId)?.value ? ("received" as const) : ("preparing" as const),
      consumeResult: (requestId) => this.op(owner, slotReviewer(requestId), "consume", () => {}),
      closeResult: (requestId) =>
        this.op(
          owner,
          slotReviewer(requestId),
          "close-result",
          () => {
            const slot = this.results.get(requestId);
            if (slot) slot.open = false;
          },
          () => {
            const slot = this.results.get(requestId);
            if (slot && this.rng.chance(0.5)) slot.open = false;
          },
        ),
      save: () => this.save(owner),
      assertFence: async () => {
        if (owner.token !== this.ownerToken) throw new InterleavingFenceError();
      },
      beforeAdmission: () => this.op(owner, undefined, "before-admission", () => {}),
      reviewerPrompt: (index, count) =>
        this.op(
          owner,
          owner.reviewers[index]?.id,
          "prompt",
          () => `Review the package. Reviewer ${index + 1}/${count}.`,
        ),
      resolveUnattendedInteractions: async () => {},
      abandonSession: (selection, sessionId) =>
        this.abort(owner, reviewerIdOf(selection), sessionId),
      progress: owner.tracker,
      stallWarningMs: 24 * 60 * 60_000,
      stallAbandonMs: 48 * 60 * 60_000,
      concurrency: this.scenario.concurrency,
    };
    this.owners.push(owner);
    this.current = owner;
    return owner;
  }

  private startPass(owner: Owner): void {
    owner.passes += 1;
    owner.pools = new Map(
      owner.reviewers.map((reviewer) => [
        reviewer.id,
        { pool: poolFor(reviewer), group: efficiencyPlatform(reviewer.agent) },
      ]),
    );
    const activity = { kind: "pass" as const, settled: false };
    owner.activity = activity;
    // The service constructs one runner per pass over the same host state.
    new ReviewFanoutRunner(owner.host).advanceReviewers(owner.reviewers).then(
      (outcome) => {
        activity.settled = true;
        if (!owner.alive) return;
        if (owner !== this.current) {
          // "A lost fence still propagates": a pass that ran into the fence
          // should not report an outcome to an owner that no longer holds it.
          // Counted, so the regression test for the fixed path can assert it.
          this.fencedPassesResolved += 1;
          return;
        }
        if (outcome.kind !== "working") {
          this.finished = true;
          this.outcome = outcome;
        }
      },
      (error: unknown) => {
        activity.settled = true;
        if (!owner.alive) return;
        if (isFenceError(error) && owner !== this.current) return;
        this.violate(
          `owner ${owner.token} pass rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.finished = true;
      },
    );
  }

  /** A user command under the workflow lock; one that loses the lease is lost. */
  private startControl(owner: Owner, run: () => Promise<void>): void {
    const activity = { kind: "control" as const, settled: false };
    owner.activity = activity;
    run().then(
      () => {
        activity.settled = true;
      },
      (error: unknown) => {
        activity.settled = true;
        if (!owner.alive) return;
        if (isFenceError(error)) return;
        this.violate(`control rejected: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }

  /** `MultiReviewService.cancel` followed by `advanceCancellation`. */
  private async cancel(owner: Owner): Promise<void> {
    const host = owner.host;
    owner.phase = "cancelling";
    await host.save();
    // Every attempt counts: a crash can land this procedure's last save and
    // leave the rerun on the next owner nothing live to cancel.
    for (const reviewer of owner.reviewers) {
      if (!settled(reviewer)) this.unsettledAtCancel.add(reviewer.id);
    }
    for (const reviewer of owner.reviewers) {
      if (reviewer.status === "running" && reviewer.providerSessionId) {
        await host.abandonSession(reviewer, reviewer.providerSessionId);
      }
    }
    for (const reviewer of owner.reviewers) {
      if (reviewer.status === "pending" || reviewer.status === "running") {
        reviewer.status = "cancelled";
      }
      clearReviewerAdmission(reviewer);
    }
    for (const reviewer of owner.reviewers) {
      if (reviewer.resultTransport === "tool-v1" && reviewer.requestId) {
        await host.closeResult?.(reviewer.requestId);
      }
    }
    owner.phase = "cancelled";
    await host.save();
    this.cancelled = true;
    this.finished = true;
  }

  /** `MultiReviewService.stopReviewer`. */
  private async stopOne(owner: Owner): Promise<void> {
    const live = owner.reviewers.filter(
      (reviewer) => reviewer.status === "pending" || reviewer.status === "running",
    );
    if (live.length === 0) return;
    const reviewer = this.rng.pick(live);
    // Until the stop commits, its abort may reach a session the next owner
    // still supervises; a stop that does commit is judged as stopped instead.
    this.ledgers.get(reviewer.id)!.tainted = true;
    this.stopPicked.add(reviewer.id);
    if (reviewer.providerSessionId) {
      await owner.host.abandonSession(reviewer, reviewer.providerSessionId);
      owner.tracker.forget(reviewer.providerSessionId);
    }
    reviewer.status = "cancelled";
    reviewer.completedAt = new Date().toISOString();
    compactReviewerAdmissionQueue(owner.reviewers);
    delete reviewer.idleResultPolls;
    delete reviewer.stalledSince;
    delete reviewer.progressDigest;
    delete reviewer.schemaRepairPrompt;
    delete reviewer.dispatchState;
    await owner.host.save();
  }

  private startNext(owner: Owner): void {
    if (this.cancelRequested || owner.phase !== "reviewing") {
      this.cancelRequested = true;
      // A user whose cancel lost the lease mid-way retries it on the new owner.
      this.startControl(owner, () => this.cancel(owner));
      return;
    }
    if (this.stopRequested) {
      this.stopRequested = false;
      this.startControl(owner, () => this.stopOne(owner));
      return;
    }
    if (owner.passes >= MAX_PASSES) {
      this.violate(`the panel did not settle within ${MAX_PASSES} passes`);
      this.finished = true;
      return;
    }
    this.startPass(owner);
  }

  private crash(): void {
    const owner = this.current;
    owner.alive = false;
    const dropped = this.pending.filter((entry) => entry.owner === owner);
    this.pending = this.pending.filter((entry) => entry.owner !== owner);
    for (const entry of dropped) entry.crash();
    delete owner.activity;
    this.spawnOwner();
  }

  private takeover(): void {
    this.spawnOwner();
  }

  private fire(): void {
    for (const disruption of this.scenario.disruptions) {
      if (disruption.atStep !== this.steps || this.finished) continue;
      this.fired.push(disruption.kind);
      if (disruption.kind === "cancel") this.cancelRequested = true;
      else if (disruption.kind === "stop") this.stopRequested = true;
      else if (disruption.kind === "takeover") this.takeover();
      else this.crash();
    }
  }

  private anyActivity(): boolean {
    return this.owners.some(
      (owner) => owner.alive && owner.activity !== undefined && !owner.activity.settled,
    );
  }

  async run(): Promise<InterleavingResult> {
    this.spawnOwner();
    let idleRounds = 0;
    while (true) {
      await flushMicrotasks(FLUSH_ROUNDS);
      const owner = this.current;
      if (owner.activity?.settled) delete owner.activity;
      if (!owner.activity && !this.finished) {
        this.startNext(owner);
        continue;
      }
      if (this.pending.length > 0) {
        idleRounds = 0;
        this.steps += 1;
        if (this.steps > MAX_STEPS) {
          this.violate(`exceeded ${MAX_STEPS} steps`);
          break;
        }
        this.fire();
        if (this.pending.length === 0) continue;
        const index = this.rng.int(this.pending.length);
        const [entry] = this.pending.splice(index, 1);
        entry!.settle();
        continue;
      }
      if (this.finished && !this.anyActivity()) break;
      idleRounds += 1;
      if (idleRounds > 20) {
        this.violate("deadlock: an activity is waiting on nothing the driver can settle");
        break;
      }
    }
    const finalReviewers = this.current.reviewers;
    for (const [reviewerId, ledger] of this.ledgers) {
      ledger.unsentDispatches = ledger.durableDispatches.filter((requestId) => {
        const attempts = ledger.sendAttempts.get(requestId);
        return !attempts || attempts.calls === attempts.refused;
      });
      // Without a crash, the reviewer's own commit is followed by its send
      // before anything else can happen, so a durable `dispatching` nobody
      // sent was written by a peer's save (0112).
      if (!this.fired.includes("crash")) {
        for (const requestId of ledger.unsentDispatches) {
          if (!ledger.sendAttempts.has(requestId)) {
            this.violate(`${reviewerId} held a durable dispatching its own commit never wrote`);
          }
        }
      }
      // The provider cannot prove such a request never arrived, so it parks
      // and fails closed: either outcome is allowed.
      if (ledger.unsentDispatches.length > 0) ledger.tainted = true;
    }
    await this.restartOverSettledState();
    return {
      scenario: this.scenario,
      violations: [...this.violations],
      finalReviewers,
      committed: this.committed,
      ...(this.outcome ? { outcome: this.outcome } : {}),
      cancelled: this.cancelled,
      stopped: [...this.stopped],
      unsettledAtCancel: [...this.unsettledAtCancel],
      fired: [...this.fired],
      steps: this.steps,
      sends: this.sends,
      commits: this.commits,
      maxConcurrentReviewers: this.maxConcurrentReviewers,
      owners: this.owners.length,
      ledgers: Object.fromEntries(this.ledgers),
      trace: this.trace,
      fencedPassesResolved: this.fencedPassesResolved,
      fencedIo: [...this.fencedIo],
    };
  }

  /**
   * A backend restarting over a settled or cancelled panel must not touch a
   * provider: every reviewer is settled, so the pass has nothing to admit.
   */
  private async restartOverSettledState(): Promise<void> {
    if (this.violations.length > 0) return;
    if (!this.committed.reviewers.every(settled)) return;
    const owner = this.spawnOwner();
    const before = this.pending.length;
    let outcome: ReviewFanoutOutcome | undefined;
    let failure: unknown;
    owner.activity = { kind: "pass", settled: false };
    new ReviewFanoutRunner(owner.host).advanceReviewers(owner.reviewers).then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        failure = error;
      },
    );
    await flushMicrotasks(FLUSH_ROUNDS);
    if (this.pending.length !== before) {
      this.violate(`a restart over a settled panel started ${this.pending.length - before} calls`);
    } else if (failure !== undefined) {
      this.violate(`a restart over a settled panel rejected: ${String(failure)}`);
    } else if (!outcome || outcome.kind === "working") {
      this.violate("a restart over a settled panel did not report it settled");
    }
  }
}

export function runInterleaving(scenario: Scenario): Promise<InterleavingResult> {
  return new InterleavingWorld(scenario).run();
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

/** Terminal states a reviewer may end in, given its script and what happened. */
export function expectedStatuses(
  result: InterleavingResult,
  plan: ReviewerPlan,
  ledger: Readonly<ReviewerLedger>,
): ReadonlyArray<ReviewerRecord["status"]> {
  if (result.stopped.includes(plan.id)) return ["cancelled"];
  if (result.cancelled && result.unsettledAtCancel.includes(plan.id)) return ["cancelled"];
  // Otherwise it settled before any cancel landed, so its own outcome stands.
  if (ledger.tainted) return ["completed", "failed"];
  const tool = plan.agent !== "codex";
  switch (plan.script) {
    case "complete":
    case "restartOnce":
    case "invalidOnce":
    case "prepFail":
    case "unreachable":
      return ["completed"];
    case "fail":
    case "restartTwice":
      return ["failed"];
    case "noSubmit":
      return [tool ? "completed" : "failed"];
    case "ambiguous":
      // An unaccepted ambiguous prompt stays parked and exhausts its bound;
      // a delivery-only reminder cannot stand in for its missing first turn.
      return [plan.ambiguousRan ? "completed" : "failed"];
    case "createFail":
      // A lost `failed` commit lets the next owner create the session again.
      return ledger.switchedWhileLive ? ["failed", "completed"] : ["failed"];
  }
}

/** The durable fields a restart resumes from. */
export function durableProjection(reviewer: ReviewerRecord) {
  return {
    id: reviewer.id,
    status: reviewer.status,
    requestId: reviewer.requestId,
    dispatchState: reviewer.dispatchState,
    providerSessionId: reviewer.providerSessionId,
    restartContinuationSent: reviewer.restartContinuationSent,
    resultReminderSent: reviewer.resultReminderSent,
    schemaRepairAttempts: reviewer.schemaRepairAttempts,
    reviewSummary: reviewer.report?.reviewSummary,
    failed: reviewer.error !== undefined,
  };
}

/** Every invariant a finished seed must satisfy, as human-readable failures. */
export function invariantFailures(result: InterleavingResult): string[] {
  const failures = [...result.violations];
  if (failures.length > 0) return failures;
  if (!result.cancelled && !result.outcome) failures.push("the panel never settled");
  const committed = new Map(result.committed.reviewers.map((reviewer) => [reviewer.id, reviewer]));
  for (const plan of result.scenario.reviewers) {
    const final = result.finalReviewers.find((reviewer) => reviewer.id === plan.id);
    const durable = committed.get(plan.id);
    if (!final || !durable) {
      failures.push(`${plan.id} is missing`);
      continue;
    }
    if (!settled(durable)) {
      failures.push(`${plan.id} ended ${durable.status}/${durable.dispatchState ?? "-"}`);
    }
    const memory = durableProjection(final);
    const stored = durableProjection(durable);
    if (JSON.stringify(memory) !== JSON.stringify(stored)) {
      failures.push(
        `${plan.id} in memory ${JSON.stringify(memory)} differs from committed ${JSON.stringify(stored)}`,
      );
    }
    const allowed = expectedStatuses(result, plan, result.ledgers[plan.id]!);
    if (!allowed.includes(durable.status)) {
      failures.push(
        `${plan.id} (${plan.agent}, ${plan.script}) ended ${durable.status}${
          durable.error ? ` (${durable.error})` : ""
        }, expected ${allowed.join(" or ")}`,
      );
    }
    if (durable.status === "completed") {
      if (durable.report?.reviewSummary !== `Report from ${plan.id}`) {
        failures.push(`${plan.id} completed with another reviewer's report`);
      }
    }
  }
  return failures;
}
