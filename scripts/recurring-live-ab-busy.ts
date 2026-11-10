import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  FAKE_PI_MODEL_REF,
  startFakeModelServer,
  writeFakePiModels,
  type FakeModelServer,
} from "./recurring-live-ab-fake-model";
import { percentile, pickKindCounters, type LiveSample } from "./recurring-live-ab-summary";

/**
 * The busy phase of the live recurring-work driver (`recurring-live-ab.ts
 * --busy-rounds N`), todo 0048 task 1
 * (docs/todo/transcripts-and-observation/0048-recurring-work-qualification.md).
 *
 * On a fresh credential-free profile it brings up `--busy-environments` local
 * environments (the fixture's and new ones, one of them with an `ask`
 * execution policy), opens real Pi sessions on the fake model
 * (`recurring-live-ab-fake-model.ts`), and then, for every client count in
 * `--busy-clients` (0 to 2 headless Playwright clients attached for the whole
 * round), runs `--busy-rounds` rounds of:
 *
 * 1. a burst of files written into every environment at once;
 * 2. an active turn held at the fake model, and a prompt queued behind it;
 * 3. a command approval parked by Pi, and agent mail to the same tab;
 * 4. with two clients the second one's link to the gateway cut (the outage);
 *    with one client its document hidden;
 * 5. the approval answered, the held turn released, the queued prompt sent;
 * 6. a Multi Review with every slot on the fake model, launched and followed
 *    to `ready` (the workflow completion). Its validation plan runs one
 *    read-only command, which waits in the host-wide test scheduler
 *    (`host-test-scheduler.ts`) like any validation, so that step is its own
 *    row rather than a sample of "progress after a result". Every client
 *    whose link is up also opens a review view (a second signed-in page) on
 *    the review's own tab before the review starts, and each result is timed
 *    to the moment that page shows the phase it leads to (todo 0048 task 2);
 * 7. the cut link restored, or the document shown again (the client resume).
 *
 * Every wait is timed in this process from the moment the cause is known:
 * the fake model's own arrival times for model-side events, the CLI or
 * public action's return for the rest. Client rows are what a page showed
 * (sidebar markers, the approval card, the mail chip, change badges);
 * backend rows read the public API or the recurring-work counters. Each
 * round also checks the obligations: every turn reached the model exactly
 * once, the queued prompt went out once, the approval was answered and its
 * turn finished, and the review completed.
 *
 * Nothing here reads or prints a token, a prompt or file content: prompts and
 * files are fixture strings made here, and the result holds counts, states
 * and durations.
 */

export type BusyOptions = {
  /** Rounds per client count; 0 turns the phase off. */
  busyRounds: number;
  /** Local environments in the busy profile, the fixture's included (at least 3). */
  busyEnvironments: number;
  /** Client counts, each run for `busyRounds` rounds. */
  busyClients: number[];
  /** Files each environment gets in a burst. */
  busyBurstFiles: number;
  /**
   * Files written into the turn environment while each round's held turn is
   * at the model, and removed when the round ends; 0 writes none. Past the
   * measurement file row cap (2,000) this puts capped lists on the turn and
   * thread-segment owners, not only the environment scan (todo 4960).
   */
  busyTurnFiles: number;
};

/**
 * Untracked files the environment scan counts lines for
 * (`UNTRACKED_SCAN_MAX_FILES` in apps/backend/src/core/commands-validation.ts;
 * the test pins the two together). Past it the rest are listed uncounted and
 * the badge reads `~+2,000`, so a larger burst can only be waited for up to
 * this many added lines. The busy environments hold no other untracked files.
 */
export const UNTRACKED_COUNTED_FILES = 2_000;

/** Lines a burst of `files` one-line files adds to a change badge. */
export function burstBadgeLines(files: number): number {
  return Math.min(files, UNTRACKED_COUNTED_FILES);
}

export const BUSY_DEFAULTS: BusyOptions = {
  busyRounds: 0,
  busyEnvironments: 10,
  busyClients: [0, 1, 2],
  busyBurstFiles: 200,
  busyTurnFiles: 0,
};

/**
 * What the phase measures, each against its row of the latency budgets in
 * docs/architecture/recurring-work.md (p95), or `null` where the budget table
 * has no row.
 */
export const BUSY_ROWS = {
  "burst-backend": { budgetMs: null, side: "backend", label: "Burst: every environment rescanned" },
  // ≤ 2 s after the save settles, timed from the write: 2.4 s (0048 decision M1).
  "burst-badge": { budgetMs: 2_400, side: "client", label: "Burst: change badge shows it" },
  "burst-clear": { budgetMs: 2_400, side: "client", label: "Burst removed: badge back" },
  "activity-working": {
    budgetMs: 4_000,
    side: "client",
    label: "Background activity indicator (working)",
  },
  "approval-backend": {
    budgetMs: null,
    side: "backend",
    label: "Approval listed by the public API",
  },
  "approval-visible": { budgetMs: 2_000, side: "client", label: "Pending approval visible" },
  "mail-visible": { budgetMs: 4_000, side: "client", label: "Mail shown on the tab" },
  "approved-turn-visible": {
    budgetMs: 3_000,
    side: "client",
    label: "Turn completion visible after the approval (reply row in the open tab)",
  },
  "queued-dispatch": {
    budgetMs: 3_000,
    side: "backend",
    label: "Queued prompt dispatched after the turn ends",
  },
  // The marker can already read idle in the gap before the queued turn
  // starts, so this is the activity row, not a turn-completion measure.
  "queued-turn-visible": {
    budgetMs: 4_000,
    side: "client",
    label: "Background indicator idle after the queued turn",
  },
  "workflow-progress": {
    budgetMs: 3_000,
    side: "backend",
    label: "Backend phase observed after result submission (upper bound)",
  },
  // The same three results, timed to the client's review view showing the
  // phase each one leads to (or a later one): what the budget row means.
  "workflow-progress-visible": {
    budgetMs: 3_000,
    side: "client",
    label: "Workflow progress visible after a result (the review's phase in its open tab)",
  },
  // The plan's next phase waits for its commands, which queue in the
  // host-wide test scheduler with every other worktree's validation and tests.
  "workflow-validation": {
    budgetMs: null,
    side: "backend",
    label: "Validation plan submission to reviewing (runs the plan)",
  },
  "workflow-complete": {
    budgetMs: null,
    side: "backend",
    label: "Multi Review launch to ready",
  },
  "outage-resume": {
    budgetMs: null,
    side: "client",
    label: "Cut client converged after its link returned",
  },
  "hidden-resume": {
    budgetMs: null,
    side: "client",
    label: "Hidden client converged after it was shown",
  },
} as const satisfies Record<
  string,
  { budgetMs: number | null; side: "backend" | "client"; label: string }
