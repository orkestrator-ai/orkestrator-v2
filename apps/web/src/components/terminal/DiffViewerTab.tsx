import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  AlignJustify,
  Columns,
  FileCode,
  FilePlus,
  FileText,
  FileX,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  FILE_ROWS_CAPPED_REASON,
  type ChangeMeasurement,
} from "@orkestrator/protocol/change-measurements";
import {
  changeResourceKey,
  parseChangeResourceKey,
  type ChangeDiffFileBody,
  type ChangeDiffHunk,
  type ChangeError,
  type ChangeFileStatus,
  type DiffDisplayOptions,
  type DiffIdentity,
} from "@orkestrator/protocol/change-resources";
import { cn } from "@/lib/utils";
import { backendForScope } from "@/lib/backend/scope-backend";
import { getChangeTrackingCapabilities } from "@/lib/backend/changes";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { changeLabel, changeReason, formatFileCount, formatLineCount } from "@/lib/changes/labels";
import { useChangeContentGeneration, useChangeProjection } from "@/hooks/useChangeProjection";
import { useMediaQuery } from "@/hooks";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";
import { useConfigStore } from "@/stores";
import { DEFAULT_TERMINAL_APPEARANCE } from "@/constants/terminal";
import { Button } from "@/components/ui/button";
import { TruncatedPath } from "@/components/ui/truncated-path";
import { ChangeHunksView } from "@/components/changes/ChangeHunksView";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import { DiffNavigationBar, type DiffScopeChoice } from "./DiffNavigationBar";
import {
  hunkLayout,
  isEditableTarget,
  navigate,
  navigationCommandForKey,
  type DiffNavigationCommand,
} from "./diff-hunk-navigation";
import { hunkStagingKey, useHunkStaging } from "./useHunkStaging";

/**
 * Backend-rendered diff tab (docs/architecture/change-tracking.md).
 *
 * The tab renders versioned bodies the backend prepared for one target. It
 * never chooses endpoints, reads either side of a file, infers renames or
 * computes a diff. A historical identity is fixed: it is never re-read from
 * today's disk, and a missing body is shown as unavailable. A live target is
 * the explicit "current workspace file" view: it resolves to a fresh
 * immutable identity and resolves again whenever the backend says the file's
 * content may have changed.
 *
 * Every body can be stepped through hunk by hunk and file by file (buttons
 * and keyboard, `diff-hunk-navigation.ts`). A live file on a backend with
 * hunk staging can also be shown as its unstaged (index → working tree) or
 * staged (HEAD → index) diff, and one reviewed hunk at a time staged or
 * unstaged. The backend applies it only against the exact index and file
 * the reviewed identity compared (`changes_stage_hunk`); afterwards the tab
 * resolves a fresh identity.
 */

interface DiffViewerTabProps {
  target: ChangeDiffTarget;
  /** Tab path, used only as a label when the backend names no path. */
  filePath?: string;
  isActive: boolean;
  /** Offered for live targets: opens the current file in the editor. */
  onSwitchToFileView?: () => void;
}

type DiffMode = "split" | "unified";

/** Viewports narrower than this get the touch-oriented single-column layout. */
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

const IGNORE_WHITESPACE: DiffDisplayOptions = { whitespace: "ignore-for-view" };

type LiveResolution =
  | { key: string; kind: "identity"; identityId: string }
  | { key: string; kind: "unavailable"; error: ChangeError }
  | { key: string; kind: "failed"; message: string };

