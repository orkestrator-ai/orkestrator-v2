import {
  RECURRING_JOB_CATALOGUE,
  RECURRING_JOB_KINDS,
  type RecurringJobKind,
  type RecurringWorkKindSnapshot,
  type RecurringWorkSnapshot,
  type RecurringWorkUnit,
} from "@orkestrator/protocol/recurring-work";
import {
  DiffStatsService,
  readSharedFileList,
  type DiffStatsTarget,
} from "../src/core/diff-stats-service.js";
import { GitFetchScheduler } from "../src/core/git-fetch-scheduler.js";
import { PrMonitorService, type PrMonitorTarget } from "../src/core/pr-monitor.js";
import { CLAUDE_STATE_POLL_INTERVAL_MS, ClaudeStatePollManager } from "../src/core/tmux-poll.js";
import { RecurringWorkMetrics } from "../src/core/recurring-work-metrics.js";
import { ManualTime } from "../src/core/recurring-test-support.js";
import {
  runNativeObservationBaseline,
  type NativeObservationResult,
} from "./recurring-baseline-native.js";

/**
 * Deterministic recurring-work baseline.
 *
 * Drives the *real* backend owners whose scheduling logic decides how much
 * physical work happens — diff statistics, the shared Files-panel cache, the
 * local Git fetch scheduler, PR monitoring and Claude terminal-state polling —
 * against a manual clock and fake Git/gh/Docker seams. Each seam charges the
 * physical work units the production scanner performs per call at this commit
 * (see {@link PHYSICAL_COST}), so the artifact counts scheduled attempts,
 * joins, cache hits and modelled spawns without touching a real repository,
 * container, GitHub or provider.
 *
 * Owners that need a full backend (native activity sweep, queues, mail,
 * workflow supervisors) are reported separately as *modelled* nominal attempt
 * counts derived from their catalogue cadence; they are marked as such and are
 * never mixed with driven counters.
 *
 * This is a call-count baseline, not a wall-clock profile. Only the optional
 * `overhead` block measures real time, and comparisons ignore it.
 */

export const BASELINE_SCHEMA_VERSION = 1;

/**
 * Physical cost of one call through each seam, read from the production code
 * at this commit. Update alongside the scanner when it changes.
 */
export const PHYSICAL_COST = {
  /**
   * `getLocalGitStatusDetailed(…, includeUncommitted=true)` against a branch
   * baseline: exclude-file lookup (1 git + 1 read), `origin/<ref>` existence
   * (1 git), name-status + numstat + porcelain (3 git), one read per untracked
   * file. The fetch goes through the real {@link GitFetchScheduler}.
   */
  localScanGitSpawns: 5,
  localScanFileReads: 1,
  /** One `docker exec` running the framed status script (which also fetches). */
  containerScanDockerExecs: 1,
  /** `buildFileTree`: one readdir per directory. */
  localTreeDirectoryReads: 40,
  /** Branch resolution before discovery: one `git`/`docker exec`. */
  prBranchResolutionSpawns: 1,
} as const;

export interface BaselineScenario {
  id: string;
  environments: number;
  /** Fraction of environments that are local worktrees; the rest are containers. */
  localShare: number;
  /** Connected clients, each with the Files panel open on environment 0. */
  clients: number;
  /** PR state per environment, cycled: `none` → `open` → `terminal`. */
  prMix: "none" | "mixed";
  /** Completed (inactive) records per workflow store, for modelled scans. */
  completedWorkflows: number;
  untrackedFilesPerEnvironment: number;
}

export const DEFAULT_SCENARIOS: readonly BaselineScenario[] = [
  scenario("env1-local-c0", 1, 1, 0, "none", 0),
  scenario("env1-local-c1", 1, 1, 1, "none", 0),
  scenario("env1-container-c1", 1, 0, 1, "none", 0),
  scenario("env10-local-c0-pr", 10, 1, 0, "mixed", 0),
  scenario("env10-mixed-c0-pr-wf200", 10, 0.5, 0, "mixed", 200),
  scenario("env10-mixed-c1-pr-wf200", 10, 0.5, 1, "mixed", 200),
  scenario("env10-mixed-c2-pr-wf200", 10, 0.5, 2, "mixed", 200),
  scenario("env10-container-c0-pr", 10, 0, 0, "mixed", 0),
  scenario("env50-mixed-c0-pr-wf200", 50, 0.5, 0, "mixed", 200),
  scenario("env50-mixed-c2-pr-wf200", 50, 0.5, 2, "mixed", 200),
  scenario("env50-container-c1-pr", 50, 0, 1, "mixed", 0),
];