>;
export type BusyRow = keyof typeof BUSY_ROWS;

/** One page of the profile, as the phase reads and drives it. */
export interface BusyClient {
  readonly label: string;
  /** Whether this client reaches the gateway through a link the phase can cut. */
  readonly linked: boolean;
  /** The sidebar activity marker's state for an environment (`idle`, `working`, `waiting`). */
  markerState(environmentName: string): Promise<string | null>;
  /** The `+N` additions each environment's change badge shows (null for none), by name. */
  badges(): Promise<Record<string, number | null>>;
  /** Whether the open tab shows the "Approve command" card with its Approve button. */
  approvalVisible(): Promise<boolean>;
  /** Rendered transcript rows of the open tab that hold the fake model's reply. */
  replyCount(): Promise<number>;
  /** Messages the open tab's agent-mail chip counts (0 when it shows none). */
  mailCount(): Promise<number>;
  setHidden(hidden: boolean): Promise<void>;
  /**
   * Opens this client's review view (its own signed-in page) on an
   * environment, so a review launched there can be watched from its start.
   */
  prepareReview(environmentName: string): Promise<void>;
  /** Starts recording a review's phases in the review view, then selects its tab. */
  watchReview(workflowId: string): Promise<void>;
  /**
   * Each phase the review view has shown since `watchReview`, with when it
   * first showed, on this process's clock (`BusyRuntime.now`).
   */
  reviewPhases(): Promise<ReviewSighting[]>;
  /** Cut (`false`) or restore (`true`) a linked client's connection. */
  setLinkUp(up: boolean): void;
  close(): Promise<void>;
}

export type BusyClientFactory = (input: {
  count: number;
  /** The environment whose approval session the clients keep open. */
  openEnvironment: string;
  signal?: AbortSignal;
}) => Promise<BusyClient[]>;

export type ReviewSighting = { phase: string; at: number };

export type CliResult = { status: number | null; stdout: string };
export type AsyncCli = (args: string[], signal?: AbortSignal) => Promise<CliResult>;

export type BusyGateway = {
  metrics(): Promise<Record<string, unknown> | null>;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
};

export type ValidationTiming = { queuedMs: number; commandMs: number; runMs: number };

export type AdmissionPeak = {
  granted: number;
  rejected: number;
  maxActive: number;
  maxWaiting: number;
  maxOldestWaitMs: number;
};

export type BusyFailure = { clients: number; round: number; step: string; detail?: string };

export type BusyResult = {
  environments: number;
  /** Client counts and rounds actually run. */
  rounds: Array<{ clients: number; round: number; durationMs: number; failed: boolean }>;
  samples: Record<BusyRow, number[]>;
  /** Waits that ran out, per row. */
  timeouts: Partial<Record<BusyRow, number>>;
  obligations: {
    turns: number;
    queued: number;
    approvals: number;
    mails: number;
    workflows: number;
    /** A marker the model saw more often than once per prompt. */
    duplicates: number;
  };
  /** Held turns that had `busyTurnFiles` files written while they ran. */
  turnFileRounds: number;
  failures: BusyFailure[];
  /** `recurringWork` kinds and process totals, sampled at each round boundary. */
  windowSamples: LiveSample[];
  /**
   * Admission pools over the phase, from every metrics read: leases granted
   * and refused (exact, cumulative deltas) and the most active, waiting and
   * oldest wait any read saw (a lower bound on the true peaks).
   */
  admission: Record<string, AdmissionPeak>;
  /** Each review's validation run: host-scheduler queue, command and whole-run times. */
  validationRuns: ValidationTiming[];
  /**
   * Client review views: views that watched a review, results they timed,
   * and results that reached the backend before the view showed the review
   * (not sampled, since the view could not have shown them yet).
   */
  reviewViews: { watched: number; sampled: number; unobserved: number };
  modelRequests: number;
  durationMs: number;
};