type BodyState =
  | {
      key: string;
      kind: "body";
      identityId: string;
      identity: DiffIdentity;
      measurement: ChangeMeasurement | null;
      provenanceLabelKey: string | null;
      files: ChangeDiffFileBody[];
      nextCursor: string | null;
      loadingMore: boolean;
      moreError: string | null;
    }
  | { key: string; kind: "unavailable"; error: ChangeError }
  | { key: string; kind: "failed"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Path ids this live view depends on; an invalidation naming any of them re-resolves. */
function identityPathIds(identity: DiffIdentity): string[] {
  if (identity.kind !== "file") return [];
  const ids: string[] = [];
  if (identity.after.state === "present") ids.push(identity.after.pathId);
  if (identity.before.state === "present") ids.push(identity.before.pathId);
  return ids;
}

/** `main@<oid>` keeps the ref and a short object name; the full value stays in the tooltip. */
const FULL_OID = /^[0-9a-f]{12,}$/i;

/** The ref a baseline version (`<ref>@<oid>` or `<ref>`) compares against. */
function baselineRef(version: string): string {
  const at = version.lastIndexOf("@");
  return (at < 0 ? version : version.slice(0, at)).replace(/^ref:/, "");
}

function formatBaselineVersion(version: string): string {
  const ref = baselineRef(version);
  const shortRef = FULL_OID.test(ref) ? ref.slice(0, 7) : ref;
  const at = version.lastIndexOf("@");
  if (at < 0) return shortRef;
  const oid = version.slice(at + 1);
  // A baseline pinned to a commit names that commit once.
  if (oid === ref) return shortRef;
  return `${shortRef}@${FULL_OID.test(oid) ? oid.slice(0, 7) : oid}`;
}

/** Live scopes a file can be switched between, and how the switch names them. */
const SCOPE_CHOICE_LABELS: Record<string, string> = {
  "environment-net": "All changes",
  "uncommitted-net": "Uncommitted",
  unstaged: "Unstaged",
  staged: "Staged",
};

/** Scopes whose diff stages into the index, and the one that unstages from it. */
const STAGE_FROM_SCOPES = new Set(["environment-net", "uncommitted-net", "unstaged"]);

function unavailableCopy(
  error: ChangeError,
  live: boolean,
  scope?: string,
): { title: string; detail: string } {
  if (live && error.code === "not-found" && (scope === "staged" || scope === "unstaged")) {
    return scope === "staged"
      ? {
          title: "No staged changes in this file",
          detail: "Nothing in this file is staged. Switch to Unstaged to stage changes.",
        }
      : {
          title: "No unstaged changes in this file",
          detail: "Every change in this file is staged. Switch to Staged to review or unstage it.",
        };
  }
  switch (error.code) {
    case "body-expired":
      return {
        title: "This diff is no longer available",
        detail:
          "The recorded file contents were removed by retention. The counts recorded for this change are unchanged.",
      };
    case "not-found":
      return live
        ? {
            title: "No current changes for this file",
            detail: "The workspace has no recorded change for this file.",
          }
        : {
            title: "This diff could not be found",
            detail: "The backend has no record of this change.",
          };
    case "stale-revision":
      return {
        title: "The change list moved on",
        detail: "Reopen the file from the changes list to see its current diff.",
      };
    default:
      return { title: "Diff unavailable", detail: changeReason(error.reasonKey) };
  }
}

const STATUS_TEXT: Record<ChangeFileStatus, string> = {
  added: "New file",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  "mode-changed": "Mode changed",
  "type-changed": "Type changed",
  unknown: "Changed",
};

function statusIcon(status: ChangeFileStatus | null): ReactNode {
  if (status === "added") return <FilePlus className="h-3 w-3 text-success" />;
  if (status === "deleted") return <FileX className="h-3 w-3 text-failure" />;
  return <FileCode className="h-3 w-3" />;
}

function splitPath(filePath: string) {
  const separatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return {
    directory: separatorIndex >= 0 ? filePath.slice(0, separatorIndex) : "",
    separator: separatorIndex >= 0 ? (filePath[separatorIndex] ?? "/") : "/",
    filename: separatorIndex >= 0 ? filePath.slice(separatorIndex + 1) : filePath,
  };
}

function filePathLabel(file: Pick<ChangeDiffFileBody, "oldPathDisplay" | "newPathDisplay">): {
  path: string | null;
  renamedFrom: string | null;
} {
  const path = file.newPathDisplay ?? file.oldPathDisplay;
  const renamedFrom =
    file.oldPathDisplay && file.newPathDisplay && file.oldPathDisplay !== file.newPathDisplay
      ? file.oldPathDisplay
      : null;
  return { path, renamedFrom };
}

export function DiffViewerTab({
  target,
  filePath,
  isActive,
  onSwitchToFileView,
}: DiffViewerTabProps) {
  // This node's backend (plan item 4001); the command node outside a node scope.
  const backendScope = useScopesWithCommandFallback().scope;
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ||
    DEFAULT_TERMINAL_APPEARANCE;
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const [diffMode, setDiffMode] = useState<DiffMode>("split");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  // Two columns of code cannot fit on a phone, so the mode toggle is hidden there
  // and the view is pinned to unified regardless of the remembered desktop mode.
  const effectiveMode: DiffMode = isMobile ? "unified" : diffMode;

  const isLive = target.kind === "live";
  const historicalIdentityId = target.kind === "historical" ? target.diffIdentityId : null;

  // Hunk staging, and the unstaged/staged views it works from, need a backend
  // that offers them; an older one keeps today's single comparison.
  const [hunkStagingSupported, setHunkStagingSupported] = useState(false);
  useEffect(() => {
    let current = true;
    void getChangeTrackingCapabilities(backendScope).then((capabilities) => {
      if (current) setHunkStagingSupported(capabilities?.hunkStaging === true);
    });
    return () => {
      current = false;
    };
  }, [backendScope]);

  const targetResourceKey = target.kind === "live" ? target.resourceKey : null;
  const scopeChoices = useMemo((): DiffScopeChoice[] | null => {
    if (!hunkStagingSupported || !targetResourceKey) return null;
    const parts = parseChangeResourceKey(targetResourceKey);
    if (
      !parts ||
      parts.ownerKind !== "environment" ||
      parts.selector !== "live" ||
      !(parts.scope in SCOPE_CHOICE_LABELS)
    ) {
      return null;
    }
    const scopes =
      parts.scope === "staged" || parts.scope === "unstaged"
        ? (["unstaged", "staged"] as const)
        : ([parts.scope, "unstaged", "staged"] as const);
    return scopes.map((scope) => ({
      resourceKey:
        scope === parts.scope
          ? targetResourceKey
          : changeResourceKey({
              scope,
              ownerKind: "environment",
              ownerId: parts.ownerId,
              selector: "live",
            }),
      label: SCOPE_CHOICE_LABELS[scope]!,
    }));
  }, [hunkStagingSupported, targetResourceKey]);
  // The comparison picked for this target; another target starts on its own.
  const [scopeChoice, setScopeChoice] = useState<{ target: string; resourceKey: string } | null>(
    null,
  );
  const liveResourceKey =
    targetResourceKey !== null &&
    scopeChoice?.target === targetResourceKey &&
    scopeChoices?.some((choice) => choice.resourceKey === scopeChoice.resourceKey)
      ? scopeChoice.resourceKey
      : targetResourceKey;
  // A row pins the target's own resource; another comparison follows the file.
  const scopeOverridden = liveResourceKey !== targetResourceKey;
  const liveScope = liveResourceKey
    ? (parseChangeResourceKey(liveResourceKey)?.scope ?? null)
    : null;
  const livePathId = target.kind === "live" ? target.pathId : undefined;
  const livePath = target.kind === "live" ? target.path : undefined;
  const liveRowId = target.kind === "live" && !scopeOverridden ? target.rowId : undefined;
  const liveRevision = target.kind === "live" && !scopeOverridden ? target.revision : undefined;
  const liveKey = liveResourceKey
    ? [liveResourceKey, livePathId ?? "", livePath ?? "", liveRowId ?? "", liveRevision ?? ""].join(
        "\0",
      )
    : null;

  // Registering interest installs the shared change-event listener, which
  // records content invalidations for this resource.
  const projection = useChangeProjection(liveResourceKey);
  const transportRevision = useChangeProjectionStore((state) => state.transportRevision);
  const contentGeneration = useChangeContentGeneration(liveResourceKey);
  const ownerGeneration = contentGeneration?.ownerGeneration ?? projection?.ownerGeneration;

  // ---------------------------------------------------------------------------
  // Live target -> immutable identity
  // ---------------------------------------------------------------------------
  const [liveResolution, setLiveResolution] = useState<LiveResolution | null>(null);
  const resolveSeqRef = useRef(0);
  const handledRef = useRef<{
    key: string;
    reload: number;
    generation: number;
    owner?: string;
    transport: number;
  } | null>(null);
  /** Whether the target's pinned row/revision still applies (only for the first answer). */
  const pinnedRef = useRef(true);
  /** Path ids learned from the last identity; used for invalidation and later resolves. */
  const knownPathIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!isActive) {
      handledRef.current = null;
      return;
    }
    if (!liveKey || !liveResourceKey) return;
    const handled = handledRef.current;
    const generation = contentGeneration?.generation ?? -1;
    if (handled?.key !== liveKey) {
      // A different target: forget what the previous one learned.
      pinnedRef.current = true;
      knownPathIdsRef.current = [];
    } else if (
      handled.reload === reloadCount &&
      handled.owner === ownerGeneration &&
      handled.transport === transportRevision
    ) {
      // Only the content generation moved. Re-resolve when it names this file.
      if (generation <= handled.generation) return;
      handled.generation = generation;
      const pathIds = contentGeneration?.pathIds ?? null;
      const ours = new Set([...knownPathIdsRef.current, ...(livePathId ? [livePathId] : [])]);
      if (pathIds !== null && ours.size > 0 && !pathIds.some((id) => ours.has(id))) return;
    }
    handledRef.current = {
      key: liveKey,
      reload: reloadCount,
      generation,
      owner: ownerGeneration,
      transport: transportRevision,
    };

    const seq = ++resolveSeqRef.current;
    const pathId = knownPathIdsRef.current[0] ?? livePathId;
    const unpinned = {
      resourceKey: liveResourceKey,
      ...(pathId ? { pathId } : livePath ? { path: livePath } : {}),
    };
    const pinned = pinnedRef.current
      ? {
          ...unpinned,
          ...(liveRowId !== undefined ? { rowId: liveRowId } : {}),
          ...(liveRevision !== undefined ? { revision: liveRevision } : {}),
        }
      : unpinned;
    const canUnpin = "pathId" in unpinned || "path" in unpinned;

    void (async () => {
      try {
        let result = await backendForScope(backendScope).resolveLiveChangeDetail(pinned);
        if (
          result.kind === "error" &&
          result.error.code === "stale-revision" &&
          pinned !== unpinned &&
          canUnpin
        ) {
          // The row's revision moved on; follow the file instead of the row.
          pinnedRef.current = false;
          if (seq !== resolveSeqRef.current) return;
          result = await backendForScope(backendScope).resolveLiveChangeDetail(unpinned);
        }
        if (seq !== resolveSeqRef.current) return;
        if (result.kind === "identity") {
          pinnedRef.current = false;
          const ids = identityPathIds(result.identity);
          if (ids.length > 0) knownPathIdsRef.current = ids;
          setLiveResolution({ key: liveKey, kind: "identity", identityId: result.identity.id });
        } else {
          setLiveResolution({ key: liveKey, kind: "unavailable", error: result.error });
        }
      } catch {
        if (seq !== resolveSeqRef.current) return;
        setLiveResolution({
          key: liveKey,
          kind: "failed",
          message:
            "This host does not support change diffs, or is temporarily unavailable. Update the host and reload.",
        });
      }
    })();
  }, [
    backendScope,
    contentGeneration,
    ownerGeneration,
    transportRevision,
    isActive,
    liveKey,
    livePath,
    livePathId,
    liveResourceKey,
    liveRevision,
    liveRowId,
    reloadCount,
  ]);

  const currentResolution = liveResolution?.key === liveKey ? liveResolution : null;
  const identityId = isLive
    ? currentResolution?.kind === "identity"
      ? currentResolution.identityId
      : null
    : historicalIdentityId;

  // ---------------------------------------------------------------------------
  // Identity -> backend body (paged)
  // ---------------------------------------------------------------------------
  const [body, setBody] = useState<BodyState | null>(null);
  const [bodyRetry, setBodyRetry] = useState(0);
  const bodySeqRef = useRef(0);
  const display = ignoreWhitespace ? IGNORE_WHITESPACE : undefined;
  const bodyKey = identityId
    ? `${identityId}\0${ignoreWhitespace ? "ignore" : "preserve"}\0${bodyRetry}`
    : null;

  useEffect(() => {
    if (!identityId || !bodyKey) return;
    const seq = ++bodySeqRef.current;
    void backendForScope(backendScope)
      .getChangeDiff(identityId, null, display)
      .then(
        (result) => {
          if (seq !== bodySeqRef.current) return;
          if (result.kind === "body") {
            setBody({
              key: bodyKey,
              kind: "body",
              identityId,
              identity: result.identity,
              measurement: result.measurement,
              provenanceLabelKey: result.provenanceLabelKey ?? null,
              files: result.files,
              nextCursor: result.nextCursor,
              loadingMore: false,
              moreError: null,
            });
          } else {
            setBody({ key: bodyKey, kind: "unavailable", error: result.error });
          }
        },
        (error: unknown) => {
          if (seq !== bodySeqRef.current) return;
          setBody({ key: bodyKey, kind: "failed", message: errorMessage(error) });
        },
      );
  }, [backendScope, bodyKey, display, identityId]);

  const loadMore = useCallback(() => {
    if (body?.kind !== "body" || !body.nextCursor || body.loadingMore) return;
    const seq = bodySeqRef.current;
    const { key, identityId: pageIdentityId, nextCursor } = body;
    setBody({ ...body, loadingMore: true, moreError: null });
    const settle = (update: (current: Extract<BodyState, { kind: "body" }>) => BodyState) => {
      if (seq !== bodySeqRef.current) return;
      setBody((current) =>
        current?.kind === "body" && current.key === key ? update(current) : current,
      );
    };
    void backendForScope(backendScope)
      .getChangeDiff(pageIdentityId, nextCursor, display)
      .then(
        (result) => {
          settle((current) =>
            result.kind === "body"
              ? {
                  ...current,
                  files: [...current.files, ...result.files],
                  nextCursor: result.nextCursor,
                  loadingMore: false,
                }
              : {
                  ...current,
                  loadingMore: false,
                  moreError: unavailableCopy(result.error, false).title,
                },
          );
        },
        (error: unknown) => {
          settle((current) => ({ ...current, loadingMore: false, moreError: errorMessage(error) }));
        },
      );
  }, [backendScope, body, display]);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  const staging = useHunkStaging(backendScope, reload);
  const dismissStaging = staging.dismiss;
  const reloadByUser = useCallback(() => {
    dismissStaging();
    reload();
  }, [dismissStaging, reload]);

  // ---------------------------------------------------------------------------
  // Hunk and file navigation
  // ---------------------------------------------------------------------------
  const bodyRef = useRef<HTMLDivElement>(null);
  const [activePosition, setActivePosition] = useState<number | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ position: number; seq: number } | null>(null);
  useEffect(() => {
    if (!scrollTarget) return;
    const element = bodyRef.current?.querySelector<HTMLElement>(
      `[data-hunk-position="${scrollTarget.position}"]`,
    );
    element?.scrollIntoView?.({ block: "start" });
  }, [scrollTarget]);

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const fallbackTitle = filePath ?? target.title;
  const shownBody = body?.kind === "body" ? body : null;
  const bodyIsCurrent = body !== null && body.key === bodyKey;
  const refreshing =
    (isLive && liveResolution !== null && currentResolution === null) ||
    (identityId !== null && !bodyIsCurrent);

  const shownFiles = shownBody?.files;
  const layout = useMemo(() => hunkLayout(shownFiles ?? []), [shownFiles]);
  const hunkCount = layout.positions.length;
  // Nothing picked yet means the first hunk; a body that shrank keeps the last.
  const position = hunkCount === 0 ? null : Math.min(activePosition ?? 0, hunkCount - 1);
  const activeHunk = position === null ? null : (layout.positions[position] ?? null);

  const runNavigation = (command: DiffNavigationCommand) => {
    const next = navigate(layout, position, command);
    if (next === null) return;
    setActivePosition(next);
    setScrollTarget((previous) => ({ position: next, seq: (previous?.seq ?? 0) + 1 }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isEditableTarget(event.target)) return;
    const command = navigationCommandForKey(event);
    if (!command) return;
    event.preventDefault();
    runNavigation(command);
  };

  // Stage from an index or workspace diff, unstage from the staged diff.
  const identityForStaging = shownBody?.identity ?? null;
  const stagingAction: "stage" | "unstage" | null =
    hunkStagingSupported &&
    isLive &&
    !ignoreWhitespace &&
    identityForStaging?.kind === "file" &&
    identityForStaging.before.state === "present" &&
    identityForStaging.after.state === "present" &&
    identityForStaging.before.pathId === identityForStaging.after.pathId
      ? identityForStaging.scope === "staged"
        ? "unstage"
        : STAGE_FROM_SCOPES.has(identityForStaging.scope)
          ? "stage"
          : null
      : null;
  // A workspace diff (not the unstaged one) keeps showing a staged change.
  const stagingNote =
    stagingAction === "stage" && liveScope !== "unstaged"
      ? " It stays in this view, which does not compare against the index; switch to Staged to see it."
      : "";

  const hunkActions = (file: ChangeDiffFileBody, fileIndex: number) => {
    if (
      !stagingAction ||
      !shownBody ||
      file.fileKind !== "text" ||
      file.status !== "modified" ||
      file.bodyAvailability !== "available"
    ) {
      return undefined;
    }
    const identity = shownBody.identity;
    return (hunk: ChangeDiffHunk, hunkIndex: number) => {
      const number = (layout.fileStarts[fileIndex] ?? 0) + hunkIndex + 1;
      const pending = staging.pendingKey === hunkStagingKey(identity.id, hunkIndex);
      const cut = file.truncated && hunkIndex === file.hunks.length - 1;
      const verb = stagingAction === "stage" ? "Stage" : "Unstage";
      return (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          disabled={staging.pendingKey !== null || cut || refreshing}
          aria-label={`${verb} change ${number}`}
          title={
            cut
              ? changeReason("changes.staging.truncated")
              : stagingAction === "stage"
                ? "Stage this change: write it to the Git index, leaving every other change as it is"
                : "Unstage this change: take it out of the Git index, leaving the working file as it is"
          }
          onClick={() =>
            void staging.stage(
              {
                diffIdentityId: identity.id,
                action: stagingAction,
                hunk: {
                  index: hunkIndex,
                  oldStart: hunk.oldStart,
                  oldLines: hunk.oldLines,
                  newStart: hunk.newStart,
                  newLines: hunk.newLines,
                },
              },
              `change ${number}`,
              stagingNote,
            )
          }
        >
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : stagingAction === "stage" ? (
            <Plus className="h-3 w-3" />
          ) : (
            <Minus className="h-3 w-3" />
          )}
          {verb}
        </Button>
      );
    };
  };

  const shell = (children: ReactNode, testId = "diff-viewer") => (
    <div
      data-testid={testId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute inset-0 flex flex-col outline-none",
        !isActive && "pointer-events-none opacity-0",
      )}
      style={{ backgroundColor: terminalAppearance.backgroundColor }}
    >
      {children}
    </div>
  );

  const centered = (children: ReactNode) => (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <div className="flex max-w-md flex-col items-center gap-2 text-center">{children}</div>
    </div>
  );

  const headerProps = {
    target,
    fallbackTitle,
    isMobile,
    diffMode,
    onDiffModeChange: setDiffMode,
    ignoreWhitespace,
    onToggleWhitespace: () => setIgnoreWhitespace((value) => !value),
    onReload: isLive ? reloadByUser : undefined,
    onSwitchToFileView: isLive ? onSwitchToFileView : undefined,
    refreshing,
  };

  const chrome = (headerBody: Extract<BodyState, { kind: "body" }> | null) => (
    <>
      <DiffHeader {...headerProps} body={headerBody} />
      <DiffNavigationBar
        isMobile={isMobile}
        scopeChoices={scopeChoices}
        activeScope={liveResourceKey}
        onScopeChange={(resourceKey) => {
          if (!targetResourceKey) return;
          staging.dismiss();
          setActivePosition(null);
          setScopeChoice({ target: targetResourceKey, resourceKey });
        }}
        hunkCount={headerBody ? hunkCount : null}
        activePosition={position}
        file={
          headerBody && headerBody.files.length > 1 && activeHunk
            ? { index: activeHunk.fileIndex, count: headerBody.files.length }
            : null
        }
        onNavigate={runNavigation}
        feedback={staging.feedback}
        onDismissFeedback={staging.dismiss}
        onReload={isLive ? reloadByUser : undefined}
      />
    </>
  );

  // Live resolution failed for the current target.
  if (isLive && currentResolution && currentResolution.kind !== "identity") {
    const copy =
      currentResolution.kind === "unavailable"
        ? unavailableCopy(currentResolution.error, true, liveScope ?? undefined)
        : { title: "Failed to load diff", detail: currentResolution.message };
    return shell(
      <>
        {chrome(null)}
        {centered(
          <>
            <AlertCircle className="h-8 w-8 text-muted-foreground" />
            <p role="status" className="text-sm text-foreground">
              {copy.title}
            </p>
            <p className="text-xs text-muted-foreground">{copy.detail}</p>
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              Retry
            </Button>
          </>,
        )}
      </>,
    );
  }

  // The current body answer is an explicit unavailable or failed state. A
  // historical identity never falls back to reading today's file.
  if (bodyIsCurrent && body.kind !== "body") {
    const copy =
      body.kind === "unavailable"
        ? unavailableCopy(body.error, isLive, liveScope ?? undefined)
        : { title: "Failed to load diff", detail: body.message };
    return shell(
      <>
        {chrome(null)}
        {centered(
          <>
            <AlertCircle
              className={cn(
                "h-8 w-8",
                body.kind === "failed" ? "text-failure" : "text-muted-foreground",
              )}
            />
            <p
              role="status"
              className={cn("text-sm", body.kind === "failed" ? "text-failure" : "text-foreground")}
            >
              {copy.title}
            </p>
            <p className="text-xs text-muted-foreground">{copy.detail}</p>
            {(isLive || body.kind === "failed") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => (isLive ? reload() : setBodyRetry((count) => count + 1))}
              >
                Retry
              </Button>
            )}
          </>,
        )}
      </>,
    );
  }

  // Nothing to show yet: first resolve or first body still loading.
  if (!shownBody) {
    return shell(
      <>
        {chrome(null)}
        {centered(
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Loading diff...</p>
          </div>,
        )}
      </>,
    );
  }

  const singleFile = shownBody.identity.kind === "file" && shownBody.files.length <= 1;
  return shell(
    <>
      {chrome(shownBody)}
      <div ref={bodyRef} data-testid="diff-viewer-body" className="min-h-0 flex-1 overflow-auto">
        {shownBody.files.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">No file changes.</p>
        )}
        {shownBody.files.map((file, index) => {
          const { path, renamedFrom } = filePathLabel(file);
          return (
            <section
              key={`${file.pathId}:${index}`}
              aria-label={path ?? fallbackTitle}
              className="border-b border-border/40"
            >
              {!singleFile && (
                <div className="flex items-center gap-2 bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
                  <span className="shrink-0">{statusIcon(file.status)}</span>
                  <span className="min-w-0 truncate font-mono" title={path ?? undefined}>
                    {renamedFrom ? `${renamedFrom} → ${path}` : (path ?? fallbackTitle)}
                  </span>
                  <span className="shrink-0 opacity-70">{STATUS_TEXT[file.status]}</span>
                </div>
              )}
              <ChangeHunksView
                file={file}
                mode={effectiveMode}
                maxHeightClass="max-h-none"
                positionOffset={layout.fileStarts[index] ?? undefined}
                activeHunkIndex={activeHunk?.fileIndex === index ? activeHunk.hunkIndex : null}
                onSelectHunk={(hunkIndex) =>
                  setActivePosition((layout.fileStarts[index] ?? 0) + hunkIndex)
                }
                renderHunkActions={hunkActions(file, index)}
              />
            </section>
          );
        })}
        {shownBody.nextCursor && (
          <div className="flex flex-col items-center gap-1 px-3 py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={loadMore}
              disabled={shownBody.loadingMore}
            >
              {shownBody.loadingMore && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Load more files
            </Button>
            {shownBody.moreError && (
              <p role="alert" className="text-xs text-failure">
                {shownBody.moreError}
              </p>
            )}
          </div>
        )}
      </div>
    </>,
  );
}

