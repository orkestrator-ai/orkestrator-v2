/**
 * Self-improvement: the backend reads this machine's own behaviour (the
 * diagnostics bundle) and, optionally, the person's conversations with agents,
 * files what it finds as Kanban tickets, and checks each fix on the app
 * versions that carry it. Experimental and off by default
 * (`global.experimentalSelfImprovement`); see
 * `docs/architecture/self-improvement.md`.
 *
 * Browser-safe: the settings and status shapes the backend and the renderer
 * share. Status holds signatures, numbers, titles, ticket ids and short
 * paraphrases, never transcripts.
 */

/** `global.selfImprovement`. Every field is optional; see {@link resolveSelfImprovementSettings}. */
export interface SelfImprovementSettings {
  /** The project whose board receives tickets. Required before a run. */
  projectId?: string;
  /** Read conversations with a model. Default on. */
  conversationReview?: boolean;
  /** Run once a day on its own while the app is running. Default off. */
  dailyRun?: boolean;
}

export interface ResolvedSelfImprovementSettings {
  projectId: string | null;
  conversationReview: boolean;
  dailyRun: boolean;
}

export function resolveSelfImprovementSettings(
  value: SelfImprovementSettings | undefined | null,
): ResolvedSelfImprovementSettings {
  return {
    projectId: typeof value?.projectId === "string" && value.projectId ? value.projectId : null,
    conversationReview: value?.conversationReview !== false,
    dailyRun: value?.dailyRun === true,
  };
}

/** Models the conversation review uses, through Claude Code on the signed-in account. */
export const SELF_IMPROVEMENT_MODELS = {
  notes: "claude-sonnet-5-5",
  themes: "claude-opus-5-5",
} as const;

export const SELF_IMPROVEMENT_LIMITS = {
  /** New diagnostics tickets in any 24 hours. */
  diagnosticsTicketsPerDay: 3,
  /** New insight tickets in any 24 hours. */
  insightTicketsPerDay: 2,
  /** Conversation parts read in one run. */
  conversationPartsPerRun: 30,
} as const;

/** What a run is doing right now, for the progress line. */
export type SelfImprovementStep =
  "exporting" | "board" | "reading-conversations" | "grouping-themes" | "digesting" | "filing";

/** Every step in the order a run takes them; `SelfImprovementProgress.stages` lists them this way. */
export const SELF_IMPROVEMENT_STEPS: readonly SelfImprovementStep[] = [
  "exporting",
  "board",
  "reading-conversations",
  "grouping-themes",
  "digesting",
  "filing",
];

/**
 * `skipped`: the run will not (or did not) do this stage: the conversation
 * review is off, a preview files nothing, or there were no saved notes to group.
 */
export type SelfImprovementStageState = "pending" | "running" | "done" | "skipped";

/**
 * Why a stage was skipped, decided by the run itself: `review-off` and
 * `preview` from the plan fixed when the run started (a setting changed
 * mid-run does not alter them), `no-notes` when grouping had no saved notes to
 * group, `not-needed` for any other stage the run passed without doing.
 */
export type SelfImprovementSkipReason = "review-off" | "preview" | "no-notes" | "not-needed";

