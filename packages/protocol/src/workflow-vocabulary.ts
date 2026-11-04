/**
 * The stored and transmitted names of the Rework and Address Findings steps.
 *
 * People and agents read "Rework" (Verify found the ticket unmet) and "Address
 * Findings" (review reported findings). The values that are stored and sent
 * between versions still use the older names, `fix` and `address`, because an
 * older client refuses a snapshot holding a value or field it does not know and
 * there is no version handshake to tell it apart.
 *
 * So the change lands in two stages. This build reads both vocabularies and
 * writes the older one. A later build writes the new one, and this file is what
 * lets a client or machine still on this build understand it. The maps below
 * read new name → current name; docs/todo/cross-cutting/4740 tracks the flip.
 *
 * "fix" means different things in the two workflows: Rework in a build pipeline,
 * Address Findings in a Multi Review. Each therefore has its own map.
 */

interface WorkflowRenames {
  /** Field names, at any depth of a snapshot or request. */
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
  "addressReportKind",
]);

/** User and report text. Nothing inside these is vocabulary, so they are not walked. */
const OPAQUE_FIELDS: ReadonlySet<string> = new Set([
  "taskSnapshot",
  "structuredReview",
  "consolidatedReport",
  "reviewPackage",
  "instruction",
  "instructions",
]);

export const BUILD_PIPELINE_RENAMES: WorkflowRenames = Object.freeze({
  keys: Object.freeze({
    "address-findings": "address",
    addressFindingsResult: "fixResult",
    addressFindingsReportKind: "addressReportKind",
    reworkWorktreeFingerprintAtStart: "fixWorktreeFingerprintAtStart",
  }),
  values: Object.freeze({
    reworking: "fixing",
    "preparing-package": "fixing",
    "addressing-findings": "addressing",
    rework: "fix",
    "package-preparation": "fix",
    "address-findings": "address",
    "address-findings-result": "fix-result",
  }),
});

export const MULTI_REVIEW_RENAMES: WorkflowRenames = Object.freeze({
  keys: Object.freeze({
    "address-findings": "fix",
    addressFindingsModel: "fixModel",
    addressFindingsSessionKey: "fixSessionKey",
    addressFindingsSession: "fixSession",
    addressFindingsResult: "fixResult",
    addressFindingsIdentity: "fixIdentity",
    addressFindingsTabId: "fixTabId",
    addressFindingsLaunch: "fixLaunch",
    autoAddressFindings: "autoFix",
    customAddressFindingsInstruction: "customFixInstruction",
    customAddressFindingsModel: "customFixModel",
    restartAddressFindingsAfterConsolidation: "restartFixAfterConsolidation",
  }),
  values: Object.freeze({
    "addressing-findings": "fixing",
    "address-findings": "fix",
  }),
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the same reference when nothing changed, so a current snapshot costs no copy. */
function canonicalize(value: unknown, renames: WorkflowRenames): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const canonical = canonicalize(entry, renames);
      if (canonical !== entry) changed = true;
      return canonical;
    });
    return changed ? next : value;
  }
  if (!isPlainRecord(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const canonicalKey = Object.hasOwn(renames.keys, key) ? renames.keys[key]! : key;
    let canonicalEntry = entry;
    if (OPAQUE_FIELDS.has(canonicalKey)) {
      canonicalEntry = entry;
    } else if (typeof entry === "string") {
      if (VALUE_FIELDS.has(canonicalKey) && Object.hasOwn(renames.values, entry)) {
        canonicalEntry = renames.values[entry];
      }
    } else {
      canonicalEntry = canonicalize(entry, renames);
    }
    if (canonicalKey !== key || canonicalEntry !== entry) changed = true;
    next[canonicalKey] = canonicalEntry;
  }
  return changed ? next : value;
}

/** A build pipeline snapshot or start request in this build's stored names. */
export function canonicalBuildPipeline<T>(value: T): T {
  return canonicalize(value, BUILD_PIPELINE_RENAMES) as T;
}

/** A Multi Review snapshot or start request in this build's stored names. */
export function canonicalMultiReview<T>(value: T): T {
  return canonicalize(value, MULTI_REVIEW_RENAMES) as T;
}
