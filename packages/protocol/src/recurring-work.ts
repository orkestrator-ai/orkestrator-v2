/**
 * Shared, content-free vocabulary for recurring background work.
 *
 * Every recurring job in Orkestrator — a PR poll, a diff scan, a workflow tick,
 * a renderer refresh — is named by one entry of {@link RECURRING_JOB_KINDS}.
 * The names are the only labels recurring-work metrics may carry: an
 * environment id, a path, a branch, a URL, a prompt or a command's output can
 * never become a dimension, because the recording API has nowhere to put one.
 *
 * The catalogue records what the inventory in
 * `docs/imrovements/recurring-processes.md` established about each family:
 * which process owns it, what triggers it, its default priority class, its
 * nominal cadence, what happens when it is requested while already running,
 * and how a missed run is recovered. It describes the system as it is, so a
 * later change to a cadence or policy must update the entry in the same
 * change. It is data for diagnostics and the baseline harness, not a switch:
 * nothing reads a cadence from here to drive a timer.
 *
 * Deliberately dependency-free so a bridge or the renderer can report against
 * the same names later without importing backend code.
 */

export const RECURRING_WORK_SCHEMA_VERSION = 1;

export const RECURRING_JOB_KINDS = [
  // Backend: PR, Git and file state.
  "pr-detection",
  "pr-check-rollup",
  "diff-scan",
  "file-list-read",
  "file-tree-read",
  "git-fetch-local",
  "git-fetch-container",
  // Backend: agent observation and queues.
  "native-activity-sweep",
  "native-launch-scan",
  "native-queue-scan",
  "native-interaction-observe",
  "claude-state-reconcile",
  "tmux-poll",
  "tmux-interactive-capture",
  "tmux-queue-drain",
  "mail-presence",
  "mail-injection",
  "pending-rename-reconcile",
  "coordinator-repair",
  "mail-retention",
  "activity-lease-expiry",
  "tab-cleanup",
  // Backend: workflows.
  "build-supervisor-tick",
  "looped-review-tick",
  "looped-review-lease-renewal",
  "multi-review-tick",
  "multi-review-lease-renewal",
  "feature-planning-tick",
  "validation-heartbeat",
  "storage-lock-heartbeat",
  // Backend: host samples, providers and transport.
  "system-usage-sample",
  "process-usage",
  "opencode-reconnect",
  "gateway-heartbeat",
  // Renderer.
  "client-native-session-refresh",
  "client-files-panel",
  "client-resource-manifest",
  "client-reviewer-transcript",
  "client-validation-output",
  "client-init-logs",
  "client-system-meters",
  "client-docker-availability",
  "client-connection-health",
  "client-coordinator-panel",
  "client-design-canvas",
  "client-browser-annotation",
  "client-cursor-login",
  // Bridges and desktop.
  "bridge-sse-keepalive",
  "bridge-idle-sweep",
  "bridge-parent-watchdog",
  "acp-disconnect-poll",
  "bridge-diagnostics-heartbeat",
  "desktop-log-retention",
] as const;
export type RecurringJobKind = (typeof RECURRING_JOB_KINDS)[number];

export const RECURRING_WORK_OWNERS = ["backend", "bridge", "renderer", "desktop"] as const;
export type RecurringWorkOwner = (typeof RECURRING_WORK_OWNERS)[number];

/** What causes one attempt: a clock, a completed run, a change hint, a read, or a user. */
export const RECURRING_TRIGGERS = [
  "interval",
  "completion",
  "watcher",
  "read",
  "explicit",
  "event",
  "lease",
] as const;
export type RecurringTrigger = (typeof RECURRING_TRIGGERS)[number];

/**
 * Scheduling priority, highest first.
 *
 * `critical` is deadline work — lease renewal, approval/authentication expiry,
 * watchdogs — and never shares capacity with anything below it. `interactive`
 * is a user waiting on the answer. `recovery` repairs durable obligations and
 * is guaranteed reserved capacity. `progress` advances running work,
 * `discovery` notices new facts quietly, and `maintenance` is retention and
 * cleanup that can wait.
 */
export const RECURRING_PRIORITY_CLASSES = [
  "critical",
  "interactive",
  "recovery",
  "progress",
  "discovery",
  "maintenance",
] as const;
export type RecurringPriorityClass = (typeof RECURRING_PRIORITY_CLASSES)[number];

