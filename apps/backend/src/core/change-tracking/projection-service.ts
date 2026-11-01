/**
 * ChangeProjectionService: the server-prepared view of one change resource.
 *
 * Every presentation decision lives here — badge visibility and mode,
 * whether a file changed (nullable when unknown), label and provenance keys,
 * reason keys, the presentation-priority state and which actions are
 * available. Clients render the result; they never derive any of it from the
 * numbers.
 *
 * File pages are pinned to a snapshot token (measurement + presentation
 * revision). A cursor from another revision is answered `stale-cursor`, so a
 * client can never stitch page one of an old view to page two of a new one.
 */

import {
  CHANGE_PROJECTION_SCHEMA_VERSION,
  parseChangeResourceKey,
  type ChangeAction,
  type ChangeFileRow,
  type ChangeProjection,
  type ChangeProjectionFreshness,
  type ChangesGetFilesResult,
} from "@orkestrator/protocol/change-resources";
import {
  unknownCount,
  type ChangeMeasurement,
  type CountQuality,
  type LineCount,
} from "@orkestrator/protocol/change-measurements";
import { displayPath } from "./capture.js";
import type { ChangeLedger } from "./change-ledger.js";

export const FILE_PAGE_MAX_ROWS = 200;
export const FILE_PAGE_MAX_BYTES = 256 * 1024;

export interface ResourceFreshness {
  observationState: ChangeProjection["observationState"];
  /** Start of the pass behind `lastSuccessfulCheckAt` (refresh fences). */
  checkStartedAt?: string | null;
  freshness: ChangeProjectionFreshness;
  /** The live view is stale (last attempt failed) or the resource is gone. */
  stale?: boolean;
  deleted?: boolean;
  unavailableReason?: string | null;
}

export interface ProjectionPolicy {
  restoreEnabled: boolean;
}

const EMPTY_FRESHNESS: ChangeProjectionFreshness = {
  lastAttemptAt: null,
  lastSuccessfulCheckAt: null,
  lastContentChangeObservedAt: null,
  observedAt: null,
  requiredObservationEpoch: null,
  checkedObservationEpoch: null,
};

function lineCount(value: number | null, quality: string): LineCount {
  const q = quality as CountQuality;
  if (value === null)
    return q === "not-applicable" ? { value: null, quality: q, bound: "none" } : unknownCount();
  if (q === "complete") return { value, quality: "complete", bound: "exact" };
  return {
    value,
    quality: q === "unknown" || q === "not-applicable" ? "partial" : q,
    bound: "none",
  };
}

/** Provenance label for a measurement; clients localize the key. */
export function provenanceKey(measurement: ChangeMeasurement): string {
  if (measurement.origin === "legacy-import") return "changes.provenance.legacy";
  if (measurement.origin === "content-only") return "changes.provenance.content-only";
  switch (measurement.effectClaim) {
    case "workspace-observed":
      return measurement.boundary.before === "fresh-before"
        ? "changes.provenance.observed-fresh"
        : measurement.boundary.before === "prior-observation" ||
            measurement.boundary.before === "late-start"
          ? "changes.provenance.observed-after-start"
          : "changes.provenance.observed";
    case "provider-reported":
      return "changes.provenance.provider-reported";
    case "proposal":
      return "changes.provenance.proposal";
    default:
      return "changes.provenance.unknown";
  }
}

function reasonKeys(measurement: ChangeMeasurement): string[] {
  const keys = new Set(
    measurement.completeness.reasons.map((reason) => `changes.reason.${reason}`),
  );
  if (measurement.attribution.overlap === "known-overlap") keys.add("changes.reason.known-overlap");
  if (measurement.consistency === "changed-during-capture")
    keys.add("changes.reason.changed-during-capture");
  if (measurement.finality === "provisional") keys.add("changes.reason.provisional");
  if (measurement.finality === "interrupted") keys.add("changes.reason.interrupted");
  if (measurement.execution === "failed" && measurement.effectClaim === "workspace-observed") {
    keys.add("changes.reason.failed-with-effect");
  }
  return [...keys].slice(0, 16);
}

/** Badge and presence decisions, from the measurement's own qualities. */
export function presentationOf(measurement: ChangeMeasurement): {
  hasFileChanges: boolean | null;
  hasTextChanges: boolean | null;
  badge: ChangeProjection["badge"];
} {
  const { additions, deletions, changedFiles } = measurement.totals;
  const complete = measurement.completeness.files === "complete";
  const hasFileChanges =
    changedFiles === null ? null : changedFiles > 0 ? true : complete ? false : null;
  const known = (count: LineCount) => count.value !== null;
  const positive = (count: LineCount) => (count.value ?? 0) > 0;
  const hasTextChanges =
    positive(additions) || positive(deletions)
      ? true
      : additions.quality === "complete" && deletions.quality === "complete"
        ? false
        : null;
  let mode: ChangeProjection["badge"]["mode"];
  if (hasFileChanges === false && hasTextChanges !== true) mode = "none";
  else if (known(additions) || known(deletions)) {
    mode = hasTextChanges === false ? (hasFileChanges ? "files-only" : "none") : "counts";
  } else mode = hasFileChanges ? "files-only" : "unknown";
  return { hasFileChanges, hasTextChanges, badge: { visible: mode !== "none", mode } };
}

