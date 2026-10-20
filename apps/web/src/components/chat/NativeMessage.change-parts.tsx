import { useEffect, useMemo, useState } from "react";
import type { ToolKind } from "@orkestrator/protocol/change-evidence";
import {
  environmentChangeResourceKey,
  type ChangeFileRow,
  type ChangeProjection,
  type ChangesGetDiffResult,
} from "@orkestrator/protocol/change-resources";
import * as backend from "@/lib/backend";
import type { LegacyPayloadSummary } from "@/lib/backend/changes";
import { useToolChangePresentation } from "@/hooks/useChangeProjection";
import { toolPresentationKey, useChangeProjectionStore } from "@/stores/changeProjectionStore";
import { changeLabel, changeReason } from "@/lib/changes/labels";
import { ChangeCountBadge, LineCountPair } from "@/components/changes/ChangeCountBadge";
import { ChangeHunksView } from "@/components/changes/ChangeHunksView";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import { useToolChangeScope } from "./NativeMessage.change-scope";

/**
 * Transcript tool rows rendered from backend change projections
 * (docs/architecture/change-tracking.md, "Client contract").
 *
 * Nothing here counts lines, parses patches, chooses between provider counts
 * and captured sides, or classifies provider tool names: counts, hunks,
 * provenance and role order all arrive prepared by the backend.
 */

// ---------------------------------------------------------------------------
// Presentation lookup
// ---------------------------------------------------------------------------

const FILE_TOOL_KINDS: ReadonlySet<ToolKind> = new Set([
  "file-edit",
  "file-write",
  "file-delete",
  "file-move",
  "notebook-edit",
]);

/** True for the backend's file tool kinds, which render as an edit card. */
export function isFileToolKind(kind: ToolKind | undefined): boolean {
  return kind !== undefined && FILE_TOOL_KINDS.has(kind);
}

/**
 * The backend's tool kind for a transcript call, read without requesting it
 * (the row the call renders as asks). Selects a string, so routing re-renders
 * only when the kind itself changes.
 */
export function useToolChangeKind(
  nativeCallId: string | undefined,
  occurrenceId?: string,
): ToolKind | undefined {
  const scope = useToolChangeScope();
  const callId =
    scope?.provider === "pi" && nativeCallId && occurrenceId
      ? JSON.stringify([nativeCallId, occurrenceId])
      : nativeCallId;
  const key =
    scope && callId
      ? toolPresentationKey(scope.environmentId, scope.provider, scope.conversationId, callId)
      : null;
  return useChangeProjectionStore((state) =>
    key ? (state.toolPresentations.get(key)?.toolKind ?? undefined) : undefined,
  );
}

export interface ToolChangeRole {
  role: "payload" | "effect" | "observation";
  prominence: "primary" | "secondary";
  projection: ChangeProjection | undefined;
}

/**
 * A transcript row's change presentation, roles ordered primary first (then
 * in the backend's order). `legacy` is true when the row will never get a
 * presentation: no conversation scope or call id, or the backend answered
 * that it holds none for this call (history recorded before tracking).
 */
export function useToolChangeRow(
  nativeCallId: string | undefined,
  toolState?: string,
  occurrenceId?: string,
) {
  const scope = useToolChangeScope();
  const callId =
    scope?.provider === "pi" && nativeCallId && occurrenceId
      ? JSON.stringify([nativeCallId, occurrenceId])
      : nativeCallId;
  const { presentation, projections } = useToolChangePresentation(scope, callId, toolState);
  const roles: ToolChangeRole[] = [
    ...projections.filter((entry) => entry.prominence === "primary"),
    ...projections.filter((entry) => entry.prominence !== "primary"),
  ];
  return {
    scope,
    presentation,
    roles,
    legacy: !presentation && (presentation === null || !scope || !callId),
  };
}

/** Whether a projection has anything worth a section of its own. */
export function projectionHasContent(projection: ChangeProjection | undefined): boolean {
  if (!projection) return false;
  return projection.badge.visible || (projection.filePage?.rows.length ?? 0) > 0;
}

function rowPath(row: ChangeFileRow): string {
  return row.newPathDisplay ?? row.oldPathDisplay ?? row.pathId;
}

/** The first file a projection names, for rows whose transcript part has no path. */
export function projectionFirstPath(projection: ChangeProjection | undefined): string | undefined {
  const row = projection?.filePage?.rows[0];
  return row ? rowPath(row) : undefined;
}