function scenario(
  id: string,
  environments: number,
  localShare: number,
  clients: number,
  prMix: BaselineScenario["prMix"],
  completedWorkflows: number,
): BaselineScenario {
  return {
    id,
    environments,
    localShare,
    clients,
    prMix,
    completedWorkflows,
    untrackedFilesPerEnvironment: 3,
  };
}

export interface BaselinePhases {
  /** From backend start until tracking has settled. */
  startupMs: number;
  /** Warm idle window measured after startup; must cover a 5 min fetch TTL. */
  idleMs: number;
  /** Files-panel refresh cadence (`useFilesPanel` AUTO_REFRESH_INTERVAL). */
  clientRefreshMs: number;
}

export const DEFAULT_PHASES: BaselinePhases = {
  startupMs: 30_000,
  idleMs: 10 * 60_000,
  clientRefreshMs: 5_000,
};

export type KindCounters = Partial<
  Pick<
    RecurringWorkKindSnapshot,
    | "requested"
    | "coalesced"
    | "started"
    | "completed"
    | "failed"
    | "changed"
    | "unchanged"
    | "cacheHits"
    | "cacheMisses"
  >
> & { workUnits?: Partial<Record<RecurringWorkUnit, number>> };

export interface ModelledKind {
  nominalCadenceMs: number;
  attempts: number;
  recordsScanned?: number;
}

export interface ScenarioResult {
  id: string;
  fixture: BaselineScenario & { local: number; container: number; prs: Record<string, number> };
  startup: Partial<Record<RecurringJobKind, KindCounters>>;
  idle: Partial<Record<RecurringJobKind, KindCounters>>;
  /** Idle physical work per minute, all driven kinds combined. */
  idlePhysicalPerMinute: Partial<Record<RecurringWorkUnit, number>>;
  /** Nominal attempts for owners this harness does not drive. */
  modelledIdle: Partial<Record<RecurringJobKind, ModelledKind>>;
}

export interface BaselineArtifact {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  kind: "recurring-work-baseline";
  method: "deterministic-call-count";
  generatedBy: "apps/backend/scripts/recurring-baseline.ts";
  environment: {
    commit: string;
    platform: string;
    arch: string;
    runtime: string;
  };
  phases: BaselinePhases;
  physicalCost: typeof PHYSICAL_COST;
  flags: { recurringMetrics: "enabled"; modelledKinds: RecurringJobKind[] };
  scenarios: ScenarioResult[];
  /**
   * Driven native activity sweep and queue scan, rollback vs shared
   * observation (step 07). Absent from artifacts produced before step 07.
   */
  nativeObservation?: NativeObservationResult;
  /** Real-time measurements; excluded from comparisons. */
  overhead?: { observeEnabledNsPerOp: number; observeDisabledNsPerOp: number; iterations: number };
  limitations: string[];
}

const MODELLED_KINDS: readonly RecurringJobKind[] = [
  "native-activity-sweep",
  "native-launch-scan",
  "native-queue-scan",
  "claude-state-reconcile",
  "tmux-queue-drain",
  "mail-presence",
  "mail-injection",
  "pending-rename-reconcile",
  "coordinator-repair",
  "mail-retention",
  "activity-lease-expiry",
  "tab-cleanup",
  "build-supervisor-tick",
  "looped-review-tick",
  "feature-planning-tick",
];

/** Workflow ticks enumerate every stored record of their store per tick. */
const RECORD_SCANNING_TICKS: ReadonlySet<RecurringJobKind> = new Set([
  "build-supervisor-tick",
  "looped-review-tick",
]);