function encodeCursor(token: string, offset: number): string {
  return Buffer.from(JSON.stringify({ token, offset })).toString("base64url");
}

function decodeCursor(cursor: string): { token: string; offset: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      token?: unknown;
      offset?: unknown;
    };
    if (
      typeof parsed.token !== "string" ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      return null;
    }
    return { token: parsed.token, offset: parsed.offset as number };
  } catch {
    return null;
  }
}

export class ChangeProjectionService {
  private readonly revisions = new Map<string, number>();
  private readonly freshness = new Map<string, ResourceFreshness>();

  constructor(
    private readonly ledger: ChangeLedger,
    readonly ownerGeneration: string,
    private readonly policy: ProjectionPolicy = { restoreEnabled: true },
  ) {}

  /** Advance the presentation revision of a resource (measurement or freshness change). */
  bump(resourceKey: string): number {
    const next = (this.revisions.get(resourceKey) ?? 0) + 1;
    this.revisions.set(resourceKey, next);
    return next;
  }

  revision(resourceKey: string): number {
    return this.revisions.get(resourceKey) ?? 0;
  }

  setFreshness(resourceKey: string, freshness: ResourceFreshness): void {
    this.freshness.set(resourceKey, freshness);
  }

  getFreshness(resourceKey: string): ResourceFreshness | null {
    return this.freshness.get(resourceKey) ?? null;
  }

  forget(resourceKey: string): void {
    this.freshness.delete(resourceKey);
  }

  selectedMeasurement(resourceKey: string): ChangeMeasurement | null {
    const selection = this.ledger.selection(resourceKey);
    return selection?.measurement_id ? this.ledger.measurement(selection.measurement_id) : null;
  }

  private snapshotToken(resourceKey: string, measurementId: string | null): string {
    return `${this.ownerGeneration}:${this.revision(resourceKey)}:${measurementId ?? "none"}`;
  }

  /** Build the current projection; `pageSize` 0 omits the file page. */
  project(resourceKey: string, pageSize = FILE_PAGE_MAX_ROWS): ChangeProjection | null {
    const parts = parseChangeResourceKey(resourceKey);
    if (!parts) return null;
    if (this.revision(resourceKey) === 0) this.bump(resourceKey);
    const freshness = this.freshness.get(resourceKey);
    const measurement = this.selectedMeasurement(resourceKey);
    const base = {
      schemaVersion: CHANGE_PROJECTION_SCHEMA_VERSION,
      resourceKey,
      ownerGeneration: this.ownerGeneration,
      revision: this.revision(resourceKey),
      labelKey: `changes.scope.${parts.scope}`,
      labelArgs: {},
      freshness: freshness?.freshness ?? EMPTY_FRESHNESS,
    };
    if (freshness?.deleted) {
      return {
        ...base,
        measurementId: null,
        state: "deleted",
        availability: "deleted",
        observationState: "unknown",
        coverageState: "unknown",
        hasFileChanges: null,
        hasTextChanges: null,
        badge: { visible: false, mode: "none" },
        counters: { additions: unknownCount(), deletions: unknownCount(), changedFiles: null },
        provenanceLabelKey: "changes.provenance.unknown",
        reasonKeys: ["changes.reason.resource-deleted"],
        detail: null,
        filePage: null,
        actions: [],
      };
    }
    if (!measurement) {
      const unavailable = freshness?.unavailableReason;
      return {
        ...base,
        measurementId: null,
        state: unavailable ? "unavailable" : "loading",
        availability: unavailable ? "unavailable" : "pending",
        observationState: freshness?.observationState ?? "unknown",
        coverageState: "unknown",
        hasFileChanges: null,
        hasTextChanges: null,
        badge: { visible: Boolean(unavailable), mode: unavailable ? "unknown" : "none" },
        counters: { additions: unknownCount(), deletions: unknownCount(), changedFiles: null },
        provenanceLabelKey: "changes.provenance.unknown",
        reasonKeys: unavailable ? [`changes.reason.${unavailable}`] : [],
        detail: null,
        filePage: null,
        actions: parts.selector === "live" ? [this.refreshAction(resourceKey)] : [],
      };
    }
    const presentation = presentationOf(measurement);
    const coverageState = measurement.completeness.files;
    const stale = freshness?.stale === true;
    const state: ChangeProjection["state"] = stale
      ? "stale"
      : coverageState !== "complete" ||
          measurement.totals.additions.quality === "unknown" ||
          measurement.totals.deletions.quality === "unknown"
        ? "partial"
        : "ready";
    const page = pageSize > 0 ? this.page(resourceKey, measurement, 0, pageSize) : null;
    const observationState =
      freshness?.observationState ?? (measurement.finality === "final" ? "fresh" : "unknown");
    return {
      ...base,
      measurementId: measurement.measurementId,
      baselineVersion: measurement.baselineVersion,
      state,
      availability: "ready",
      observationState,
      coverageState,
      ...presentation,
      counters: {
        additions: measurement.totals.additions,
        deletions: measurement.totals.deletions,
        changedFiles: measurement.totals.changedFiles,
      },
      labelArgs:
        measurement.totals.contentLines != null
          ? { contentLines: measurement.totals.contentLines }
          : {},
      provenanceLabelKey: provenanceKey(measurement),
      reasonKeys: [...(stale ? ["changes.reason.stale"] : []), ...reasonKeys(measurement)],
      detail: measurement.diffIdentityId ? { diffIdentityId: measurement.diffIdentityId } : null,
      filePage: page,
      actions: this.actions(resourceKey, measurement),
    };
  }

