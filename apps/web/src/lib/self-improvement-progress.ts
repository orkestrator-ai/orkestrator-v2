import type {
  SelfImprovementProgress,
  SelfImprovementSkipReason,
  SelfImprovementStage,
  SelfImprovementStageState,
  SelfImprovementStatus,
  SelfImprovementStep,
} from "@orkestrator/protocol/self-improvement";

/** A run's stages as the page names them while they are happening. */
export const STEP_TEXT: Record<SelfImprovementStep, string> = {
  exporting: "Exporting this machine's diagnostics",
  board: "Reading the project's board",
  "reading-conversations": "Reading conversations",
  "grouping-themes": "Grouping notes into themes",
  digesting: "Ranking problems",
  filing: "Updating the board",
};

/** What each stage is for, shown in the progress window. */
export const STEP_PURPOSE: Record<SelfImprovementStep, string> = {
  exporting:
    "Builds this machine's diagnostics in memory: the essential log, the health summary and the database figures, with secrets redacted.",
  board:
    "Reads every ticket it is tracking on the project's board, to see which were finished, reopened or deleted.",
  "reading-conversations":
    "Finds Claude Code and Codex conversations that have gone quiet and have new parts, and has a model note the friction in each part.",
  "grouping-themes":
    "Has a stronger model group the notes from the last 30 days into themes. It only happens when saved notes are waiting to be grouped.",
  digesting:
    "Ranks every signal from the diagnostics and the themes, and judges whether each earlier fix worked.",
  filing:
    "Comments on judged tickets, moves failed fixes back to the backlog and files new tickets within the daily limits.",
};

export const STATE_TEXT: Record<SelfImprovementStageState, string> = {
  pending: "Waiting",
  running: "In progress",
  done: "Done",
  skipped: "Skipped",
};

/** Past this long with no sign of life and no model call to wait on, the run may be stuck. */
export const QUIET_MS = 2 * 60 * 1000;

/**
 * Times in a status come from the backend's clock, which is not always the
 * window's. An age is therefore the gap between two backend timestamps plus the
 * time since this window received the status, and never `Date.now()` minus a
 * backend timestamp.
 */
export interface ProgressClock {
  /** The window's clock now. */
  now: number;
  /** The window's clock when it received the status being shown. */
  receivedAt: number;
}

export function ageMs(
  progress: SelfImprovementProgress,
  iso: string,
  clock: ProgressClock,
): number {
  const observed = Date.parse(progress.observedAt);
  const at = Date.parse(iso);
  if (!Number.isFinite(observed) || !Number.isFinite(at)) return 0;
  return Math.max(0, observed - at + (clock.now - clock.receivedAt));
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return "under a second";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

export type Liveness = { tone: "active" | "waiting" | "quiet"; text: string };

/** Whether the run is moving: a recent sign of life, a model call to wait on, or neither. */
export function liveness(progress: SelfImprovementProgress, clock: ProgressClock): Liveness {
  const { inFlight, oldestStartedAt, timeoutMs } = progress.modelCalls;
  if (inFlight > 0 && oldestStartedAt) {
    const calls = inFlight === 1 ? "a model call" : `${inFlight} model calls`;
    return {
      tone: "waiting",
      text: `Waiting on ${calls}, the longest for ${formatDuration(ageMs(progress, oldestStartedAt, clock))}. A call is given up after ${Math.round(timeoutMs / 60_000)} minutes.`,
    };
  }
  const quiet = ageMs(progress, progress.lastActivityAt, clock);
  if (quiet > QUIET_MS) {
    return {
      tone: "quiet",
      text: `Nothing has happened for ${formatDuration(quiet)}. It may be stuck.`,
    };
  }
  return {
    tone: "active",
    text:
      quiet < 3000
        ? "Moving: something happened just now."
        : `Moving: last activity ${formatDuration(quiet)} ago.`,
  };
}

/** Why a stage was skipped, as the run recorded it when it skipped it. */
export const SKIP_TEXT: Record<SelfImprovementSkipReason, string> = {
  "review-off": "The conversation review is off.",
  preview: "A preview files nothing.",
  "no-notes": "No saved notes needed grouping.",
  "not-needed": "Not needed.",
};

export interface StageContext {
  dryRun: boolean;
  models: SelfImprovementStatus["models"];
  modelName(id: string): string;
}

const count = (value: number) => value.toLocaleString();
const plural = (value: number, word: string) => `${count(value)} ${word}${value === 1 ? "" : "s"}`;

/** One line on where a stage stands, or null when there is nothing to add to its state. */
export function stageSummary(
  stage: SelfImprovementStage,
  progress: SelfImprovementProgress,
  context: StageContext,
): string | null {
  // The run's own reason, never today's settings: the review switch can change
  // while a run that started with the other value is still working.
  if (stage.state === "skipped") return SKIP_TEXT[stage.skipReason ?? "not-needed"];
  if (stage.state === "pending") return null;
  if (stage.step === "reading-conversations") {
    const review = progress.conversations;
    if (!review) return null;
    if (review.parts === null) {
      return review.files === null
        ? "Looking for conversation history…"
        : `Checking history files: ${count(review.filesChecked)} of ${count(review.files)}`;
    }
    // A preview lists the parts it would read but calls no model, so none is read.
    if (context.dryRun) return `${plural(review.parts, "part")} to read; a preview reads none`;
    const read = `Read ${count(review.read)} of ${plural(review.parts, "part")}`;
    return review.failed > 0 ? `${read}, ${count(review.failed)} failed` : read;
  }
  if (stage.step === "grouping-themes" && stage.state === "running") {
    return `${context.modelName(context.models.themes)} is grouping the notes`;
  }
  return null;
}

/** Extra lines for the progress window: figures that do not fit the row. */
export function stageFigures(
  stage: SelfImprovementStage,
  progress: SelfImprovementProgress,
  options: { dryRun?: boolean } = {},
): string[] {
  const review = progress.conversations;
  if (stage.step !== "reading-conversations" || !review || stage.state === "pending") return [];
  const lines: string[] = [];
  if (review.files !== null) {
    lines.push(`${plural(review.filesChecked, "history file")} checked of ${count(review.files)}`);
  }
  if (review.parts !== null && options.dryRun) {
    lines.push("A preview calls no model, so no notes are taken");
    if (review.waiting > 0) {
      lines.push(`${plural(review.waiting, "more part")} would wait for the next run`);
    }
  } else if (review.parts !== null) {
    lines.push(
      `${plural(review.notesAdded, "note")} found so far${review.read === 0 ? "" : ` in ${plural(review.read, "part")}`}`,
    );
    if (review.failed > 0) {
      lines.push(`${plural(review.failed, "part")} failed; they are read again next run`);
    }
    if (review.waiting > 0) {
      lines.push(`${plural(review.waiting, "more part")} waiting for the next run`);
    }
  }
  return lines;
}