export const BASELINE_LIMITATIONS = [
  "Call-count model on a manual clock: no process, container, repository, GitHub or provider is touched, and durations are not measured.",
  "Physical units per seam call come from PHYSICAL_COST, read from the production scanners at this commit; the real scanners are not executed.",
  "Driven owners: diff statistics (watched local / polled container), the shared Files-panel cache, local git fetch scheduling, PR monitoring with check rollups, and Claude terminal-state polls (one per running container).",
  "Native activity sweep, launch/queue scans, mail, coordinator repair, retention, tab cleanup and workflow ticks are modelled from nominal cadence only in the per-scenario blocks; their provider reads and storage costs need a live isolated profile.",
  "The nativeObservation block (step 07) drives the real native activity sweep and native queue scan with fake providers counted at the provider boundary, over one 10-environment fixture, in rollback and shared modes; bridge-side cost per read and mail, coordinator and workflow consumers are not driven.",
  "Multi review uses an adaptive due scheduler by default (reconcile every 15 s plus per-workflow due passes); it is not modelled because idle cost depends on active workflows.",
  "Local environments use a branch baseline, so every scan consults the fetch scheduler; environments created from an immutable commit skip that path.",
  "No watcher change events occur in the idle window; burst edits, long reads, outages and approval/completion freshness need the live isolated profile described in the README.",
  "Clients model the Files panel open on environment 0 with both the file list and file tree refreshing every 5 s; other renderer polling (native session views, meters) is not driven.",
];

type Fixture = {
  target: DiffStatsTarget;
  pr: "none" | "open" | "terminal";
};

function buildFixtures(input: BaselineScenario): Fixture[] {
  const localCount = Math.round(input.environments * input.localShare);
  const states: Fixture["pr"][] = input.prMix === "none" ? ["none"] : ["none", "open", "terminal"];
  return Array.from({ length: input.environments }, (_, index) => {
    const environmentId = `env-${index}`;
    const local = index < localCount;
    return {
      target: local
        ? {
            environmentId,
            kind: "local",
            // Worktrees of one project share a common git dir, as in production.
            worktreePath: `/fixture/worktrees/${environmentId}`,
            comparisonRef: "main",
          }
        : {
            environmentId,
            kind: "container",
            containerId: `container-${index}`,
            comparisonRef: "main",
          },
      pr: states[index % states.length]!,
    };
  });
}

function prTarget(fixture: Fixture): PrMonitorTarget {
  const target = fixture.target;
  const prUrl = fixture.pr === "none" ? null : `https://example.invalid/pr/${target.environmentId}`;
  return {
    environmentId: target.environmentId,
    branch: `feature/${target.environmentId}`,
    kind: target.kind,
    worktreePath: target.worktreePath,
    containerId: target.containerId,
    ready: true,
    prUrl,
    prState: fixture.pr === "open" ? "open" : fixture.pr === "terminal" ? "merged" : null,
    hasMergeConflicts: false,
  };
}