/** What a request does while the same work is already running. */
export const RECURRING_IN_FLIGHT_POLICIES = [
  /** Callers await the running attempt; nothing reruns. */
  "join",
  /** Callers await the running attempt and one trailing rerun is queued. */
  "trailing-rerun",
  /** A request that lands during a run is dropped; the next tick retries. */
  "skip-while-running",
  /** Serialized per target key, with at most one pending rerun per key. */
  "per-key-serial",
  /** No overlap guard exists at this layer. */
  "unguarded",
] as const;
export type RecurringInFlightPolicy = (typeof RECURRING_IN_FLIGHT_POLICIES)[number];

/** How a missed or failed run converges. */
export const RECURRING_RECOVERY_CONTRACTS = [
  /** Rebuilt from durable storage on the next pass or at startup. */
  "storage-reconcile",
  /** Clients re-read an authoritative snapshot on mount/reconnect. */
  "snapshot-rehydrate",
  /** The next scheduled attempt repairs it; nothing else does. */
  "next-tick",
  /** A slower safety scan covers missed change hints. */
  "safety-scan",
  /** Expiry of a lease or deadline is itself the recovery. */
  "lease-expiry",
  /** Transport replay/reconnect restores the missed frames. */
  "reconnect-replay",
  /** Presentation only: nothing to recover. */
  "none",
] as const;
export type RecurringRecoveryContract = (typeof RECURRING_RECOVERY_CONTRACTS)[number];

export interface RecurringJobDescriptor {
  /** Inventory row(s) in the investigation, e.g. `B03`. */
  inventory: string;
  owner: RecurringWorkOwner;
  trigger: RecurringTrigger;
  priority: RecurringPriorityClass;
  /** Nominal period of the dominant trigger; `null` when purely demand-driven. */
  nominalCadenceMs: number | null;
  inFlight: RecurringInFlightPolicy;
  recovery: RecurringRecoveryContract;
  /** Whether the owning process records this kind today. */
  instrumented: boolean;
}

const backend = (
  inventory: string,
  trigger: RecurringTrigger,
  priority: RecurringPriorityClass,
  nominalCadenceMs: number | null,
  inFlight: RecurringInFlightPolicy,
  recovery: RecurringRecoveryContract,
  instrumented = true,
): RecurringJobDescriptor => ({
  inventory,
  owner: "backend",
  trigger,
  priority,
  nominalCadenceMs,
  inFlight,
  recovery,
  instrumented,
});

const external = (
  owner: Exclude<RecurringWorkOwner, "backend">,
  inventory: string,
  trigger: RecurringTrigger,
  priority: RecurringPriorityClass,
  nominalCadenceMs: number | null,
  inFlight: RecurringInFlightPolicy,
  recovery: RecurringRecoveryContract,
): RecurringJobDescriptor => ({
  inventory,
  owner,
  trigger,
  priority,
  nominalCadenceMs,
  inFlight,
  recovery,
  instrumented: false,
});

/**
 * Current behavior, one entry per kind. Cadences are the dominant nominal
 * period; conditional variants (pending PR modes, container vs watched diff
 * scans, active vs idle native views) are described in the investigation.
 */