/** A live, current-file diff target for a path in an environment. */
export function liveFileTarget(
  environmentId: string,
  file: { path: string } | { pathId: string },
  title: string,
): ChangeDiffTarget {
  return {
    kind: "live",
    resourceKey: environmentChangeResourceKey(environmentId),
    ...file,
    title,
  };
}

// ---------------------------------------------------------------------------
// Backend diff bodies
// ---------------------------------------------------------------------------

/** Diff identities are immutable, so a fetched body never goes stale. */
const DIFF_BODY_CACHE_MAX = 64;
const diffBodyCache = new Map<string, Extract<ChangesGetDiffResult, { kind: "body" }>>();

function rememberDiffBody(id: string, body: Extract<ChangesGetDiffResult, { kind: "body" }>) {
  diffBodyCache.delete(id);
  diffBodyCache.set(id, body);
  while (diffBodyCache.size > DIFF_BODY_CACHE_MAX) {
    const oldest = diffBodyCache.keys().next().value;
    if (oldest === undefined) break;
    diffBodyCache.delete(oldest);
  }
}

type DiffBodyState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "done"; result: ChangesGetDiffResult };

/** Backend-rendered hunks for one diff identity, fetched when first shown. */
export function ChangeDiffBody({ diffIdentityId }: { diffIdentityId: string }) {
  // A fetched answer, tagged with the identity it answers; a cached body is
  // read during render, so only the network result is state.
  const [fetched, setFetched] = useState<{ id: string; state: DiffBodyState } | null>(null);
  const cached = diffBodyCache.get(diffIdentityId);
  const state: DiffBodyState = cached
    ? { status: "done", result: cached }
    : fetched?.id === diffIdentityId
      ? fetched.state
      : { status: "loading" };

  useEffect(() => {
    if (diffBodyCache.has(diffIdentityId)) return;
    let cancelled = false;
    backend.getChangeDiff(diffIdentityId).then(
      (result) => {
        if (cancelled) return;
        if (result?.kind === "body") rememberDiffBody(diffIdentityId, result);
        setFetched({
          id: diffIdentityId,
          state:
            result?.kind === "body" || result?.kind === "error"
              ? { status: "done", result }
              : { status: "failed" },
        });
      },
      () => {
        if (!cancelled) setFetched({ id: diffIdentityId, state: { status: "failed" } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [diffIdentityId]);

  if (state.status === "loading") {
    return <div className="px-3 py-1.5 text-xs text-muted-foreground">Loading change…</div>;
  }
  if (state.status === "failed") {
    return (
      <div role="note" className="px-3 py-1.5 text-xs text-muted-foreground">
        The change body could not be loaded.
      </div>
    );
  }
  const result = state.result;
  if (result.kind === "error") {
    return (
      <div role="note" className="px-3 py-1.5 text-xs text-muted-foreground">
        {changeReason(result.error.reasonKey)}
      </div>
    );
  }
  return (
    <div data-testid="change-diff-body">
      {result.files.map((file) => (
        <div key={file.pathId}>
          {result.files.length > 1 && (
            <div className="px-3 py-1 text-xs font-mono text-muted-foreground truncate">
              {file.newPathDisplay ?? file.oldPathDisplay ?? file.pathId}
            </div>
          )}
          <ChangeHunksView file={file} />
        </div>
      ))}
      {result.nextCursor && (
        <div role="note" className="px-3 py-1.5 text-xs text-muted-foreground">
          More files changed; open the diff to see them all.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File rows and role sections
// ---------------------------------------------------------------------------

/**
 * A projection's file page. A row with a retained body opens that historical
 * change; a row whose body was not retained can only open the file as it is
 * now, and says so.
 */
export function ChangeFileRows({
  projection,
  environmentId,
}: {
  projection: ChangeProjection;
  environmentId: string | undefined;
}) {
  const createFileTab = useOptionalTerminalContext()?.createFileTab;
  const page = projection.filePage;
  if (!page || page.rows.length === 0) return null;
  const opensCurrent = page.rows.some((row) => !row.detail);
  const more = page.nextCursor !== null || (page.totalRows ?? page.rows.length) > page.rows.length;
  return (
    <div className="py-1 text-xs" data-testid="change-file-rows">
      <ul className="space-y-0.5">
        {page.rows.map((row) => {
          const path = rowPath(row);
          const target: ChangeDiffTarget | null = row.detail
            ? { kind: "historical", diffIdentityId: row.detail.diffIdentityId, title: path }
            : environmentId
              ? liveFileTarget(environmentId, { pathId: row.pathId }, `${path} (current)`)
              : null;
          const pathTitle =
            row.oldPathDisplay && row.newPathDisplay && row.oldPathDisplay !== row.newPathDisplay
              ? `${row.oldPathDisplay} → ${row.newPathDisplay}`
              : path;
          return (
            <li key={row.rowId} className="flex items-center gap-2 font-mono">
              {createFileTab && target ? (
                <button
                  type="button"
                  className="truncate text-left text-foreground/80 hover:text-foreground hover:underline"
                  title={
                    target.kind === "live"
                      ? `${pathTitle} — opens the current file; this change's contents were not retained`
                      : pathTitle
                  }
                  onClick={() => createFileTab(path, { isDiff: true, changeDiff: target })}
                >
                  {path}
                </button>
              ) : (
                <span className="truncate text-foreground/80" title={pathTitle}>
                  {path}
                </span>
              )}
              <span className="ml-auto flex shrink-0 gap-1">
                {row.fileKind === "binary" && <span className="text-muted-foreground">binary</span>}
                <LineCountPair additions={row.additions} deletions={row.deletions} />
              </span>
            </li>
          );
        })}
      </ul>
      {more && (
        <div className="mt-1 text-muted-foreground">
          More files changed; the totals above include them all.
        </div>
      )}
      {opensCurrent && createFileTab && environmentId && (
        <div className="mt-1 text-muted-foreground">
          These contents were not retained; files open in their current state.
        </div>
      )}
    </div>
  );
}

/**
 * One role (payload, effect or observation) of a tool's change: its own
 * label, provenance and badge. Roles are separate measurements and are never
 * summed. `body` shows backend hunks when the measurement retained them.
 */
export function ChangeRoleSection({
  role,
  projection,
  environmentId,
  body,
}: {
  role: ToolChangeRole["role"];
  projection: ChangeProjection | undefined;
  environmentId: string | undefined;
  body: boolean;
}) {
  if (!projection) {
    return (
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border/30">
        Loading change…
      </div>
    );
  }
  return (
    <div
      className="px-3 py-1.5 border-b border-border/30"
      data-testid="change-role"
      data-change-role={role}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="font-medium text-foreground/80 truncate">
          {changeLabel(projection.labelKey, projection.labelArgs)}
        </span>
        <span className="text-muted-foreground truncate">
          {changeLabel(projection.provenanceLabelKey)}
        </span>
        <ChangeCountBadge
          projection={projection}
          className="ml-auto"
          testId={`change-role-badge-${role}`}
        />
      </div>
      {projection.reasonKeys.length > 0 && (
        <ul className="mt-0.5 text-[10px] text-muted-foreground">
          {projection.reasonKeys.map((reason) => (
            <li key={reason}>{changeReason(reason)}</li>
          ))}
        </ul>
      )}
      {body && projection.detail ? (
        <ChangeDiffBody diffIdentityId={projection.detail.diffIdentityId} />
      ) : (
        <ChangeFileRows projection={projection} environmentId={environmentId} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legacy transcript payloads
// ---------------------------------------------------------------------------

export interface LegacyPayloadInput {
  toolName?: string;
  filePath?: string;
  before?: string;
  after?: string;
  diff?: string;
  /** Counts an old transcript recorded without a body; measured as provider-reported. */
  additions?: number;
  deletions?: number;
}

export type LegacyMeasurement =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; summary: LegacyPayloadSummary }
  | { status: "unavailable" };

/**
 * Measurements by row, so a virtualized row that remounts does not send its
 * payload again. An entry is reused only for the identical input.
 */
const LEGACY_CACHE_MAX = 128;
const legacyCache = new Map<string, { input: LegacyPayloadInput; summary: LegacyPayloadSummary }>();

function sameInput(a: LegacyPayloadInput, b: LegacyPayloadInput): boolean {
  return (
    a.toolName === b.toolName &&
    a.filePath === b.filePath &&
    a.before === b.before &&
    a.after === b.after &&
    a.diff === b.diff &&
    a.additions === b.additions &&
    a.deletions === b.deletions
  );
}

function cachedLegacy(rowKey: string, input: LegacyPayloadInput | null) {
  if (!input) return undefined;
  const entry = legacyCache.get(rowKey);
  return entry && sameInput(entry.input, input) ? entry.summary : undefined;
}

/** Test seam: forget remembered legacy measurements and diff bodies. */
export function resetChangePartCachesForTests(): void {
  legacyCache.clear();
  diffBodyCache.clear();
}

/**
 * Backend measurement of a legacy row's recorded payload, requested once per
 * distinct input. A failure (or an older backend) leaves the row without
 * numbers rather than with a locally computed one.
 */
export function useLegacyPayloadMeasurement(
  rowKey: string,
  input: LegacyPayloadInput | null,
): LegacyMeasurement {
  const toolName = input?.toolName;
  const filePath = input?.filePath;
  const before = input?.before;
  const after = input?.after;
  const diff = input?.diff;
  const additions = input?.additions;
  const deletions = input?.deletions;
  const active = input !== null;
  const stableInput = useMemo<LegacyPayloadInput | null>(
    () => (active ? { toolName, filePath, before, after, diff, additions, deletions } : null),
    [active, toolName, filePath, before, after, diff, additions, deletions],
  );
  // The network answer, tagged with the exact request it answers; idle and
  // cache hits are derived during render.
  const [fetched, setFetched] = useState<{
    rowKey: string;
    input: LegacyPayloadInput;
    state: LegacyMeasurement;
  } | null>(null);

  useEffect(() => {
    if (!stableInput || cachedLegacy(rowKey, stableInput)) return;
    let cancelled = false;
    const request: LegacyPayloadInput = {};
    if (stableInput.toolName !== undefined) request.toolName = stableInput.toolName;
    if (stableInput.filePath !== undefined) request.filePath = stableInput.filePath;
    if (stableInput.before !== undefined) request.before = stableInput.before;
    if (stableInput.after !== undefined) request.after = stableInput.after;
    if (stableInput.diff !== undefined) request.diff = stableInput.diff;
    if (stableInput.additions !== undefined) request.additions = stableInput.additions;
    if (stableInput.deletions !== undefined) request.deletions = stableInput.deletions;
    const settle = (state: LegacyMeasurement) => {
      if (!cancelled) setFetched({ rowKey, input: stableInput, state });
    };
    backend.measureLegacyToolPayload(request).then(
      (summary) => {
        if (cancelled) return;
        if (!summary) {
          settle({ status: "unavailable" });
          return;
        }
        legacyCache.delete(rowKey);
        legacyCache.set(rowKey, { input: stableInput, summary });
        while (legacyCache.size > LEGACY_CACHE_MAX) {
          const oldest = legacyCache.keys().next().value;
          if (oldest === undefined) break;
          legacyCache.delete(oldest);
        }
        settle({ status: "ready", summary });
      },
      () => settle({ status: "unavailable" }),
    );
    return () => {
      cancelled = true;
    };
  }, [rowKey, stableInput]);

  if (!stableInput) return { status: "idle" };
  const cached = cachedLegacy(rowKey, stableInput);
  if (cached) return { status: "ready", summary: cached };
  if (fetched && fetched.rowKey === rowKey && fetched.input === stableInput) return fetched.state;
  return { status: "loading" };
}

function legacyTitle(summary: LegacyPayloadSummary): string {
  return [changeLabel(summary.provenanceLabelKey), ...summary.reasonKeys.map(changeReason)].join(
    "\n",
  );
}

/** The backend's counts for a legacy payload, labelled with its provenance. */
export function LegacyPayloadBadge({ summary }: { summary: LegacyPayloadSummary }) {
  const title = legacyTitle(summary);
  if (
    summary.additions.value === null &&
    summary.deletions.value === null &&
    summary.contentLines !== null
  ) {
    return (
      <span
        data-testid="legacy-change-badge"
        title={title}
        className="flex items-center gap-1 shrink-0 font-mono text-muted-foreground"
      >
        {summary.contentLines} line{summary.contentLines === 1 ? "" : "s"}
      </span>
    );
  }
  return (
    <LineCountPair
      additions={summary.additions}
      deletions={summary.deletions}
      title={title}
      testId="legacy-change-badge"
    />
  );
}

/** The backend's hunks for a legacy payload. */
export function LegacyPayloadBody({ summary }: { summary: LegacyPayloadSummary }) {
  return (
    <div data-testid="legacy-change-body">
      <div className="px-3 py-1 text-[10px] text-muted-foreground">
        {changeLabel(summary.provenanceLabelKey)}
        {summary.reasonKeys.length > 0 && ` — ${summary.reasonKeys.map(changeReason).join("; ")}`}
      </div>
      {summary.files.map((file) => (
        <ChangeHunksView key={file.pathId} file={file} />
      ))}
    </div>
  );
}