/** Runs one scenario on its own clock and recorder. Deterministic. */
export async function runScenario(
  input: BaselineScenario,
  phases: BaselinePhases = DEFAULT_PHASES,
): Promise<ScenarioResult> {
  const time = new ManualTime(1_000_000);
  const metrics = new RecurringWorkMetrics({ now: time.now });
  const fixtures = buildFixtures(input);
  const byEnvironment = new Map(fixtures.map((fixture) => [fixture.target.environmentId, fixture]));

  const fetches = new GitFetchScheduler({
    metrics,
    now: time.now,
    run: async (args) => {
      metrics.work("git-spawn");
      // All fixture worktrees belong to one project clone.
      return { stdout: args.includes("--git-common-dir") ? "/fixture/repo/.git" : "" };
    },
  });

  const scanLocal = async (worktreePath: string) => {
    metrics.work("git-spawn", PHYSICAL_COST.localScanGitSpawns);
    metrics.work(
      "file-read",
      PHYSICAL_COST.localScanFileReads + input.untrackedFilesPerEnvironment,
    );
    await fetches.ensureFetched(worktreePath, "main");
    return [];
  };
  const scanContainer = async () => {
    metrics.requested("git-fetch-container");
    metrics.work("docker-exec", PHYSICAL_COST.containerScanDockerExecs);
    return [];
  };

  const diffStats = new DiffStatsService({
    metrics,
    emit: () => undefined,
    monotonicNow: time.now,
    now: () => new Date(0).toISOString(),
    schedule: (callback, intervalMs) => time.setInterval(callback, intervalMs),
    cancel: (timer) => time.clear(timer),
    // Local worktrees are watched; an idle worktree emits no change events.
    startWatcher: () => ({ watching: true, close: () => undefined }),
    scan: async (target) => ({
      stats: { additions: 0, deletions: 0, filesChanged: 0, truncated: false },
      changes:
        target.kind === "local" ? await scanLocal(target.worktreePath!) : await scanContainer(),
    }),
  });

  const prMonitor = new PrMonitorService({
    metrics,
    // Deterministic startup/terminal jitter (production uses Math.random).
    random: seededRandom(input.id),
    emit: () => undefined,
    now: () => new Date(0).toISOString(),
    monotonicNow: time.now,
    schedule: (callback, delayMs) => time.setTimeout(callback, delayMs),
    cancel: (timer) => time.clear(timer),
    effects: {
      detect: async (target, options) => {
        const fixture = byEnvironment.get(target.environmentId)!;
        const spawn: RecurringWorkUnit = target.kind === "local" ? "gh-spawn" : "docker-exec";
        const known = target.prUrl && target.prState !== "merged" && target.prState !== "closed";
        if (!known) {
          metrics.work(
            target.kind === "local" ? "git-spawn" : "docker-exec",
            PHYSICAL_COST.prBranchResolutionSpawns,
          );
        }
        metrics.work(spawn);
        if (fixture.pr === "none") return null;
        const state = fixture.pr === "open" ? "open" : "merged";
        if (state === "open" && options?.includeCheckSummary) {
          metrics.requested("pr-check-rollup");
          await metrics.observe("pr-check-rollup", async () => metrics.work(spawn));
          return {
            url: target.prUrl!,
            state,
            hasMergeConflicts: false,
            checkSummary: null,
            checkSummaryStatus: "succeeded" as const,
          };
        }
        return {
          url: target.prUrl ?? `https://example.invalid/pr/${target.environmentId}`,
          state,
          hasMergeConflicts: false,
          checkSummary: null,
          checkSummaryStatus: "skipped" as const,
        };
      },
      persistPr: async () => undefined,
      clearPr: async () => undefined,
      findTaskForEnvironment: async () => null,
      moveTaskToReview: async () => undefined,
      addTaskComment: async () => undefined,
      updateTaskPrMetadata: async () => undefined,
    },
  });

  const statePolls = new ClaudeStatePollManager({
    metrics,
    schedule: (callback) => time.setInterval(callback, CLAUDE_STATE_POLL_INTERVAL_MS),
    cancel: (timer) => time.clear(timer),
    now: () => new Date(0).toISOString(),
    nowMs: time.now,
    readState: async () => {
      metrics.work("docker-exec");
      return "idle";
    },
  });
  const environments = fixtures
    .filter((fixture) => fixture.target.kind === "container")
    .map((fixture) => ({
      id: fixture.target.environmentId,
      containerId: fixture.target.containerId,
      status: "running",
      agentActivitySources: {},
    }));
  const pollContext = {
    emit: () => undefined,
    storage: {
      loadEnvironments: async () => {
        // A stat-validated cached read in production.
        metrics.work("storage-stat");
        return environments;
      },
      setEnvironmentAgentActivity: async () => {
        metrics.work("storage-write");
        return { agentActivitySources: { "claude-terminal": { state: "idle", updatedAt: "" } } };
      },
    },
  } as unknown as Parameters<ClaudeStatePollManager["start"]>[1];

  // --- startup -------------------------------------------------------------
  for (const fixture of fixtures) diffStats.track(fixture.target);
  prMonitor.sync(fixtures.map(prTarget));
  for (const fixture of fixtures) {
    if (fixture.target.containerId) statePolls.start(fixture.target.containerId, pollContext);
  }

  const clientReads = () => {
    const target = fixtures[0]!.target;
    const lookup =
      target.kind === "local"
        ? { worktreePath: target.worktreePath }
        : { containerId: target.containerId };
    for (let client = 0; client < input.clients; client += 1) {
      void readSharedFileList({
        service: diffStats,
        metrics,
        lookup,
        comparisonRef: target.comparisonRef,
        maxAgeMs: 3_000,
        scan: () => (target.kind === "local" ? scanLocal(target.worktreePath!) : scanContainer()),
      });
      // The file tree walks before its digest is compared.
      metrics.requested("file-tree-read");
      void metrics.observe("file-tree-read", async (span) => {
        span.work("directory-walk");
        if (target.kind === "local") {
          span.work("directory-read", PHYSICAL_COST.localTreeDirectoryReads);
        } else {
          span.work("docker-exec");
        }
        span.unchanged();
      });
    }
  };
  if (input.clients > 0) {
    clientReads();
    time.setInterval(clientReads, phases.clientRefreshMs);
  }

  await time.advance(phases.startupMs);
  const startup = compact(metrics.snapshot());
  metrics.reset();
  await time.advance(phases.idleMs);
  const idleSnapshot = metrics.snapshot();
  const idle = compact(idleSnapshot);

  diffStats.shutdown();
  prMonitor.shutdown();
  for (const fixture of fixtures) {
    if (fixture.target.containerId) statePolls.shutdown(fixture.target.containerId);
  }

  const minutes = phases.idleMs / 60_000;
  const physical: Partial<Record<RecurringWorkUnit, number>> = {};
  for (const counters of Object.values(idle)) {
    for (const [unit, count] of Object.entries(counters.workUnits ?? {})) {
      physical[unit as RecurringWorkUnit] = (physical[unit as RecurringWorkUnit] ?? 0) + count;
    }
  }
  const idlePhysicalPerMinute = Object.fromEntries(
    Object.entries(physical)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([unit, count]) => [unit, round(count / minutes)]),
  ) as Partial<Record<RecurringWorkUnit, number>>;

  const local = fixtures.filter((fixture) => fixture.target.kind === "local").length;
  const prs = { none: 0, open: 0, terminal: 0 };
  for (const fixture of fixtures) prs[fixture.pr] += 1;
  return {
    id: input.id,
    fixture: { ...input, local, container: fixtures.length - local, prs },
    startup,
    idle,
    idlePhysicalPerMinute,
    modelledIdle: modelled(input, phases.idleMs),
  };
}