// -----------------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------------

interface DiffHeaderProps {
  target: ChangeDiffTarget;
  fallbackTitle: string;
  body: Extract<BodyState, { kind: "body" }> | null;
  isMobile: boolean;
  diffMode: DiffMode;
  onDiffModeChange: (mode: DiffMode) => void;
  ignoreWhitespace: boolean;
  onToggleWhitespace: () => void;
  onReload?: () => void;
  onSwitchToFileView?: () => void;
  refreshing: boolean;
}

function DiffHeader({
  target,
  fallbackTitle,
  body,
  isMobile,
  diffMode,
  onDiffModeChange,
  ignoreWhitespace,
  onToggleWhitespace,
  onReload,
  onSwitchToFileView,
  refreshing,
}: DiffHeaderProps) {
  const isLive = target.kind === "live";
  const identity = body?.identity ?? null;
  const measurement = body?.measurement ?? null;
  const provenanceLabelKey = body?.provenanceLabelKey ?? null;
  const fileIdentity = identity?.kind === "file" ? identity : null;
  const firstFile = body?.files[0] ?? null;

  const { path, renamedFrom } = fileIdentity
    ? filePathLabel({
        oldPathDisplay: fileIdentity.basePathDisplay,
        newPathDisplay: fileIdentity.targetPathDisplay,
      })
    : { path: null, renamedFrom: null };
  const displayPath = path ?? fallbackTitle;
  const { directory, separator, filename } = splitPath(displayPath);
  const status: ChangeFileStatus | null = fileIdentity
    ? (firstFile?.status ??
      (fileIdentity.before.state === "absent"
        ? "added"
        : fileIdentity.after.state === "absent"
          ? "deleted"
          : "modified"))
    : null;

  const scopeKey = measurement?.scope ?? identity?.scope ?? null;
  const baseline = measurement?.baselineVersion ?? null;
  const beforeLabel = baseline ? formatBaselineVersion(baseline) : "Before";
  // The staged diff's after side is the index entry, not the working file.
  const afterLabel = isLive
    ? identity?.scope === "staged"
      ? "Staged version (index)"
      : "Current workspace file"
    : "After";
  // A live comparison is titled with its full baseline ("vs <commit>"), as the
  // Files panel names it; a historical one with both endpoints.
  const endpointTitle = isLive
    ? `${baseline ?? "Before"} → ${afterLabel}`
    : `${baseline ?? "Before"} → ${afterLabel}`;
  const unknownSide =
    fileIdentity?.before.state === "unknown"
      ? fileIdentity.before.reason
      : fileIdentity?.after.state === "unknown"
        ? fileIdentity.after.reason
        : null;
  const reasonTitle = measurement
    ? measurement.completeness.reasons.map((reason) => changeReason(`changes.reason.${reason}`))
    : [];
  const additions = measurement ? formatLineCount("+", measurement.totals.additions) : "";
  const deletions = measurement ? formatLineCount("-", measurement.totals.deletions) : "";
  const showFileCount = identity !== null && identity.kind !== "file";

  const toggleClass = (active: boolean) =>
    cn(
      "h-7 px-2",
      active &&
        "bg-primary/15 text-blue-300 ring-1 ring-inset ring-primary/50 hover:bg-primary/20 hover:text-blue-200",
    );

  return (
    <div
      data-testid="diff-viewer-header"
      className={cn(
        "flex items-center gap-2 border-b border-border bg-background py-2",
        isMobile ? "px-2" : "px-4",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">{statusIcon(status)}</span>
          <span className="relative min-w-0 flex-1 overflow-hidden font-mono" title={displayPath}>
            <span className="sr-only">
              {renamedFrom ? `${renamedFrom} renamed to ${displayPath}` : displayPath}
            </span>
            {/* On a phone the directory is dropped entirely: the basename is the only
                part that fits, and the full path is still on the title/sr-only node. */}
            <span aria-hidden="true" className="flex min-w-0 items-center gap-1">
              {renamedFrom && !isMobile && (
                <span className="min-w-0 shrink truncate opacity-60">{renamedFrom} →</span>
              )}
              <TruncatedPath
                directory={isMobile ? null : directory}
                separator={separator}
                filename={filename}
              />
            </span>
          </span>
          {status && (
            // Keep the status in the accessibility tree when the visual badge is hidden.
            <span
              className={cn(
                isMobile ? "sr-only" : "shrink-0 rounded px-1.5 py-0.5 text-xs",
                !isMobile && status === "added" && "bg-success/20 text-success",
                !isMobile && status === "modified" && "bg-yellow-500/20 text-yellow-400",
                !isMobile && status === "deleted" && "bg-failure/20 text-failure",
                !isMobile && status === "renamed" && "bg-blue-500/20 text-blue-300",
              )}
            >
              {STATUS_TEXT[status]}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-[11px]">
          {scopeKey && (
            <span
              data-testid="diff-viewer-scope"
              className="min-w-0 shrink truncate"
              title={provenanceLabelKey ? changeLabel(provenanceLabelKey) : undefined}
            >
              {changeLabel(`changes.scope.${scopeKey}`)}
            </span>
          )}
          <span
            data-testid="diff-viewer-endpoints"
            className={cn("min-w-0 truncate opacity-70", isMobile ? "max-w-[50vw]" : "shrink")}
            title={endpointTitle}
          >
            {isLive ? `vs ${beforeLabel} · ${afterLabel}` : `${beforeLabel} → ${afterLabel}`}
          </span>
          {measurement && (
            <span
              data-testid="diff-viewer-counts"
              className="shrink-0 font-mono"
              title={reasonTitle.length > 0 ? reasonTitle.join("\n") : undefined}
            >
              {showFileCount && (
                <span className="mr-1.5">{formatFileCount(measurement.totals.changedFiles)}</span>
              )}
              {additions && <span className="text-success">{additions}</span>}
              {additions && deletions && " "}
              {deletions && <span className="text-failure">{deletions}</span>}
            </span>
          )}
          {refreshing && (
            <Loader2 aria-label="Refreshing diff" className="h-3 w-3 shrink-0 animate-spin" />
          )}
        </div>
        {unknownSide && (
          <p role="note" className="text-[11px] opacity-80">
            One side of this comparison is unknown: {changeReason(`changes.reason.${unknownSide}`)}
          </p>
        )}
        {measurement?.completeness.reasons.includes(FILE_ROWS_CAPPED_REASON) && (
          <p role="note" className="text-[11px] opacity-80" data-testid="diff-viewer-files-capped">
            {changeReason(`changes.reason.${FILE_ROWS_CAPPED_REASON}`)}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* Split view is unusable on a phone, so the toggle is hidden there. */}
        {!isMobile && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className={toggleClass(diffMode === "split")}
              onClick={() => onDiffModeChange("split")}
              title="Side by side"
              aria-label="Side by side"
              aria-pressed={diffMode === "split"}
            >
              <Columns className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={toggleClass(diffMode === "unified")}
              onClick={() => onDiffModeChange("unified")}
              title="Inline"
              aria-label="Inline"
              aria-pressed={diffMode === "unified"}
            >
              <AlignJustify className="h-3.5 w-3.5" />
            </Button>
            <div className="mx-1 h-4 w-px bg-border" />
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className={cn(toggleClass(ignoreWhitespace), isMobile && "h-8")}
          onClick={onToggleWhitespace}
          title="Hide whitespace changes"
          aria-label="Hide whitespace changes"
          aria-pressed={ignoreWhitespace}
        >
          <span aria-hidden="true" className="font-mono text-[11px]">
            ␣
          </span>
        </Button>
        {onReload && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("px-2", isMobile ? "h-8" : "h-7")}
            onClick={onReload}
            title="Reload diff"
            aria-label="Reload diff"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        )}
        {onSwitchToFileView && status !== "deleted" && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("px-2", isMobile ? "h-8" : "h-7")}
            onClick={onSwitchToFileView}
            title="View file"
            aria-label="View file"
          >
            <FileText className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