export type BusyRuntime = {
  startFakeModel(): FakeModelServer;
  writeFakePiModels(dataDir: string, baseUrl: string): void;
  openClients: BusyClientFactory;
  /** Writes `count` one-line files under `relative` in each worktree; returns when written. */
  writeBurst(worktrees: string[], relative: string, count: number): void;
  removeBurst(worktrees: string[], relative: string): void;
  /** Commits one fixture file in a worktree, so a review has a change to read. */
  commitFixture(worktree: string): boolean;
  /** Timings of the validation runs recorded in a worktree, by run id. */
  validationRuns(worktree: string): Map<string, ValidationTiming>;
  processes(): LiveSample["processes"];
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export const busyRuntime: BusyRuntime = {
  startFakeModel: () => startFakeModelServer(),
  writeFakePiModels: (dataDir, baseUrl) => {
    writeFakePiModels(dataDir, baseUrl);
  },
  openClients: async () => {
    throw new Error("No client driver configured");
  },
  writeBurst: (worktrees, relative, count) => {
    for (const worktree of worktrees) {
      const directory = path.join(worktree, relative);
      mkdirSync(directory, { recursive: true });
      for (let index = 0; index < count; index += 1)
        writeFileSync(path.join(directory, `f-${index}.txt`), "busy\n");
    }
  },
  removeBurst: (worktrees, relative) => {
    for (const worktree of worktrees)
      rmSync(path.join(worktree, relative), { recursive: true, force: true });
  },
  commitFixture: (worktree) => {
    writeFileSync(path.join(worktree, "busy-review.txt"), "busy review fixture\n");
    const git = (args: string[]) =>
      spawnSync(
        "git",
        ["-C", worktree, "-c", "user.name=busy", "-c", "user.email=busy@example.invalid", ...args],
        { encoding: "utf8" },
      ).status === 0;
    return git(["add", "busy-review.txt"]) && git(["commit", "-q", "-m", "Busy review fixture"]);
  },
  validationRuns: (worktree) => {
    const runs = new Map<string, ValidationTiming>();
    const root = path.join(worktree, ".orkestrator", "review-artifacts");
    let entries: string[] = [];
    try {
      entries = readdirSync(root).filter((name) => name.startsWith("review-validation-"));
    } catch {
      return runs;
    }
    for (const name of entries) {
      try {
        const run = (
          JSON.parse(readFileSync(path.join(root, name, "state.json"), "utf8")) as {
            run?: {
              startedAt?: string;
              completedAt?: string;
              results?: Array<{ queuedMs?: number; durationMs?: number }>;
            };
          }
        ).run;
        const runMs = Date.parse(run?.completedAt ?? "") - Date.parse(run?.startedAt ?? "");
        if (!Number.isFinite(runMs)) continue;
        const results = run?.results ?? [];
        runs.set(name, {
          queuedMs: results.reduce((total, entry) => total + (entry.queuedMs ?? 0), 0),
          commandMs: results.reduce((total, entry) => total + (entry.durationMs ?? 0), 0),
          runMs,
        });
      } catch {
        // A run still being written is read on a later round.
      }
    }
    return runs;
  },
  processes: () => ({}),
  now: () => performance.now(),
  sleep: async (ms, signal) => {
    await delay(ms, undefined, { signal });
  },
};

/** Client-visible waits give up after this; a miss is a timeout, not a hang. */
const CLIENT_WAIT_MS = 30_000;
const BACKEND_WAIT_MS = 60_000;
const WORKFLOW_WAIT_MS = 15 * 60_000;
const POLL_MS = 50;
const STEP_TIMEOUT = "10m";
const PI_RUN_ENDED = new Set([0, 7]);
/** Phases a Multi Review passes through, in order, and its terminal ones. */
const REVIEW_TERMINAL = new Set(["ready", "failed", "cancelled"]);
const REVIEW_ORDER = ["preparing", "reviewing", "consolidating", "ready"];

export type ClientProgressSample =
  | { kind: "sample"; ms: number }
  /** The view showed nothing of the review until after the result: not sampled. */
  | { kind: "unobserved" }
  /** The view never showed the phase, or showed it before its own result. */
  | { kind: "missing" };

/**
 * When a client's review view showed the progress a result caused: the first
 * sighting of `target` or a later phase (a quick phase can be skipped
 * between two renders, and showing a later one shows this progress too).
 * A view that showed nothing before the result was not watching yet, so it
 * cannot time it.
 */
export function clientProgressSample(
  sightings: readonly ReviewSighting[],
  submittedAt: number,
  target: string,
): ClientProgressSample {
  const rank = REVIEW_ORDER.indexOf(target);
  if (rank < 0) return { kind: "missing" };
  if (!sightings[0] || sightings[0].at > submittedAt) return { kind: "unobserved" };
  const shown = sightings.find((sighting) => REVIEW_ORDER.indexOf(sighting.phase) >= rank);
  if (!shown || shown.at < submittedAt) return { kind: "missing" };
  return { kind: "sample", ms: Math.round(shown.at - submittedAt) };
}

/** An error's first line: Playwright appends a call log that may name page content. */
/**
 * A pane layout's tree without the tabs of one Multi Review (its root,
 * reviewer and Address Findings tabs), and how many it removed. Leaves whose
 * active tab went select their first remaining tab. The renderer owns the
 * tree's shape: leaves carry `tabs` and `activeTabId`, splits `children`.
 */
export function withoutReviewTabs(
  root: unknown,
  workflowId: string,
): { root: unknown; removed: number } {
  let removed = 0;
  const isReviewTab = (tab: unknown) => {
    if (!tab || typeof tab !== "object") return false;
    const record = tab as { id?: unknown; multiReviewTabData?: { workflowId?: unknown } };
    return (
      record.multiReviewTabData?.workflowId === workflowId ||
      record.id === `multi-review:${workflowId}` ||
      (typeof record.id === "string" && record.id.startsWith(`multi-review:${workflowId}:`)) ||
      record.id === `multi-review-fix:${workflowId}`
    );
  };
  const walk = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    const record = node as { tabs?: unknown; activeTabId?: unknown; children?: unknown };
    if (Array.isArray(record.children)) return { ...record, children: record.children.map(walk) };
    if (!Array.isArray(record.tabs)) return node;
    const tabs = record.tabs.filter((tab) => !isReviewTab(tab));
    removed += record.tabs.length - tabs.length;
    const active = tabs.some((tab) => (tab as { id?: unknown }).id === record.activeTabId)
      ? record.activeTabId
      : ((tabs[0] as { id?: unknown } | undefined)?.id ?? null);
    return { ...record, tabs, activeTabId: active };
  };
  return { root: walk(root), removed };
}

function firstLine(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n", 1)[0] ?? "") : String(error);
}

export function parseBusyClients(raw: string): number[] {
  const counts = raw.split(",").filter(Boolean).map(Number);
  if (
    counts.length === 0 ||
    counts.some((count) => !Number.isInteger(count) || count < 0 || count > 2)
  )
    throw new Error("--busy-clients takes a comma list of client counts from 0 to 2");
  return [...new Set(counts)];
}

function cliJson(result: CliResult): unknown {
  if (result.status !== 0) return null;
  try {
    return (JSON.parse(result.stdout) as { result?: unknown }).result ?? null;
  } catch {
    return null;
  }
}

/** The session and tab a `session start` reported, from its result or (Pi) its receipt. */
function startedSession(result: CliResult): { sessionId: string; tabId: string } | null {
  try {
    const envelope = JSON.parse(result.stdout) as {
      result?: { sessionId?: unknown; tabId?: unknown };
      receipt?: { resources?: { sessionId?: unknown; tabId?: unknown } };
    };
    const sessionId = envelope.result?.sessionId ?? envelope.receipt?.resources?.sessionId;
    const tabId = envelope.result?.tabId ?? envelope.receipt?.resources?.tabId;
    return typeof sessionId === "string" && sessionId && typeof tabId === "string" && tabId
      ? { sessionId, tabId }
      : null;
  } catch {
    return null;
  }
}