function modelled(
  input: BaselineScenario,
  windowMs: number,
): Partial<Record<RecurringJobKind, ModelledKind>> {
  const result: Partial<Record<RecurringJobKind, ModelledKind>> = {};
  for (const kind of MODELLED_KINDS) {
    const cadence = RECURRING_JOB_CATALOGUE[kind].nominalCadenceMs;
    if (!cadence) continue;
    const attempts = Math.floor(windowMs / cadence);
    result[kind] = {
      nominalCadenceMs: cadence,
      attempts,
      ...(RECORD_SCANNING_TICKS.has(kind)
        ? { recordsScanned: attempts * input.completedWorkflows }
        : {}),
    };
  }
  return result;
}

const COUNTER_FIELDS = [
  "requested",
  "coalesced",
  "started",
  "completed",
  "failed",
  "changed",
  "unchanged",
  "cacheHits",
  "cacheMisses",
] as const;

/** Deterministic counters only: no ages, durations or histograms. */
function compact(snapshot: RecurringWorkSnapshot): Partial<Record<RecurringJobKind, KindCounters>> {
  const result: Partial<Record<RecurringJobKind, KindCounters>> = {};
  for (const kind of RECURRING_JOB_KINDS) {
    const entry = snapshot.kinds[kind];
    if (!entry) continue;
    const counters: KindCounters = {};
    for (const field of COUNTER_FIELDS) if (entry[field] > 0) counters[field] = entry[field];
    const units = Object.entries(entry.workUnits).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    if (units.length > 0) counters.workUnits = Object.fromEntries(units);
    result[kind] = counters;
  }
  return result;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Seeded uniform [0, 1) source (mulberry32) for owners that jitter their
 * schedules, so a scenario reproduces exactly while still exercising spread
 * rather than a degenerate constant.
 */
export function seededRandom(seedText: string): () => number {
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    seed = Math.imul(seed ^ seedText.charCodeAt(index), 16777619);
  }
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Real-time cost of one observed attempt, enabled vs disabled. Non-deterministic. */
export function measureOverhead(iterations = 200_000): BaselineArtifact["overhead"] {
  const measure = (enabled: boolean) => {
    const metrics = new RecurringWorkMetrics({ enabled });
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      metrics.requested("tmux-poll");
      metrics.observe("tmux-poll", () => undefined);
    }
    return ((performance.now() - started) * 1e6) / iterations;
  };
  measure(true);
  return {
    observeEnabledNsPerOp: Math.round(measure(true)),
    observeDisabledNsPerOp: Math.round(measure(false)),
    iterations,
  };
}