export const RECURRING_JOB_CATALOGUE: Readonly<Record<RecurringJobKind, RecurringJobDescriptor>> = {
  // Completion-scheduled 20 s normal / 5 s create / 1 s merge; 5 min error backoff.
  "pr-detection": backend(
    "B01,B02",
    "completion",
    "discovery",
    20_000,
    "trailing-rerun",
    "storage-reconcile",
  ),
  // Inside a detection, at most once per 60 s per entry.
  "pr-check-rollup": backend("B02", "completion", "discovery", 60_000, "join", "next-tick"),
  // Watched local: 400 ms coalesced hints + 120 s safety; container/unwatched: 15 s.
  "diff-scan": backend("B03", "watcher", "discovery", 15_000, "trailing-rerun", "safety-scan"),
  // Files panel reads, served by the worktree snapshot owner (step 03): they
  // join the owner's scan/walk; a result stays valid until a watcher hint
  // (qualified watched worktree) or for 3 s (unwatched). Panel polls every 5 s.
  "file-list-read": backend("B04", "read", "interactive", null, "join", "snapshot-rehydrate"),
  "file-tree-read": backend("B04", "read", "interactive", null, "join", "snapshot-rehydrate"),
  // Read-driven, 5 min TTL per common git dir + ref, joined in flight.
  "git-fetch-local": backend("B05", "read", "discovery", 300_000, "join", "next-tick"),
  // Step 04: consulted by every container status scan but separate from it;
  // 5 min attempt cooldown per container generation + clone + ref, joined in
  // flight, immutable local baselines never fetch (`container-git-fetch.ts`).
  "git-fetch-container": backend("F02", "read", "discovery", 300_000, "join", "next-tick"),
  "native-activity-sweep": backend("B06", "interval", "progress", 2_000, "join", "next-tick"),
  "native-launch-scan": backend(
    "B07",
    "interval",
    "recovery",
    2_000,
    "per-key-serial",
    "storage-reconcile",
  ),
  "native-queue-scan": backend(
    "B07",
    "interval",
    "progress",
    2_000,
    "per-key-serial",
    "storage-reconcile",
  ),
  // Only while the observe-only interaction monitor is enabled.
  "native-interaction-observe": backend(
    "B08",
    "interval",
    "progress",
    2_000,
    "join",
    "snapshot-rehydrate",
  ),
  "claude-state-reconcile": backend(
    "B09",
    "interval",
    "recovery",
    2_000,
    "unguarded",
    "storage-reconcile",
  ),
  // Per tracked container, every second, trailing rerun on overlap.
  "tmux-poll": backend("B18", "interval", "progress", 1_000, "trailing-rerun", "next-tick"),
  "tmux-interactive-capture": backend(
    "B19",
    "completion",
    "interactive",
    250,
    "per-key-serial",
    "snapshot-rehydrate",
    false,
  ),
  "tmux-queue-drain": backend("B09", "interval", "progress", 2_000, "join", "storage-reconcile"),
  // Presence TTL is 4 s; the activity bundle refreshes every 2 s.
  "mail-presence": backend("B09,B10", "interval", "progress", 2_000, "join", "next-tick"),
  "mail-injection": backend(
    "B09,B10",
    "event",
    "progress",
    2_000,
    "trailing-rerun",
    "storage-reconcile",
  ),
  "pending-rename-reconcile": backend(
    "B09",
    "interval",
    "recovery",
    2_000,
    "unguarded",
    "storage-reconcile",
  ),
  // Every 30 activity ticks (nominally 60 s).
  "coordinator-repair": backend("B11", "interval", "recovery", 60_000, "join", "storage-reconcile"),
  "mail-retention": backend("B11", "interval", "maintenance", 60_000, "unguarded", "next-tick"),
  // Lease duration 30 s, swept every 15 s.
  "activity-lease-expiry": backend(
    "B12",
    "interval",
    "critical",
    15_000,
    "unguarded",
    "lease-expiry",
  ),
  "tab-cleanup": backend("B13", "interval", "maintenance", 60_000, "join", "storage-reconcile"),
  "build-supervisor-tick": backend(
    "B14",
    "interval",
    "progress",
    1_500,
    "trailing-rerun",
    "storage-reconcile",
  ),
  "looped-review-tick": backend(
    "B15",
    "interval",
    "progress",
    1_000,
    "trailing-rerun",
    "storage-reconcile",
  ),
  "looped-review-lease-renewal": backend(
    "B15",
    "lease",
    "critical",
    5_000,
    "unguarded",
    "lease-expiry",
  ),
  // Adaptive due scheduler by default (reconcile scan + per-workflow due times);
  // the legacy 1 s tick remains behind `adaptiveScheduling: false`.
  "multi-review-tick": backend(
    "B16",
    "interval",
    "progress",
    1_000,
    "per-key-serial",
    "storage-reconcile",
  ),
  "multi-review-lease-renewal": backend(
    "B16",
    "lease",
    "critical",
    5_000,
    "unguarded",
    "lease-expiry",
  ),
  "feature-planning-tick": backend(
    "B17",
    "interval",
    "progress",
    1_000,
    "trailing-rerun",
    "storage-reconcile",
  ),
  "validation-heartbeat": backend(
    "B20",
    "lease",
    "critical",
    500,
    "unguarded",
    "lease-expiry",
    false,
  ),
  "storage-lock-heartbeat": backend(
    "B21",
    "lease",
    "critical",
    null,
    "unguarded",
    "lease-expiry",
    false,
  ),
  // Demand-driven by clients (title bar 5 s); concurrent reads join.
  "system-usage-sample": backend("C08", "read", "interactive", 5_000, "join", "none"),
  "process-usage": backend("C08", "read", "interactive", 3_000, "unguarded", "none"),
  "opencode-reconnect": backend(
    "B22",
    "event",
    "recovery",
    1_000,
    "unguarded",
    "reconnect-replay",
    false,
  ),
  "gateway-heartbeat": backend(
    "L01",
    "interval",
    "recovery",
    25_000,
    "unguarded",
    "reconnect-replay",
    false,
  ),
  "client-native-session-refresh": external(
    "renderer",
    "C01",
    "interval",
    "interactive",
    500,
    "join",
    "snapshot-rehydrate",
  ),
  "client-files-panel": external(
    "renderer",
    "C02",
    "interval",
    "interactive",
    5_000,
    "skip-while-running",
    "snapshot-rehydrate",
  ),
  "client-resource-manifest": external(
    "renderer",
    "C03",
    "interval",
    "recovery",
    300_000,
    "join",
    "snapshot-rehydrate",
  ),
  "client-reviewer-transcript": external(
    "renderer",
    "C05",
    "interval",
    "interactive",
    4_000,
    "skip-while-running",
    "snapshot-rehydrate",
  ),
  "client-validation-output": external(
    "renderer",
    "C06",
    "completion",
    "interactive",
    2_000,
    "skip-while-running",
    "snapshot-rehydrate",
  ),
  "client-init-logs": external(
    "renderer",
    "C07",
    "interval",
    "interactive",
    1_000,
    "skip-while-running",
    "snapshot-rehydrate",
  ),
  "client-system-meters": external(
    "renderer",
    "C08",
    "interval",
    "interactive",
    5_000,
    "skip-while-running",
    "none",
  ),
  "client-docker-availability": external(
    "renderer",
    "C09",
    "interval",
    "discovery",
    60_000,
    "skip-while-running",
    "snapshot-rehydrate",
  ),
  "client-connection-health": external(
    "renderer",
    "C10",
    "interval",
    "discovery",
    30_000,
    "unguarded",
    "none",
  ),
  "client-coordinator-panel": external(
    "renderer",
    "C11",
    "interval",
    "interactive",
    60_000,
    "unguarded",
    "snapshot-rehydrate",
  ),
  "client-design-canvas": external(
    "renderer",
    "C12",
    "interval",
    "interactive",
    3_000,
    "trailing-rerun",
    "snapshot-rehydrate",
  ),
  "client-browser-annotation": external(
    "renderer",
    "C13",
    "interval",
    "interactive",
    150,
    "skip-while-running",
    "snapshot-rehydrate",
  ),
  "client-cursor-login": external(
    "renderer",
    "C14",
    "interval",
    "interactive",
    1_500,
    "unguarded",
    "snapshot-rehydrate",
  ),
  "bridge-sse-keepalive": external(
    "bridge",
    "L02",
    "interval",
    "recovery",
    5_000,
    "unguarded",
    "reconnect-replay",
  ),
  "bridge-idle-sweep": external(
    "bridge",
    "L03,L04,L05",
    "interval",
    "maintenance",
    60_000,
    "unguarded",
    "next-tick",
  ),
  "bridge-parent-watchdog": external(
    "bridge",
    "L05,L06",
    "interval",
    "critical",
    5_000,
    "unguarded",
    "none",
  ),
  "acp-disconnect-poll": external("bridge", "L07", "interval", "critical", 50, "unguarded", "none"),
  "bridge-diagnostics-heartbeat": external(
    "bridge",
    "L08",
    "interval",
    "maintenance",
    60_000,
    "unguarded",
    "none",
  ),
  "desktop-log-retention": external(
    "desktop",
    "L09",
    "interval",
    "maintenance",
    6 * 60 * 60_000,
    "unguarded",
    "next-tick",
  ),
};