export interface SelfImprovementStage {
  step: SelfImprovementStep;
  state: SelfImprovementStageState;
  /** Set whenever `state` is `skipped`. */
  skipReason?: SelfImprovementSkipReason;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Whether a run is moving, for a page that otherwise could only say "running".
 * Numbers and timestamps only, never what was read. Absent from a backend that
 * predates it.
 */
export interface SelfImprovementProgress {
  stages: SelfImprovementStage[];
  /**
   * The backend's clock when this was read. Every other time here is the
   * backend's too, so a window measures an age from the gap between two of them
   * rather than trusting its own clock.
   */
  observedAt: string;
  /** The last time the run did anything observable: a step began, a file was checked, a part was read, a model call started or ended. */
  lastActivityAt: string;
  /** Present once the conversation review has begun. */
  conversations?: {
    /** History files checked for new parts so far. */
    filesChecked: number;
    /** History files to check, once they have been listed. */
    files: number | null;
    /** Parts this run will read; null until the files have been checked. */
    parts: number | null;
    read: number;
    failed: number;
    notesAdded: number;
    /** Parts ready to read but over this run's limit. */
    waiting: number;
  };
  /** Model calls running now, and how long one may run before it is given up. */
  modelCalls: { inFlight: number; oldestStartedAt: string | null; timeoutMs: number };
}

export type SelfImprovementRunTrigger = "manual" | "daily" | "dry-run";

export interface SelfImprovementRunSummary {
  digestId: string;
  trigger: SelfImprovementRunTrigger;
  startedAt: string;
  finishedAt: string;
  outcome: "succeeded" | "failed";
  /** A fixed, content-free reason when the run failed. */
  error?: string;
  created: Array<{ ticket: string; signature: string; title: string }>;
  linked: Array<{ ticket: string; signature: string }>;
  verified: Array<{ ticket: string; signature: string }>;
  fixFailed: Array<{ ticket: string; signature: string; verdict: string }>;
  partly: Array<{ ticket: string; signature: string }>;
  markedFixed: Array<{ ticket: string; signature: string }>;
  reopenedFromBoard: Array<{ ticket: string; signature: string }>;
  ignoredDeleted: Array<{ ticket: string; signature: string }>;
  wouldCreate: Array<{ signature: string; title: string }>;
  heldForTomorrow: number;
  belowBar: number;
  conversations: {
    enabled: boolean;
    read: number;
    waiting: number;
    notesAdded: number;
    themes: number;
    costUsd: number;
    heldForTomorrow: number;
    /** Problems the review met (Claude Code missing, a call failed). */
    errors: string[];
  };
}

export type SelfImprovementLedgerStatus = "tracking" | "fixed" | "verified" | "ignored";

export interface SelfImprovementTrackedItem {
  signature: string;
  title: string;
  kind: "insight" | "diagnostics";
  status: SelfImprovementLedgerStatus;
  ticket: string | null;
  /**
   * The project whose board holds `ticket`, which is not always the project
   * that receives new tickets now. Absent for an entry saved before it was
   * recorded.
   */
  projectId?: string;
  /** The newest verdict, such as `awaiting-deploy` or `improved`. */
  verdict: string | null;
  baseline: number | null;
  unit: string;
  updatedAt: string;
}

export interface SelfImprovementTheme {
  slug: string;
  title: string;
  kind: string;
  fixWhere: "orkestrator" | "instructions" | "provider" | "unclear";
  summary: string;
  conversations: number;
  severity: number;
  updatedAt: string;
}

export interface SelfImprovementStatus {
  /** `global.experimentalSelfImprovement`. */
  enabled: boolean;
  settings: ResolvedSelfImprovementSettings;
  /** The project tickets go to, when it still exists. */
  project: { id: string; name: string } | null;
  running: {
    trigger: SelfImprovementRunTrigger;
    startedAt: string;
    step: SelfImprovementStep;
    /** Where the run is and whether it is moving; absent from an older backend. */
    progress?: SelfImprovementProgress;
  } | null;
  lastRun: SelfImprovementRunSummary | null;
  /** When the daily run is next due, if it is on. */
  nextDailyRunAt: string | null;
  tracked: SelfImprovementTrackedItem[];
  themes: SelfImprovementTheme[];
  models: typeof SELF_IMPROVEMENT_MODELS;
  limits: typeof SELF_IMPROVEMENT_LIMITS;
}

/**
 * Refusals a run start can answer with, as stable codes the renderer explains.
 * `not-writer`: another backend holds this data directory's writer lease, so
 * runs (which write the shared ledger and file tickets) happen there.
 */
export type SelfImprovementRunRefusal =
  "disabled" | "no-project" | "already-running" | "not-writer";

export interface SelfImprovementRunStart {
  started: boolean;
  refusal?: SelfImprovementRunRefusal;
  status: SelfImprovementStatus;
}
