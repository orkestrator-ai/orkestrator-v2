import type { StorageMigration } from "./database.js";
import { isRecord } from "./shared.js";

/**
 * The one-way move of build pipeline package preparation off the Rework phase
 * (to-do 4740, task 4).
 *
 * Builds before this one ran the dedicated review-package preparation session
 * as a Rework session (`phase: "rework"`, labelled "Package Preparation
 * Session", `REVIEW_PACKAGE_SESSION_LABEL`) and kept the pipeline `reworking` while
 * it and the validation run it planned were in progress; a validation run
 * restarted in the first round could also be left `building`. This build
 * stores that session as `package-preparation` and the pipeline as
 * `preparing-package`, and reads only those, so every record an older build
 * wrote is rewritten once here. The schema bump is the downgrade fence.
 *
 * What moves, per `build-pipelines` snapshot:
 *
 * - every session with that label and phase `rework` becomes `package-preparation`, and so do the `rework` entries of
 *   its interaction transcript and a pending interaction resolution for it;
 * - while preparation is the step the pipeline is on, the pipeline phase
 *   fields that say `reworking` or `building` become `preparing-package`:
 *   `phase`, `pausedFromPhase`, and the `phase` of `failureContext`,
 *   `reconnectAttempt`, `pendingPromptAttempt` (and its background message
 *   context) and `activePromptContext`. Preparation is the step when the
 *   current session is a live (not superseded) preparation session, or when a
 *   validation run is held without a review package, which is exactly when
 *   the former `reviewValidationStage` reported validation or preparation.
 *
 * Left as written: session keys (transcript paths hash them and worker mail
 * tab ids derive from them), restart and skip requests and rewinds (a
 * preparation restart was always stored as `review-package`, never as a Rework
 * session restart, and a rewind's `fromPhase` is history), and key information
 * authors, which do not say which session wrote them.
 */

/** The label older builds gave the session; fixed here so a later rename cannot change what moves. */
const FORMER_PREPARATION_LABEL = "Package Preparation Session";
const PREPARING_PACKAGE = "preparing-package";
const PACKAGE_PREPARATION = "package-preparation";
/** The pipeline phases preparation could be stored under. */
const FORMER_PREPARATION_PHASES: ReadonlySet<unknown> = new Set(["reworking", "building"]);

function isFormerPreparationSession(session: unknown): session is Record<string, unknown> {
  return (
    isRecord(session) && session.label === FORMER_PREPARATION_LABEL && session.phase === "rework"
  );
}

/** The session with its own and its interaction transcript's phase moved. */
function upgradeSession(session: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...session, phase: PACKAGE_PREPARATION };
  if (Array.isArray(session.interactionTranscript)) {
    next.interactionTranscript = session.interactionTranscript.map((entry: unknown) =>
      isRecord(entry) && entry.phase === "rework"
        ? { ...entry, phase: PACKAGE_PREPARATION }
        : entry,
    );
  }
  return next;
}

/** `holder` with its `phase` moved, or the same reference when it does not apply. */
function withPreparingPhase(holder: unknown): unknown {
  if (!isRecord(holder) || !FORMER_PREPARATION_PHASES.has(holder.phase)) return holder;
  return { ...holder, phase: PREPARING_PACKAGE };
}

/** A build pipeline snapshot with package preparation in its own phase. */
export function upgradePackagePreparationPhase(snapshot: unknown): unknown {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions)) return snapshot;
  const sessions: unknown[] = snapshot.sessions;
  const index = snapshot.currentSessionIndex;
  const current = typeof index === "number" ? sessions[index] : undefined;
  const preparing =
    (isFormerPreparationSession(current) && current.supersededBy === undefined) ||
    (isRecord(snapshot.validationRun) && !snapshot.reviewPackage);

  let changed = false;
  const preparationKeys = new Set<unknown>();
  const upgradedSessions = sessions.map((session) => {
    if (!isFormerPreparationSession(session)) return session;
    changed = true;
    preparationKeys.add(session.sessionKey);
    return upgradeSession(session);
  });
  const next: Record<string, unknown> = { ...snapshot, sessions: upgradedSessions };

  const resolution = snapshot.pendingInteractionResolution;
  if (
    isRecord(resolution) &&
    resolution.phase === "rework" &&
    preparationKeys.has(resolution.sessionKey)
  ) {
    next.pendingInteractionResolution = { ...resolution, phase: PACKAGE_PREPARATION };
    changed = true;
  }

  if (preparing) {
    for (const field of ["phase", "pausedFromPhase"] as const) {
      if (FORMER_PREPARATION_PHASES.has(snapshot[field])) {
        next[field] = PREPARING_PACKAGE;
        changed = true;
      }
    }
    for (const field of [
      "failureContext",
      "reconnectAttempt",
      "pendingPromptAttempt",
      "activePromptContext",
    ] as const) {
      const upgraded = withPreparingPhase(snapshot[field]);
      if (upgraded === snapshot[field]) continue;
      next[field] = upgraded;
      changed = true;
    }
    const attempt = next.pendingPromptAttempt;
    if (isRecord(attempt) && isRecord(attempt.backgroundMessage)) {
      const context = withPreparingPhase(attempt.backgroundMessage.context);
      if (context !== attempt.backgroundMessage.context) {
        next.pendingPromptAttempt = {
          ...attempt,
          backgroundMessage: { ...attempt.backgroundMessage, context },
        };
        changed = true;
      }
    }
  }

  return changed ? next : snapshot;
}

/** The `build-pipelines` store (`id → { snapshot, … }`) with every snapshot upgraded. */
export function upgradeBuildPipelinePackagePreparation(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  let changed = false;
  const upgraded: Record<string, unknown> = {};
  for (const [key, record] of Object.entries(stored)) {
    upgraded[key] = record;
    if (!isRecord(record)) continue;
    const snapshot = upgradePackagePreparationPhase(record.snapshot);
    if (snapshot === record.snapshot) continue;
    upgraded[key] = { ...record, snapshot };
    changed = true;
  }
  return changed ? upgraded : stored;
}

export const PACKAGE_PREPARATION_PHASE_UPGRADE_VERSION = 12;

export const packagePreparationPhaseUpgradeMigration: StorageMigration = {
  version: PACKAGE_PREPARATION_PHASE_UPGRADE_VERSION,
  name: "package-preparation-phase",
  up({ database }) {
    // Absent or unreadable: nothing an older build wrote is left to upgrade.
    const pipelines = database.readStoreValueInTransaction("build-pipelines");
    if (!pipelines) return;
    const next = upgradeBuildPipelinePackagePreparation(pipelines.value);
    if (next !== pipelines.value) database.writeStoreInTransaction("build-pipelines", next);
  },
};
