import type { StorageMigration } from "./storage-database.js";
import { isRecord } from "./storage-shared.js";

/**
 * The one-way rewrite of stored build pipelines and Multi Reviews from the
 * former step names to the Rework and Address Findings names (to-do 4740,
 * task 1).
 *
 * Builds before this one stored and sent `fix`, `fixing`, `address`,
 * `addressing`, `fixModel`, `fixSession`, `autoFix` and the rest. This build
 * reads and writes only the new names, so every record an older build wrote
 * is rewritten once here, and the schema bump is the downgrade fence: an
 * older backend refuses the newer database rather than misreading it.
 *
 * "fix" means different things in the two workflows: Rework in a build
 * pipeline, Address Findings in a Multi Review. Each therefore has its own
 * map. The review-package preparation session was stored as Rework (`fix`,
 * `fixing`) and moves to Rework here; the next migration
 * (`storage-package-preparation-phase-upgrade.ts`) gives it its own phase.
 *
 * Session keys are left exactly as they were: transcript paths are a hash of
 * the key and worker mail tab ids derive from it, so rewriting one would
 * orphan its transcripts. Only keys created from now on carry the new word.
 */

interface WorkflowRenames {
  /** Field names, at any depth of a snapshot. */
  keys: Readonly<Record<string, string>>;
  /** Values, only where they sit in one of {@link VALUE_FIELDS}. */
  values: Readonly<Record<string, string>>;
}

/** The only fields whose string values are renamed. Free text is never touched. */
const VALUE_FIELDS: ReadonlySet<string> = new Set([
  "phase",
  "pausedFromPhase",
  "fromPhase",
  "implementationPhase",
  "buildPhase",
  "workflowPhase",
  "pausedStep",
  "openedFor",
  "kind",
  "step",
  "author",
  "addressFindingsReportKind",
]);

/**
 * User and report text, and the session keys. Nothing inside these is
 * vocabulary, so they are not walked.
 */
const OPAQUE_FIELDS: ReadonlySet<string> = new Set([
  "taskSnapshot",
  "structuredReview",
  "consolidatedReport",
  "reviewPackage",
  "reviewReport",
  "roundReviewReports",
  "interactionTranscript",
  "instruction",
  "instructions",
  "sessionKey",
  "addressFindingsSessionKey",
]);

/** Former build pipeline name → current name. */
export const FORMER_BUILD_PIPELINE_NAMES: WorkflowRenames = Object.freeze({
  keys: Object.freeze({
    address: "address-findings",
    fixResult: "addressFindingsResult",
    addressReportKind: "addressFindingsReportKind",
    fixWorktreeFingerprintAtStart: "reworkWorktreeFingerprintAtStart",
  }),
  values: Object.freeze({
    fixing: "reworking",
    addressing: "addressing-findings",
    fix: "rework",
    address: "address-findings",
    "fix-result": "address-findings-result",
  }),
});

/** Former Multi Review name → current name. */
export const FORMER_MULTI_REVIEW_NAMES: WorkflowRenames = Object.freeze({
  keys: Object.freeze({
    fix: "address-findings",
    fixModel: "addressFindingsModel",
    fixSessionKey: "addressFindingsSessionKey",
    fixSession: "addressFindingsSession",
    fixResult: "addressFindingsResult",
    fixIdentity: "addressFindingsIdentity",
    fixTabId: "addressFindingsTabId",
    fixLaunch: "addressFindingsLaunch",
    autoFix: "autoAddressFindings",
    customFixInstruction: "customAddressFindingsInstruction",
    customFixModel: "customAddressFindingsModel",
    restartFixAfterConsolidation: "restartAddressFindingsAfterConsolidation",
  }),
  values: Object.freeze({
    fixing: "addressing-findings",
    fix: "address-findings",
  }),
});

/** Returns the same reference when nothing changed, so a current record costs no copy. */
function rename(value: unknown, renames: WorkflowRenames): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const renamed = rename(entry, renames);
      if (renamed !== entry) changed = true;
      return renamed;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const renamedKey = Object.hasOwn(renames.keys, key) ? renames.keys[key]! : key;
    let renamedEntry = entry;
    if (OPAQUE_FIELDS.has(renamedKey)) {
      renamedEntry = entry;
    } else if (typeof entry === "string") {
      if (VALUE_FIELDS.has(renamedKey) && Object.hasOwn(renames.values, entry)) {
        renamedEntry = renames.values[entry];
      }
    } else {
      renamedEntry = rename(entry, renames);
    }
    // A record already holding both names keeps the current one.
    if (renamedKey !== key && Object.hasOwn(value, renamedKey)) {
      changed = true;
      continue;
    }
    if (renamedKey !== key || renamedEntry !== entry) changed = true;
    next[renamedKey] = renamedEntry;
  }
  return changed ? next : value;
}

/** A build pipeline snapshot in the current names. */
export function renameFormerBuildPipelineNames(snapshot: unknown): unknown {
  return rename(snapshot, FORMER_BUILD_PIPELINE_NAMES);
}

/** A Multi Review snapshot in the current names. */
export function renameFormerMultiReviewNames(snapshot: unknown): unknown {
  return rename(snapshot, FORMER_MULTI_REVIEW_NAMES);
}

/** A record store (`id → { snapshot, … }`) with every snapshot renamed. */
function upgradeSnapshots(stored: unknown, upgrade: (snapshot: unknown) => unknown): unknown {
  if (!isRecord(stored)) return stored;
  let changed = false;
  const upgraded: Record<string, unknown> = {};
  for (const [key, record] of Object.entries(stored)) {
    upgraded[key] = record;
    if (!isRecord(record)) continue;
    const snapshot = upgrade(record.snapshot);
    if (snapshot === record.snapshot) continue;
    upgraded[key] = { ...record, snapshot };
    changed = true;
  }
  return changed ? upgraded : stored;
}

/** The `build-pipelines` store in the current names. */
export function upgradeBuildPipelineVocabulary(stored: unknown): unknown {
  return upgradeSnapshots(stored, renameFormerBuildPipelineNames);
}

/** The `multi-reviews` store in the current names. */
export function upgradeMultiReviewVocabulary(stored: unknown): unknown {
  return upgradeSnapshots(stored, renameFormerMultiReviewNames);
}

export const WORKFLOW_VOCABULARY_UPGRADE_VERSION = 11;

export const workflowVocabularyUpgradeMigration: StorageMigration = {
  version: WORKFLOW_VOCABULARY_UPGRADE_VERSION,
  name: "rename-workflow-vocabulary",
  up({ database }) {
    // Absent or unreadable: nothing an older build wrote is left to upgrade.
    const pipelines = database.readStoreValueInTransaction("build-pipelines");
    if (pipelines) {
      const next = upgradeBuildPipelineVocabulary(pipelines.value);
      if (next !== pipelines.value) database.writeStoreInTransaction("build-pipelines", next);
    }
    const reviews = database.readStoreValueInTransaction("multi-reviews");
    if (reviews) {
      const next = upgradeMultiReviewVocabulary(reviews.value);
      if (next !== reviews.value) database.writeStoreInTransaction("multi-reviews", next);
    }
  },
};