  private refreshAction(resourceKey: string): ChangeAction {
    return { kind: "refresh", targetToken: resourceKey, enabled: true, reasonKey: null };
  }

  private actions(resourceKey: string, measurement: ChangeMeasurement): ChangeAction[] {
    const parts = parseChangeResourceKey(resourceKey);
    const actions: ChangeAction[] = [];
    if (measurement.diffIdentityId) {
      actions.push({
        kind: "open-historical-diff",
        targetToken: measurement.diffIdentityId,
        enabled: true,
        reasonKey: null,
      });
    }
    if (measurement.logicalOwner.environmentId) {
      actions.push({
        kind: "open-current-diff",
        targetToken: `env:${measurement.logicalOwner.environmentId}`,
        enabled: true,
        reasonKey: null,
      });
    }
    if (parts?.selector === "live") actions.push(this.refreshAction(resourceKey));
    const restorable =
      measurement.origin === "captured-endpoints" &&
      measurement.beforeSnapshotId !== null &&
      measurement.afterSnapshotId !== null &&
      measurement.finality === "final";
    actions.push({
      kind: "restore",
      targetToken: measurement.measurementId,
      enabled: this.policy.restoreEnabled && restorable,
      reasonKey: !this.policy.restoreEnabled
        ? "changes.restore.disabled"
        : restorable
          ? null
          : "changes.restore.no-retained-endpoints",
    });
    actions.push({
      kind: "copy-handoff",
      targetToken: measurement.measurementId,
      enabled: true,
      reasonKey: null,
    });
    return actions;
  }

  private rows(measurement: ChangeMeasurement, offset: number, limit: number): ChangeFileRow[] {
    return this.ledger.measurementFiles(measurement.measurementId, offset, limit).map((row) => ({
      rowId: `${measurement.measurementId}:${row.ordinal}`,
      pathId: row.path_id,
      oldPathDisplay: row.old_path ? displayPath(row.old_path) : null,
      newPathDisplay: row.new_path ? displayPath(row.new_path) : null,
      status: row.status as ChangeFileRow["status"],
      fileKind: row.file_kind as ChangeFileRow["fileKind"],
      additions: lineCount(row.additions, row.additions_quality),
      deletions: lineCount(row.deletions, row.deletions_quality),
      bodyAvailability: row.body_state as ChangeFileRow["bodyAvailability"],
      reasonKey: row.reason ? `changes.reason.${row.reason}` : null,
      detail: measurement.diffIdentityId ? { diffIdentityId: measurement.diffIdentityId } : null,
    }));
  }

  private page(
    resourceKey: string,
    measurement: ChangeMeasurement,
    offset: number,
    pageSize: number,
  ): NonNullable<ChangeProjection["filePage"]> {
    const limit = Math.max(1, Math.min(pageSize, FILE_PAGE_MAX_ROWS));
    const candidates = this.rows(measurement, offset, limit);
    const rows: ChangeFileRow[] = [];
    let bytes = 0;
    for (const row of candidates) {
      const size = JSON.stringify(row).length;
      if (rows.length > 0 && bytes + size > FILE_PAGE_MAX_BYTES) break;
      rows.push(row);
      bytes += size;
    }
    const total = this.ledger.measurementFileCount(measurement.measurementId);
    const token = this.snapshotToken(resourceKey, measurement.measurementId);
    const next = offset + rows.length;
    return {
      snapshotToken: token,
      rows,
      nextCursor: next < total ? encodeCursor(token, next) : null,
      totalRows: total,
    };
  }

  files(
    resourceKey: string,
    snapshotToken: string,
    cursor: string | null,
    pageSize: number,
  ): ChangesGetFilesResult {
    const measurement = this.selectedMeasurement(resourceKey);
    const token = this.snapshotToken(resourceKey, measurement?.measurementId ?? null);
    if (snapshotToken !== token || !measurement) {
      return {
        kind: "error",
        error: { code: "stale-cursor", reasonKey: "changes.error.stale-cursor" },
      };
    }
    let offset = 0;
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded || decoded.token !== token) {
        return {
          kind: "error",
          error: { code: "stale-cursor", reasonKey: "changes.error.stale-cursor" },
        };
      }
      offset = decoded.offset;
    }
    const page = this.page(resourceKey, measurement, offset, pageSize);
    return {
      kind: "page",
      snapshotToken: page.snapshotToken,
      rows: page.rows,
      nextCursor: page.nextCursor,
      totalRows: page.totalRows,
      deliveredRows: offset + page.rows.length,
    };
  }
}