function diffChanged(metrics: Record<string, unknown> | null): number | null {
  const block = metrics?.recurringWork as
    { metrics?: { kinds?: Record<string, { changed?: unknown }> } } | undefined;
  const changed = block?.metrics?.kinds?.["diff-scan"]?.changed;
  return typeof changed === "number" && Number.isSafeInteger(changed) ? changed : null;
}

type Environment = { id: string; name: string; worktree: string };

export async function measureBusy(
  gateway: BusyGateway,
  cli: AsyncCli,
  options: BusyOptions & { dataDir: string },
  signal?: AbortSignal,
  runtime: BusyRuntime = busyRuntime,
): Promise<BusyResult> {
  const startedAt = runtime.now();
  const samples = Object.fromEntries(
    Object.keys(BUSY_ROWS).map((row) => [row, []]),
  ) as unknown as Record<BusyRow, number[]>;
  const result: BusyResult = {
    environments: 0,
    rounds: [],
    samples,
    timeouts: {},
    obligations: { turns: 0, queued: 0, approvals: 0, mails: 0, workflows: 0, duplicates: 0 },
    turnFileRounds: 0,
    failures: [],
    windowSamples: [],
    admission: {},
    validationRuns: [],
    reviewViews: { watched: 0, sampled: 0, unobserved: 0 },
    modelRequests: 0,
    durationMs: 0,
  };
  const admissionStart = new Map<string, { granted: number; rejected: number }>();
  /** Folds one metrics read's admission pools into the phase's peaks. */
  const noteAdmission = (metrics: Record<string, unknown> | null) => {
    const pools = (metrics?.recurringWork as { admission?: unknown } | undefined)?.admission;
    for (const raw of Array.isArray(pools) ? pools : []) {
      const pool = raw as Record<string, unknown>;
      if (typeof pool.pool !== "string") continue;
      const count = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? value : 0;
      const granted = count(pool.granted);
      const rejected = Object.values((pool.rejected as Record<string, unknown>) ?? {}).reduce(
        (total: number, value) => total + count(value),
        0,
      );
      const start = admissionStart.get(pool.pool) ?? { granted, rejected };
      admissionStart.set(pool.pool, start);
      const peak = (result.admission[pool.pool] ??= {
        granted: 0,
        rejected: 0,
        maxActive: 0,
        maxWaiting: 0,
        maxOldestWaitMs: 0,
      });
      peak.granted = Math.max(0, granted - start.granted);
      peak.rejected = Math.max(0, rejected - start.rejected);
      peak.maxActive = Math.max(peak.maxActive, count(pool.active));
      peak.maxWaiting = Math.max(peak.maxWaiting, count(pool.waiting));
      peak.maxOldestWaitMs = Math.max(peak.maxOldestWaitMs, count(pool.oldestWaitMs));
    }
    return metrics;
  };
  const readMetrics = async () => noteAdmission(await gateway.metrics());
  const elapsed = () => runtime.now() - startedAt;
  const sampleWindow = async () => {
    const metrics = await readMetrics();
    const block = metrics?.recurringWork as { metrics?: { kinds?: unknown } } | undefined;
    result.windowSamples.push({
      atMs: Math.round(elapsed()),
      kinds: block?.metrics ? pickKindCounters(block.metrics.kinds) : null,
      processes: runtime.processes(),
    });
  };
  /** Ms from `since` until `done` holds, or null after `timeoutMs` (counted against `row`). */
  const until = async (
    row: BusyRow | null,
    since: number,
    done: () => Promise<boolean> | boolean,
    timeoutMs: number,
  ): Promise<number | null> => {
    for (;;) {
      signal?.throwIfAborted();
      if (await done()) return Math.max(0, Math.round(runtime.now() - since));
      if (runtime.now() - since > timeoutMs) {
        if (row) result.timeouts[row] = (result.timeouts[row] ?? 0) + 1;
        return null;
      }
      await runtime.sleep(POLL_MS, signal);
    }
  };
  const record = (row: BusyRow, value: number | null) => {
    if (value !== null) samples[row].push(value);
  };
  const step = async (args: string[]) => {
    signal?.throwIfAborted();
    return cli([...args, "--json"], signal);
  };
  const publicAction = async (
    action: string,
    input: Record<string, unknown>,
    mutation = false,
  ): Promise<{ ok: boolean; result?: unknown }> => {
    const response = (await gateway.invoke("public_action", {
      schemaVersion: 1,
      action,
      actionVersion: 1,
      input,
      ...(mutation ? { request: { requestId: `busy-${randomUUID()}` } } : {}),
    })) as { ok?: unknown; result?: unknown } | null;
    return { ok: response?.ok === true, result: response?.result };
  };

  const closeReviewTabs = async (environmentId: string, workflowId: string) => {
    const layout = (await gateway.invoke("get_pane_layout", { environmentId })) as {
      version?: unknown;
      containerId?: unknown;
      activePaneId?: unknown;
      root?: unknown;
    } | null;
    if (!layout) return;
    const next = withoutReviewTabs(layout.root, workflowId);
    if (next.removed === 0) return;
    // The merge takes exactly these four fields and refuses any other.
    const base = {
      version: layout.version,
      containerId: layout.containerId,
      activePaneId: layout.activePaneId,
      root: layout.root,
    };
    await gateway.invoke("apply_pane_layout_intent", {
      environmentId,
      baseLayout: base,
      desiredLayout: { ...base, root: next.root },
    });
  };

  const fakeModel = runtime.startFakeModel();
  let clients: BusyClient[] = [];
  try {
    runtime.writeFakePiModels(options.dataDir, fakeModel.baseUrl);
    // --- Environments ------------------------------------------------------
    const listing = await step(["environment", "list"]);
    // Every step goes through the worktree's CLI; an unbuilt one fails here,
    // and reporting that as a missing environment hid the cause (todo 4960).
    if (listing.status !== 0)
      throw new Error(
        `The CLI's environment list failed (exit ${listing.status}); build it with mise run build:cli`,
      );
    const listed = cliJson(listing) as { items?: unknown[] } | null;
    const fixture = (listed?.items ?? [])
      .map((raw) => raw as Record<string, unknown>)
      .find((entry) => entry.environmentType === "local" && entry.ready === true);
    if (!fixture || typeof fixture.id !== "string" || typeof fixture.projectId !== "string")
      throw new Error("The busy phase needs the fixture's ready local environment");
    const projectId = fixture.projectId;
    const refreshed = await cli(
      ["agent", "options", "--environment", fixture.id, "--refresh", "--json"],
      signal,
    );
    if (refreshed.status !== 0 || !refreshed.stdout.includes(FAKE_PI_MODEL_REF))
      throw new Error("The Pi catalogue did not list the fake model after a refresh");
    // The approval environment asks before every command; the execution
    // policy is not a CLI setting, so it is created through the registry.
    const ask = (await gateway.invoke("create_environment", {
      projectId,
      name: "busy-ask",
      environmentType: "local",
      networkAccessMode: "restricted",
      agentSettings: { executionPolicy: { approvals: "ask" } },
    })) as { id?: unknown } | null;
    if (typeof ask?.id !== "string") throw new Error("Could not create the approval environment");
    const created: string[] = [ask.id];
    for (let index = 1; index <= Math.max(1, options.busyEnvironments - 2); index += 1) {
      const made = cliJson(
        await step([
          "environment",
          "create",
          "--project",
          projectId,
          "--type",
          "local",
          "--name",
          `busy-${index}`,
        ]),
      ) as { environment?: { id?: unknown } } | null;
      if (typeof made?.environment?.id !== "string")
        throw new Error("Could not create a busy environment");
      created.push(made.environment.id);
    }
    for (const id of created) {
      const started = await step([
        "environment",
        "start",
        id,
        "--wait",
        "ready",
        "--timeout",
        STEP_TIMEOUT,
      ]);
      if (started.status !== 0) throw new Error("A busy environment did not become ready");
    }
    const all = (cliJson(await step(["environment", "list"])) as { items?: unknown[] } | null)
      ?.items;
    const environments: Environment[] = (all ?? []).flatMap((raw) => {
      const entry = raw as Record<string, unknown>;
      return entry.environmentType === "local" &&
        entry.ready === true &&
        typeof entry.id === "string" &&
        typeof entry.name === "string" &&
        typeof entry.workspacePath === "string"
        ? [{ id: entry.id, name: entry.name, worktree: entry.workspacePath }]
        : [];
    });
    result.environments = environments.length;
    const byId = (id: string) => environments.find((entry) => entry.id === id);
    const askEnvironment = byId(ask.id);
    const turnEnvironment = byId(created[1]!);
    const reviewEnvironment = byId(created[2] ?? created[1]!);
    if (!askEnvironment || !turnEnvironment || !reviewEnvironment)
      throw new Error("A busy environment is missing from the list");
    if (!runtime.commitFixture(reviewEnvironment.worktree))
      throw new Error("Could not commit the review fixture");
    // --- Sessions ----------------------------------------------------------
    const openSession = async (environment: Environment) => {
      const before = fakeModel.counts().completions;
      const started = await step([
        "session",
        "start",
        "--environment",
        environment.id,
        "--agent",
        "pi",
        "--model",
        FAKE_PI_MODEL_REF,
        "--prompt",
        "Busy session: reply briefly.",
        "--wait",
        "--timeout",
        STEP_TIMEOUT,
      ]);
      const session = startedSession(started);
      if (
        !session ||
        started.status === null ||
        !PI_RUN_ENDED.has(started.status) ||
        fakeModel.counts().completions <= before
      )
        throw new Error(`The ${environment.name} session did not answer on the fake model`);
      return session;
    };
    const turnSession = await openSession(turnEnvironment);
    const askSession = await openSession(askEnvironment);

    await sampleWindow();
    let roundIndex = 0;
    let reviewId: string | null = null;
    for (const clientCount of options.busyClients) {
      for (let round = 1; round <= options.busyRounds; round += 1) {
        signal?.throwIfAborted();
        roundIndex += 1;
        const roundStartedAt = runtime.now();
        const failuresBefore = result.failures.length;
        const fail = (stepName: string, detail?: string) =>
          result.failures.push({
            clients: clientCount,
            round,
            step: stepName,
            ...(detail ? { detail } : {}),
          });
        const tag = `r${roundIndex}`;
        const held = `t-${tag}`;
        const queued = `q-${tag}`;
        const approval = `a-${tag}`;
        const turnFilesPath = path.join("busy-turn", tag);
        // A round that throws (a client that cannot open its view, a refused
        // command) is recorded and the next round still runs.
        try {
          clients =
            clientCount > 0
              ? await runtime.openClients({
                  count: clientCount,
                  openEnvironment: askEnvironment.name,
                  ...(signal ? { signal } : {}),
                })
              : [];
          /** Clients whose link is cut or whose document is hidden are not expected to follow. */
          const cut = new Set<BusyClient>();
          const connected = () => clients.filter((client) => !cut.has(client));
          const allClients = async (
            row: BusyRow | null,
            since: number,
            done: (client: BusyClient) => Promise<boolean>,
            targets = connected(),
            timeoutMs = CLIENT_WAIT_MS,
          ) => {
            const values = await Promise.all(
              targets.map((client) => until(row, since, () => done(client), timeoutMs)),
            );
            if (row) for (const value of values) record(row, value);
            return values;
          };

          // 1. Burst: every environment at once.
          const burstPath = path.join("busy-burst", tag);
          const worktrees = environments.map((entry) => entry.worktree);
          const baselines = await Promise.all(clients.map((client) => client.badges()));
          /** One reader per client; each environment's first match is one sample. */
          const watchBadges = async (
            row: BusyRow,
            since: number,
            reached: (additions: number | null, base: number) => boolean,
          ) =>
            Promise.all(
              clients.map(async (client, index) => {
                const pending = new Set(environments.map((entry) => entry.name));
                for (;;) {
                  signal?.throwIfAborted();
                  const badges = await client.badges();
                  for (const name of Array.from(pending)) {
                    if (!reached(badges[name] ?? null, baselines[index]?.[name] ?? 0)) continue;
                    record(row, Math.round(runtime.now() - since));
                    pending.delete(name);
                  }
                  if (pending.size === 0) return;
                  if (runtime.now() - since > CLIENT_WAIT_MS) {
                    result.timeouts[row] = (result.timeouts[row] ?? 0) + pending.size;
                    return;
                  }
                  await runtime.sleep(POLL_MS, signal);
                }
              }),
            );
          const changedBefore = diffChanged(await readMetrics());
          const burstAt = runtime.now();
          runtime.writeBurst(worktrees, burstPath, options.busyBurstFiles);
          const backendBurst =
            changedBefore === null
              ? Promise.resolve(null)
              : until(
                  "burst-backend",
                  burstAt,
                  async () =>
                    (diffChanged(await readMetrics()) ?? 0) >= changedBefore + environments.length,
                  BACKEND_WAIT_MS,
                );
          await watchBadges(
            "burst-badge",
            burstAt,
            (additions, base) =>
              additions !== null && additions >= base + burstBadgeLines(options.busyBurstFiles),
          );
          record("burst-backend", await backendBurst);
          const clearAt = runtime.now();
          runtime.removeBurst(worktrees, burstPath);
          await watchBadges("burst-clear", clearAt, (additions, base) => (additions ?? 0) <= base);

          // 2. An active turn held at the model, and a prompt queued behind it.
          fakeModel.release(queued);
          if (
            (
              await step([
                "session",
                "prompt",
                turnSession.sessionId,
                "--prompt",
                `Busy turn ${tag} [hold:${held}]`,
              ])
            ).status !== 0
          )
            fail("turn");
          const dispatched = await until(
            null,
            runtime.now(),
            () => fakeModel.marker(held) !== null,
            BACKEND_WAIT_MS,
          );
          if (dispatched === null) fail("turn", "the held turn never reached the model");
          else if (options.busyTurnFiles > 0) {
            // Written inside the held turn, so the turn and its thread segment
            // measure them; removed once the round ends (below).
            runtime.writeBurst([turnEnvironment.worktree], turnFilesPath, options.busyTurnFiles);
            result.turnFileRounds += 1;
          }
          const heldAt = fakeModel.marker(held)?.firstAt ?? runtime.now();
          await allClients(
            "activity-working",
            heldAt,
            async (client) => (await client.markerState(turnEnvironment.name)) === "working",
          );
          const enqueued = await step([
            "session",
            "prompt",
            turnSession.sessionId,
            "--enqueue",
            "--prompt",
            `Busy queued ${tag} [hold:${queued}]`,
          ]);
          if (enqueued.status !== 0) fail("queue");

          // 3. A parked approval, and mail to the same tab.
          if (
            (
              await step([
                "session",
                "prompt",
                askSession.sessionId,
                "--prompt",
                `Busy approval ${tag} [tool:${approval}]`,
              ])
            ).status !== 0
          )
            fail("approval-prompt");
          await until(
            null,
            runtime.now(),
            () => fakeModel.marker(approval) !== null,
            BACKEND_WAIT_MS,
          );
          const toolCallAt = fakeModel.marker(approval)?.firstAt ?? runtime.now();
          let interaction: { id: string; revision: number } | null = null;
          const listedAfter = await until(
            "approval-backend",
            toolCallAt,
            async () => {
              const listing = await publicAction("session.interactions", {
                sessionId: askSession.sessionId,
              });
              const items = (listing.result as { items?: unknown[] } | undefined)?.items ?? [];
              for (const raw of items) {
                const item = raw as {
                  id?: unknown;
                  revision?: unknown;
                  state?: unknown;
                  kind?: unknown;
                };
                if (
                  item.state === "pending" &&
                  item.kind === "command-approval" &&
                  typeof item.id === "string" &&
                  typeof item.revision === "number"
                ) {
                  interaction = { id: item.id, revision: item.revision };
                  return true;
                }
              }
              return false;
            },
            BACKEND_WAIT_MS,
          );
          record("approval-backend", listedAfter);
          await allClients("approval-visible", toolCallAt, (client) => client.approvalVisible());
          const mailBaseline = await Promise.all(clients.map((client) => client.mailCount()));
          const mailed = await step([
            "mail",
            "send",
            askEnvironment.id,
            askSession.tabId,
            "--subject",
            `Busy ${tag}`,
            "--body",
            `Busy-profile mail ${tag}.`,
          ]);
          if (mailed.status !== 0) fail("mail");
          else result.obligations.mails += 1;
          const mailedAt = runtime.now();
          await allClients(
            "mail-visible",
            mailedAt,
            async (client) =>
              (await client.mailCount()) > (mailBaseline[clients.indexOf(client)] ?? 0),
          );

          // 4. The outage (two clients) or a hidden document (one client).
          const outageClient =
            clientCount === 2 ? clients.find((client) => client.linked) : undefined;
          const hiddenClient = clientCount === 1 ? clients[0] : undefined;
          if (outageClient) {
            outageClient.setLinkUp(false);
            cut.add(outageClient);
          }
          if (hiddenClient) {
            await hiddenClient.setHidden(true);
            cut.add(hiddenClient);
          }

          // 5. Answer the approval, release the held turn, let the queue go.
          const pending = interaction as { id: string; revision: number } | null;
          const repliesBefore = await Promise.all(clients.map((client) => client.replyCount()));
          if (!pending) fail("approval", "no pending approval was listed");
          else {
            const answered = await publicAction(
              "session.interaction.resolve",
              {
                sessionId: askSession.sessionId,
                interactionId: pending.id,
                expectedRevision: pending.revision,
                action: "answer",
              },
              true,
            );
            if (!answered.ok) fail("approval", "the approval was not applied");
            const replied = await until(
              null,
              runtime.now(),
              () => (fakeModel.marker(approval)?.toolResults ?? 0) >= 1,
              BACKEND_WAIT_MS,
            );
            if (replied === null)
              fail("approval", "the approved command's result never reached the model");
            else {
              result.obligations.approvals += 1;
              const answerAt = fakeModel.marker(approval)?.lastAt ?? runtime.now();
              await allClients(
                "approved-turn-visible",
                answerAt,
                async (client) =>
                  (await client.replyCount()) > (repliesBefore[clients.indexOf(client)] ?? 0),
              );
            }
          }
          await readMetrics();
          const releasedAt = runtime.now();
          fakeModel.release(held);
          const queuedAfter = await until(
            "queued-dispatch",
            releasedAt,
            () => fakeModel.marker(queued) !== null,
            BACKEND_WAIT_MS,
          );
          if (queuedAfter === null) fail("queue", "the queued prompt was never dispatched");
          else {
            record(
              "queued-dispatch",
              Math.round((fakeModel.marker(queued)?.firstAt ?? releasedAt) - releasedAt),
            );
            result.obligations.queued += 1;
            const queuedAt = fakeModel.marker(queued)?.firstAt ?? runtime.now();
            await allClients(
              "queued-turn-visible",
              queuedAt,
              async (client) => (await client.markerState(turnEnvironment.name)) === "idle",
            );
          }
          if (fakeModel.marker(held)) result.obligations.turns += 1;

          // 6. A Multi Review to completion, every slot on the fake model.
          if (reviewId) {
            await step(["review", "cancel", reviewId]);
            // Each review opens tabs in its environment, which holds at most
            // nine; close the last one's as a user would, or every launch
            // after the ninth is refused (todo 4960's soak).
            try {
              await closeReviewTabs(reviewEnvironment.id, reviewId);
            } catch (error) {
              fail("workflow-tabs", firstLine(error));
            }
          }
          // Every client whose link is up watches it from a review view of
          // its own (a hidden client's view is a separate, visible document).
          const viewers = (
            await Promise.all(
              clients
                .filter((client) => client !== outageClient)
                .map(async (client) => {
                  try {
                    await client.prepareReview(reviewEnvironment.name);
                    return client;
                  } catch (error) {
                    fail("workflow-visible", `${client.label}: ${firstLine(error)}`);
                    return null;
                  }
                }),
            )
          ).filter((client): client is BusyClient => client !== null);
          const validationsBefore = runtime.validationRuns(reviewEnvironment.worktree);
          const launchAt = runtime.now();
          const workflowsBefore = fakeModel.workflow();
          const launched = cliJson(
            await step([
              "review",
              "launch",
              reviewEnvironment.id,
              "--reviewer",
              `pi=${FAKE_PI_MODEL_REF}`,
              "--review-model",
              `pi=${FAKE_PI_MODEL_REF}`,
              "--no-auto-address-findings",
              "--no-auto-pr",
            ]),
          ) as { workflowId?: unknown; phase?: unknown } | null;
          if (typeof launched?.workflowId !== "string")
            fail("workflow", "the review did not launch");
          else {
            reviewId = launched.workflowId;
            const watchedId = reviewId;
            // Not awaited: the backend is followed from the launch while the
            // views select the review's tab.
            const watching = Promise.all(
              viewers.map(async (client) => {
                try {
                  await client.watchReview(watchedId);
                  return client;
                } catch (error) {
                  fail("workflow-visible", `${client.label}: ${firstLine(error)}`);
                  return null;
                }
              }),
            );
            const transitions: Array<{ phase: string; at: number }> = [];
            let phase = typeof launched.phase === "string" ? launched.phase : "";
            const completed = await until(
              "workflow-complete",
              launchAt,
              async () => {
                const read = await publicAction("review.get", { workflowId: reviewId });
                const next = (read.result as { phase?: unknown } | undefined)?.phase;
                if (typeof next === "string" && next !== phase) {
                  phase = next;
                  transitions.push({ phase: next, at: runtime.now() });
                }
                if (transitions.length > 0 && runtime.now() - transitions.at(-1)!.at < POLL_MS * 2)
                  await readMetrics();
                return REVIEW_TERMINAL.has(phase);
              },
              WORKFLOW_WAIT_MS,
            );
            record("workflow-complete", completed);
            if (phase !== "ready") fail("workflow", `the review ended ${phase || "unread"}`);
            else result.obligations.workflows += 1;
            for (const [id, timing] of runtime.validationRuns(reviewEnvironment.worktree))
              if (!validationsBefore.has(id)) result.validationRuns.push(timing);
            // Correlate by tool and result identity, never the next timestamp.
            // Submission precedes acceptance: this is a conservative upper bound,
            // independent of when the model receives the tool's callback.
            // Multi Review submits these three; `submit_review_preparation`
            // belongs to build pipelines, so a review never sends it.
            const expected = {
              submit_validation_plan: "reviewing",
              submit_review_report: "consolidating",
              submit_consolidated_review: "ready",
            };
            const after = fakeModel.workflow();
            /** Results the backend timed, which the review views time too. */
            const progress: Array<{ target: string; at: number }> = [];
            for (const [tool, target] of Object.entries(expected)) {
              const earlier = workflowsBefore[tool]?.submissions.length ?? 0;
              const submissions = after[tool]?.submissions.slice(earlier) ?? [];
              const transition = transitions.find((item) => item.phase === target);
              if (submissions.length !== 1 || !transition || transition.at < submissions[0]!.at) {
                fail("workflow-sample", `missing or ambiguous ${tool} -> ${target}`);
                continue;
              }
              record(
                tool === "submit_validation_plan" ? "workflow-validation" : "workflow-progress",
                Math.round(transition.at - submissions[0]!.at),
              );
              if (tool !== "submit_validation_plan")
                progress.push({ target, at: submissions[0]!.at });
            }
            // What each review view showed: wait for it to reach the end the
            // backend reached, then time every result against it.
            const settledAt = transitions.at(-1)?.at ?? runtime.now();
            for (const client of (await watching).filter(
              (entry): entry is BusyClient => entry !== null,
            )) {
              result.reviewViews.watched += 1;
              let sightings: ReviewSighting[] = [];
              const visible = await until(
                null,
                settledAt,
                async () => {
                  sightings = await client.reviewPhases();
                  return sightings.some((sighting) => sighting.phase === phase);
                },
                CLIENT_WAIT_MS,
              );
              if (visible === null)
                fail(
                  "workflow-visible",
                  `${client.label}: review did not show terminal phase ${phase}`,
                );
              for (const entry of progress) {
                const sample = clientProgressSample(sightings, entry.at, entry.target);
                if (sample.kind === "sample") {
                  record("workflow-progress-visible", sample.ms);
                  result.reviewViews.sampled += 1;
                } else if (sample.kind === "unobserved") result.reviewViews.unobserved += 1;
                else
                  result.timeouts["workflow-progress-visible"] =
                    (result.timeouts["workflow-progress-visible"] ?? 0) + 1;
              }
            }
          }

          // 7. Restore the cut client, or show the hidden one, and wait for it to converge.
          const resumed = outageClient ?? hiddenClient;
          if (resumed) {
            const resumeAt = runtime.now();
            if (outageClient) outageClient.setLinkUp(true);
            else await resumed.setHidden(false);
            cut.delete(resumed);
            const converged = await until(
              outageClient ? "outage-resume" : "hidden-resume",
              resumeAt,
              async () =>
                (await resumed.markerState(turnEnvironment.name)) === "idle" &&
                (await resumed.markerState(askEnvironment.name)) === "idle" &&
                !(await resumed.approvalVisible()),
              2 * BACKEND_WAIT_MS,
            );
            record(outageClient ? "outage-resume" : "hidden-resume", converged);
            if (converged === null) fail("resume", "the client did not converge");
          }
          for (const id of [held, queued])
            if ((fakeModel.marker(id)?.requests ?? 0) > 1) result.obligations.duplicates += 1;
          if ((fakeModel.marker(approval)?.requests ?? 0) > 2) result.obligations.duplicates += 1;
        } catch (error) {
          if (signal?.aborted) throw error;
          fail("round", firstLine(error));
          // Release model waiters; parked provider approvals require session.stop below.
          for (const id of [held, queued, approval]) fakeModel.release(id);
        }
        if (options.busyTurnFiles > 0)
          runtime.removeBurst([turnEnvironment.worktree], turnFilesPath);
        if (result.failures.length > failuresBefore) {
          for (const id of [held, queued, approval]) fakeModel.release(id);
          // A successful stop confirms provider work ended, including parked approvals.
          // Refuse to reuse an uncertain session; a cascade would obscure the cause.
          for (const session of [askSession, turnSession]) {
            const stopped = await step(["session", "stop", session.sessionId]);
            let idle = false;
            try {
              idle =
                (JSON.parse(stopped.stdout) as { error?: { code?: string } }).error?.code ===
                "session-idle";
            } catch {
              /* A malformed response is not confirmation. */
            }
            if (stopped.status !== 0 && !idle)
              throw new Error("Busy round cleanup could not confirm session stop");
          }
        }
        await Promise.all(clients.map((client) => client.close()));
        clients = [];
        await sampleWindow();
        result.rounds.push({
          clients: clientCount,
          round,
          durationMs: Math.round(runtime.now() - roundStartedAt),
          failed: result.failures.length > failuresBefore,
        });
      }
    }
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    result.modelRequests = fakeModel.counts().completions;
    await fakeModel.stop();
    result.durationMs = Math.round(elapsed());
  }
  return result;
}