/**
 * Physical work, counted once at the boundary that performs it and attributed
 * to the innermost recurring job that caused it. A command invocation is not a
 * unit: one command can hit a cache, and one refresh can issue several spawns.
 */
export const RECURRING_WORK_UNITS = [
  "git-spawn",
  "gh-spawn",
  "docker-exec",
  "docker-cli",
  "tmux-spawn",
  "process-spawn",
  "directory-walk",
  "directory-read",
  "file-read",
  "provider-request",
  "storage-read",
  "storage-stat",
  "storage-write",
  "record-scanned",
  "record-selected",
] as const;
export type RecurringWorkUnit = (typeof RECURRING_WORK_UNITS)[number];

/**
 * Finite failure categories. Error messages are never recorded: they can echo
 * argv, paths or provider output.
 */
export const RECURRING_ERROR_CATEGORIES = [
  "timeout",
  "unavailable",
  "cancelled",
  "capacity",
  "error",
] as const;
export type RecurringErrorCategory = (typeof RECURRING_ERROR_CATEGORIES)[number];

/** Upper bounds (inclusive, ms) of the fixed duration/queue-delay histogram. */
export const RECURRING_DURATION_BUCKETS_MS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
] as const;

export interface RecurringDurationSummary {
  count: number;
  totalMs: number;
  minMs: number | null;
  maxMs: number | null;
  /**
   * Counts per bucket of {@link RECURRING_DURATION_BUCKETS_MS}, plus one
   * trailing overflow bucket; length is always buckets + 1.
   */
  buckets: number[];
}