export async function runBaseline(options: {
  scenarios?: readonly BaselineScenario[];
  phases?: BaselinePhases;
  environment: BaselineArtifact["environment"];
  overhead?: boolean;
  /** Include the driven native observation block (default true). */
  nativeObservation?: boolean;
}): Promise<BaselineArtifact> {
  const phases = options.phases ?? DEFAULT_PHASES;
  const scenarios: ScenarioResult[] = [];
  for (const input of options.scenarios ?? DEFAULT_SCENARIOS) {
    scenarios.push(await runScenario(input, phases));
  }
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    kind: "recurring-work-baseline",
    method: "deterministic-call-count",
    generatedBy: "apps/backend/scripts/recurring-baseline.ts",
    environment: options.environment,
    phases,
    physicalCost: PHYSICAL_COST,
    flags: { recurringMetrics: "enabled", modelledKinds: [...MODELLED_KINDS] },
    scenarios,
    ...(options.nativeObservation === false
      ? {}
      : { nativeObservation: await runNativeObservationBaseline() }),
    ...(options.overhead ? { overhead: measureOverhead() } : {}),
    limitations: [...BASELINE_LIMITATIONS],
  };
}

export interface BaselineDifference {
  scenario: string;
  phase: "startup" | "idle" | "modelledIdle" | "idlePhysicalPerMinute" | "nativeObservation";
  kind: string;
  field: string;
  baseline: number;
  candidate: number;
}

/**
 * Field-by-field comparison of two artifacts' deterministic counters. The
 * environment, overhead and limitations blocks are ignored.
 */
export function compareBaselines(
  baseline: BaselineArtifact,
  candidate: BaselineArtifact,
): BaselineDifference[] {
  const differences: BaselineDifference[] = [];
  const candidates = new Map(candidate.scenarios.map((entry) => [entry.id, entry]));
  for (const before of baseline.scenarios) {
    const after = candidates.get(before.id);
    if (!after) {
      differences.push({
        scenario: before.id,
        phase: "idle",
        kind: "*",
        field: "missing-scenario",
        baseline: 1,
        candidate: 0,
      });
      continue;
    }
    for (const phase of ["startup", "idle", "modelledIdle"] as const) {
      const left = flatten(before[phase] as Record<string, unknown>);
      const right = flatten(after[phase] as Record<string, unknown>);
      for (const key of new Set([...left.keys(), ...right.keys()])) {
        const a = left.get(key) ?? 0;
        const b = right.get(key) ?? 0;
        if (a === b) continue;
        const [kind = "", ...rest] = key.split(".");
        differences.push({
          scenario: before.id,
          phase,
          kind,
          field: rest.join("."),
          baseline: a,
          candidate: b,
        });
      }
    }
    const left = flatten({ all: before.idlePhysicalPerMinute });
    const right = flatten({ all: after.idlePhysicalPerMinute });
    for (const key of new Set([...left.keys(), ...right.keys()])) {
      const a = left.get(key) ?? 0;
      const b = right.get(key) ?? 0;
      if (a !== b) {
        differences.push({
          scenario: before.id,
          phase: "idlePhysicalPerMinute",
          kind: "all",
          field: key.slice("all.".length),
          baseline: a,
          candidate: b,
        });
      }
    }
  }
  // Compared only when both artifacts carry the driven native block.
  if (baseline.nativeObservation && candidate.nativeObservation) {
    const left = flatten(baseline.nativeObservation.modes as unknown as Record<string, unknown>);
    const right = flatten(candidate.nativeObservation.modes as unknown as Record<string, unknown>);
    for (const key of new Set([...left.keys(), ...right.keys()])) {
      const a = left.get(key) ?? 0;
      const b = right.get(key) ?? 0;
      if (a === b) continue;
      const [mode = "", ...rest] = key.split(".");
      differences.push({
        scenario: "native-observation",
        phase: "nativeObservation",
        kind: mode,
        field: rest.join("."),
        baseline: a,
        candidate: b,
      });
    }
  }
  return differences;
}

function flatten(value: Record<string, unknown>, prefix = "", out = new Map<string, number>()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "number") out.set(path, child);
    else if (child && typeof child === "object")
      flatten(child as Record<string, unknown>, path, out);
  }
  return out;
}