/** p50, p95, max and count per row, for the summary and the artifact. */
export function busyRowSummary(result: BusyResult) {
  return (Object.keys(BUSY_ROWS) as BusyRow[]).map((row) => {
    const values = result.samples[row];
    const p95 = percentile(values, 95);
    const budgetMs = BUSY_ROWS[row].budgetMs;
    return {
      row,
      ...BUSY_ROWS[row],
      count: values.length,
      timeouts: result.timeouts[row] ?? 0,
      p50Ms: percentile(values, 50),
      p95Ms: p95,
      maxMs: values.length > 0 ? Math.max(...values) : null,
      withinBudget: budgetMs === null || p95 === null ? null : p95 <= budgetMs,
    };
  });
}

/** Markdown lines for the busy phase, appended to the driver's summary. */
export function busySummaryLines(label: string, result: BusyResult): string[] {
  const lines = [
    "",
    `Busy phase, ${label}: ${result.environments} environments, ${result.rounds.length} rounds (${
      [...new Set(result.rounds.map((round) => round.clients))].join(", ") || "none"
    } clients) over ${Math.round(result.durationMs / 60_000)} min, ${result.modelRequests} model requests.`,
    `Obligations: ${result.obligations.turns} held turns, ${result.obligations.queued} queued prompts, ${
      result.obligations.approvals
    } approvals, ${result.obligations.mails} mails, ${result.obligations.workflows} reviews completed, ${
      result.obligations.duplicates
    } duplicated dispatches${
      result.turnFileRounds > 0 ? `, ${result.turnFileRounds} held turns wrote files` : ""
    }. Failures: ${
      result.failures
        .map(
          (entry) =>
            `${entry.step} (${entry.clients} clients, round ${entry.round}${entry.detail ? `: ${entry.detail}` : ""})`,
        )
        .join(", ") || "none"
    }.`,
    `Admission: ${
      Object.entries(result.admission)
        .sort()
        .map(
          ([pool, peak]) =>
            `${pool} ${peak.granted} granted, ${peak.rejected} refused, at most ${peak.maxActive} active and ${peak.maxWaiting} waiting (oldest ${peak.maxOldestWaitMs} ms)`,
        )
        .join("; ") || "not read"
    }.`,
    `Review views: ${result.reviewViews.watched} watched a review, ${
      result.reviewViews.sampled
    } results timed in a view, ${
      result.reviewViews.unobserved
    } reached the backend before the view showed the review (not sampled).`,
    `Validation runs (queue/commands/run ms): ${
      result.validationRuns
        .map((run) => `${run.queuedMs}/${run.commandMs}/${run.runMs}`)
        .join(", ") || "none read"
    }.`,
    "",
    "| Row | Side | Samples | Timeouts | p50 ms | p95 ms | Max ms | Budget (p95) | Within |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of busyRowSummary(result)) {
    lines.push(
      `| ${entry.label} | ${entry.side} | ${entry.count} | ${entry.timeouts} | ${entry.p50Ms ?? "—"} | ${
        entry.p95Ms ?? "—"
      } | ${entry.maxMs ?? "—"} | ${entry.budgetMs === null ? "none" : `≤ ${entry.budgetMs}`} | ${
        entry.withinBudget === null ? "—" : entry.withinBudget ? "yes" : "no"
      } |`,
    );
  }
  return lines;
}

/** A busy phase passes with every obligation kept and no wait run out. */
export function busyFailed(result: BusyResult): boolean {
  return (
    result.failures.length > 0 ||
    result.obligations.duplicates > 0 ||
    Object.values(result.timeouts).some((count) => (count ?? 0) > 0)
  );
}