export interface RecurringWorkKindSnapshot {
  requested: number;
  coalesced: number;
  started: number;
  completed: number;
  failed: number;
  /** Refused by a scheduler or admission bound; the owner keeps the obligation. */
  rejected: number;
  changed: number;
  unchanged: number;
  cacheHits: number;
  cacheMisses: number;
  active: number;
  /** Age of the longest-running tracked attempt; `null` when none is active. */
  oldestActiveAgeMs: number | null;
  lastSuccessAgeMs: number | null;
  lastFailureAgeMs: number | null;
  bytes: number;
  duration: RecurringDurationSummary;
  queueDelay: RecurringDurationSummary;
  workUnits: Partial<Record<RecurringWorkUnit, number>>;
  errors: Partial<Record<RecurringErrorCategory, number>>;
}

export interface RecurringWorkSnapshot {
  schemaVersion: typeof RECURRING_WORK_SCHEMA_VERSION;
  enabled: boolean;
  /** Milliseconds since the recorder was created or last reset. */
  windowMs: number;
  totals: {
    active: number;
    worstActiveAgeMs: number | null;
    requested: number;
    started: number;
    completed: number;
    failed: number;
    rejected: number;
  };
  /** Only kinds with any recorded activity appear. */
  kinds: Partial<Record<RecurringJobKind, RecurringWorkKindSnapshot>>;
  /** Physical work observed outside any recurring job. */
  unattributed: {
    bytes: number;
    workUnits: Partial<Record<RecurringWorkUnit, number>>;
  };
  /** Labels refused because they were not in the fixed vocabulary. */
  droppedLabels: number;
  /** Attempts started while the active-attempt table was full (age not tracked). */
  untrackedActive: number;
  /** Faults inside the recorder itself; never propagated to observed work. */
  recorderFaults: number;
}

const JOB_KIND_SET: ReadonlySet<string> = new Set(RECURRING_JOB_KINDS);
const WORK_UNIT_SET: ReadonlySet<string> = new Set(RECURRING_WORK_UNITS);
const PRIORITY_SET: ReadonlySet<string> = new Set(RECURRING_PRIORITY_CLASSES);

export function isRecurringJobKind(value: unknown): value is RecurringJobKind {
  return typeof value === "string" && JOB_KIND_SET.has(value);
}

export function isRecurringWorkUnit(value: unknown): value is RecurringWorkUnit {
  return typeof value === "string" && WORK_UNIT_SET.has(value);
}

export function isRecurringPriorityClass(value: unknown): value is RecurringPriorityClass {
  return typeof value === "string" && PRIORITY_SET.has(value);
}

/** Lower is more urgent. */
export function recurringPriorityRank(priority: RecurringPriorityClass): number {
  return RECURRING_PRIORITY_CLASSES.indexOf(priority);
}
