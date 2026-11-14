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
