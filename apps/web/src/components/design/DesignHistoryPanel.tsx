import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Redo2, ShieldCheck, Undo2, X } from "lucide-react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import type {
  DesignCheckpointPreview as DesignCheckpoint,
  DesignFailure,
  DesignHistoryEntrySummary,
  DesignHistoryPage,
} from "@orkestrator/protocol/design-operations";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/format-relative-time";
import type { DesignProjection } from "@/stores/designStore";
import { designApi, failureOf } from "./design-client";
import type { DesignCanvasController } from "./design-controller";
import { DesignCheckpointPreview } from "./DesignCheckpointPreview";

const PAGE_SIZE = 20;
/** Backend page limit; a refresh re-reads what is loaded, never more. */
const MAX_REFRESH = 100;
const MAX_PREVIEW_FRAMES = 4;

export type DesignHistoryApi = Pick<typeof designApi, "history" | "checkpoint">;
type Side = "before" | "after";

const ACTORS: Record<DesignHistoryEntrySummary["actor"], string> = {
  user: "You",
  agent: "Agent",
  system: "System",
};

export function formatHistoryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sideRevision(entry: DesignHistoryEntrySummary, side: Side) {
  return side === "before" ? entry.canvasRevisionBefore : entry.canvasRevisionAfter;
}

function frameNames(entry: DesignHistoryEntrySummary) {
  if (!entry.frames.length) return "Design settings";
  const names = entry.frames.slice(0, 3).map((frame) => frame.name);
  const more = entry.frames.length - names.length;
  return more > 0 ? `${names.join(", ")} +${more}` : names.join(", ");
}

function failureText(failure: DesignFailure) {
  if (failure.code === "conflict") {
    const current = failure.revisions?.current;
    return `The design changed before this could be applied${current ? ` (now revision ${current})` : ""}. Review the latest history and try again.`;
  }
  if (failure.code === "history-ineligible")
    return `${failure.message}. Open the checkpoint instead.`;
  return failure.message;
}

interface Inspecting {
  entryId: string;
  mode: "preview" | "compare";
  side: Side;
}

export function DesignHistoryPanel({
  controller,
  projection,
  environmentId,
  canvasId,
  focusFrameId,
  onClose,
  onUseAsReference,
  api = designApi,
}: {
  controller: DesignCanvasController;
  projection: DesignProjection;
  environmentId: string;
  canvasId: string;
  /** Highlight and filter entries affecting this frame. */
  focusFrameId: string | null;
  onClose: () => void;
  onUseAsReference: (checkpointId: string) => void;
  /** Injected in tests (must be referentially stable); defaults to the design client. */
  api?: DesignHistoryApi;
}) {
  const [entries, setEntries] = useState<DesignHistoryEntrySummary[]>([]);
  const [page, setPage] = useState<Omit<DesignHistoryPage, "entries"> | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<DesignFailure | null>(null);
  const [filterFrame, setFilterFrame] = useState<string | null>(focusFrameId);
  const [inspecting, setInspecting] = useState<Inspecting | null>(null);
  const [checkpoint, setCheckpoint] = useState<DesignCheckpoint | null>(null);
  const [checkpointError, setCheckpointError] = useState<DesignFailure | null>(null);
  const [confirm, setConfirm] = useState<{ entry: DesignHistoryEntrySummary; side: Side } | null>(
    null,
  );
  const [submitted, setSubmitted] = useState<{ id: string; label: string } | null>(null);

  // Every list request carries the epoch it was issued in; a response from an
  // older epoch (newer refresh, other canvas, unmount) is ignored.
  const epoch = useRef(0);
  const loadedCount = useRef(0);
  const target = useRef({ environmentId, canvasId });
  target.current = { environmentId, canvasId };

  useEffect(() => setFilterFrame(focusFrameId), [focusFrameId]);

  useEffect(() => {
    // A different canvas starts a clean list.
    epoch.current++;
    loadedCount.current = 0;
    setEntries([]);
    setPage(null);
    setInspecting(null);
    setCheckpoint(null);
    setSubmitted(null);
  }, [environmentId, canvasId]);

  useEffect(() => {
    const requestEpoch = ++epoch.current;
    const limit = Math.min(MAX_REFRESH, Math.max(PAGE_SIZE, loadedCount.current));
    setLoading(true);
    // A refresh supersedes any in-flight "Load more".
    setLoadingMore(false);
    api.history(environmentId, canvasId, 0, limit).then(
      (result) => {
        if (requestEpoch !== epoch.current) return;
        if (target.current.environmentId !== environmentId || target.current.canvasId !== canvasId)
          return;
        loadedCount.current = result.entries.length;
        setEntries(result.entries);
        const { entries: _entries, ...meta } = result;
        setPage(meta);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (requestEpoch !== epoch.current) return;
        setError(failureOf(reason));
        setLoading(false);
      },
    );
  }, [api, environmentId, canvasId, projection.revision, projection.statusVersion]);

  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );

  const loadMore = useCallback(() => {
    const offset = page?.nextOffset;
    if (offset === undefined) return;
    const requestEpoch = epoch.current;
    setLoadingMore(true);
    api.history(environmentId, canvasId, offset, PAGE_SIZE).then(
      (result) => {
        if (requestEpoch !== epoch.current) return;
        setEntries((current) => {
          const seen = new Set(current.map((entry) => entry.id));
          const next = [...current, ...result.entries.filter((entry) => !seen.has(entry.id))];
          loadedCount.current = next.length;
          return next;
        });
        const { entries: _entries, ...meta } = result;
        setPage(meta);
        setLoadingMore(false);
      },
      (reason: unknown) => {
        if (requestEpoch !== epoch.current) return;
        setError(failureOf(reason));
        setLoadingMore(false);
      },
    );
  }, [api, canvasId, environmentId, page?.nextOffset]);

  // Checkpoint content is an explicit read for the entry being inspected.
  // Mode switches (preview/compare) reuse the loaded checkpoint.
  const inspectEntry = inspecting?.entryId;
  const inspectSide = inspecting?.side;
  useEffect(() => {
    if (!inspectEntry || !inspectSide) return;
    let active = true;
    setCheckpoint(null);
    setCheckpointError(null);
    api.checkpoint(environmentId, canvasId, inspectEntry, inspectSide).then(
      (result) => active && setCheckpoint(result),
      (reason: unknown) => active && setCheckpointError(failureOf(reason)),
    );
    return () => {
      active = false;
    };
  }, [api, canvasId, environmentId, inspectEntry, inspectSide]);

  const history = projection.workspace?.history;
  const canvasBusy = projection.intents.some(
    (intent) =>
      intent.phase !== "settled" &&
      ["undo", "redo", "restore_checkpoint"].includes(intent.descriptor.input.kind),
  );
  const submittedIntent = submitted
    ? projection.intents.find((intent) => intent.id === submitted.id)
    : undefined;

  const submitHistory = (kind: "undo" | "redo") => {
    const label = kind === "undo" ? history?.undoLabel : history?.redoLabel;
    const text = `${kind === "undo" ? "Undo" : "Redo"}${label ? ` ${label}` : ""}`;
    const id = controller.submit({
      descriptor: {
        input: { kind, scope: "own" },
        preconditions: { canvasRevision: projection.revision },
      },
      label: text,
      lane: "canvas",
    });
    setSubmitted({ id, label: text });
  };

  const restore = (entry: DesignHistoryEntrySummary, side: Side) => {
    const label = `Restore ${side === "before" ? "before" : "after"} “${entry.label}”`;
    const id = controller.submit({
      descriptor: {
        input: { kind: "restore_checkpoint", entryId: entry.id, side },
        preconditions: { canvasRevision: projection.revision },
      },
      label,
      lane: "canvas",
    });
    setSubmitted({ id, label });
  };

  /** Newest own edit: the one an ineligible undo would have reversed. */
  const undoEntry = entries.find(
    (candidate) => candidate.actor === "user" && !candidate.undone && candidate.kind !== "undo",
  );
  const openUndoCheckpoint = () => {
    if (!undoEntry) return;
    setFilterFrame(null);
    setInspecting({ entryId: undoEntry.id, mode: "compare", side: "before" });
  };

  const visible = filterFrame
    ? entries.filter((entry) => entry.frames.some((frame) => frame.frameId === filterFrame))
    : entries;
  const focusName =
    filterFrame &&
    (projection.canvas?.frames.find((frame) => frame.id === filterFrame)?.name ??
      entries.flatMap((entry) => entry.frames).find((frame) => frame.frameId === filterFrame)
        ?.name ??
      "this frame");
  const currentFrames = new Map<string, DesignFrame>(
    (projection.canvas?.frames ?? []).map((frame) => [frame.id, frame]),
  );

  return (
    <aside
      aria-label="Design history"
      className="flex w-80 max-w-full shrink-0 flex-col overflow-hidden border-l border-divider bg-background text-xs"
    >
      <header className="flex items-center justify-between border-b border-divider px-3 py-2">
        <h3 className="font-semibold">History</h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Close history"
          onClick={onClose}
        >
          <X className="size-3" />
        </Button>
      </header>

      <section
        aria-label="Undo and redo"
        className="grid gap-1.5 border-b border-divider px-3 py-2"
      >
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!history?.canUndo || canvasBusy}
            title={history?.undoLabel ? `Undo ${history.undoLabel}` : "Undo your last edit"}
            onClick={() => submitHistory("undo")}
          >
            <Undo2 className="size-3" />
            {history?.undoLabel ? `Undo ${history.undoLabel}` : "Undo"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!history?.canRedo || canvasBusy}
            title={history?.redoLabel ? `Redo ${history.redoLabel}` : "Redo"}
            onClick={() => submitHistory("redo")}
          >
            <Redo2 className="size-3" />
            {history?.redoLabel ? `Redo ${history.redoLabel}` : "Redo"}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Undo and redo apply to your own edits, not the agent's.
        </p>
        {history?.undoBlockedReason && (
          <div
            role="note"
            className="grid gap-1 rounded border border-amber-500/40 bg-amber-500/10 p-2"
          >
            <p>Undo is unavailable: {history.undoBlockedReason}</p>
            <Button
              variant="link"
              size="sm"
              className="h-auto justify-start p-0 text-xs"
              disabled={!undoEntry}
              onClick={openUndoCheckpoint}
            >
              Open the checkpoint instead
            </Button>
          </div>
        )}
        {history?.redoBlockedReason && (
          <p role="note" className="text-muted-foreground">
            Redo is unavailable: {history.redoBlockedReason}
          </p>
        )}
        {submitted && (
          <p
            role={submittedIntent?.failure ? "alert" : "status"}
            className={submittedIntent?.failure ? "text-destructive" : "text-muted-foreground"}
          >
            {submittedIntent?.failure
              ? `${submitted.label} failed: ${failureText(submittedIntent.failure)}`
              : submittedIntent?.outcome === "no-op"
                ? `${submitted.label} made no changes`
                : !submittedIntent || submittedIntent.phase === "settled"
                  ? `${submitted.label} applied`
                  : `${submitted.label}…`}
          </p>
        )}
      </section>

      {filterFrame && (
        <div className="flex items-center justify-between gap-2 border-b border-divider bg-elevated px-3 py-1.5">
          <span className="truncate">Showing changes to {focusName}</span>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => setFilterFrame(null)}
          >
            Show all
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div role="alert" className="grid gap-1 px-3 py-2 text-destructive">
            <p>History could not be loaded: {error.message}</p>
          </div>
        )}
        {loading && !entries.length && (
          <p className="flex items-center gap-1 px-3 py-2 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading history…
          </p>
        )}
        {!loading && !error && !visible.length && (
          <p className="px-3 py-2 text-muted-foreground">
            {filterFrame ? "No loaded history entries change this frame." : "No history yet."}
          </p>
        )}
        <ol className="divide-y divide-divider" aria-label="History entries">
          {visible.map((entry) => {
            const open = inspecting?.entryId === entry.id ? inspecting : null;
            const focused = Boolean(
              focusFrameId && entry.frames.some((frame) => frame.frameId === focusFrameId),
            );
            return (
              <li
                key={entry.id}
                data-entry-id={entry.id}
                data-focused={focused || undefined}
                className={`grid gap-1 px-3 py-2 ${focused ? "bg-primary/5" : ""} ${entry.undone ? "opacity-70" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-medium break-words">{entry.label}</span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      entry.actor === "user"
                        ? "bg-primary/15 text-primary"
                        : entry.actor === "agent"
                          ? "bg-violet-500/15 text-violet-600 dark:text-violet-300"
                          : "bg-muted text-muted-foreground"
                    }`}
                    data-actor={entry.actor}
                  >
                    {ACTORS[entry.actor]}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                  <time
                    dateTime={entry.createdAt}
                    title={new Date(entry.createdAt).toLocaleString()}
                  >
                    {formatRelativeTime(entry.createdAt)}
                  </time>
                  <span>
                    Revision {entry.canvasRevisionBefore} → {entry.canvasRevisionAfter}
                  </span>
                  <span
                    className="min-w-0 truncate"
                    title={entry.frames.map((frame) => frame.name).join(", ")}
                  >
                    {frameNames(entry)}
                  </span>
                  {entry.undone && <span className="font-medium">Undone</span>}
                  {entry.protected && (
                    <span
                      className="inline-flex items-center gap-0.5"
                      title="Recent entries are never pruned automatically"
                    >
                      <ShieldCheck className="size-3" /> Protected
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    aria-pressed={open?.mode === "preview"}
                    onClick={() =>
                      setInspecting(
                        open?.mode === "preview"
                          ? null
                          : { entryId: entry.id, mode: "preview", side: open?.side ?? "before" },
                      )
                    }
                  >
                    Preview
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    aria-pressed={open?.mode === "compare"}
                    onClick={() =>
                      setInspecting(
                        open?.mode === "compare"
                          ? null
                          : { entryId: entry.id, mode: "compare", side: open?.side ?? "before" },
                      )
                    }
                  >
                    Compare with current
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    disabled={canvasBusy || !projection.canvas}
                    onClick={() => setConfirm({ entry, side: "before" })}
                  >
                    Restore this version
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    onClick={() => onUseAsReference(entry.id)}
                  >
                    Use as implementation reference
                  </Button>
                </div>
                {open && (
                  <div
                    className="grid gap-2 rounded border border-divider p-2"
                    aria-label={`Version of ${entry.label}`}
                    role="region"
                  >
                    <div
                      className="flex flex-wrap items-center gap-1"
                      role="group"
                      aria-label="Checkpoint side"
                    >
                      {(["before", "after"] as const).map((side) => (
                        <Button
                          key={side}
                          variant={open.side === side ? "secondary" : "ghost"}
                          size="sm"
                          className="h-6 px-1.5 text-[11px]"
                          aria-pressed={open.side === side}
                          onClick={() => setInspecting({ ...open, side })}
                        >
                          {side === "before" ? "Before this edit" : "After this edit"}
                        </Button>
                      ))}
                    </div>
                    {checkpointError && (
                      <p role="alert" className="text-destructive">
                        {checkpointError.message}
                      </p>
                    )}
                    {!checkpoint && !checkpointError && (
                      <p className="flex items-center gap-1 text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" /> Loading checkpoint…
                      </p>
                    )}
                    {checkpoint?.entryId === entry.id && checkpoint.side === open.side && (
                      <>
                        {checkpoint.frames
                          .slice(0, MAX_PREVIEW_FRAMES)
                          .map(({ frameId, frame }) => {
                            const summary = entry.frames.find(
                              (candidate) => candidate.frameId === frameId,
                            );
                            const checkpointLabel = `Checkpoint · revision ${sideRevision(entry, open.side)}`;
                            return open.mode === "compare" ? (
                              <div
                                key={frameId}
                                className="grid grid-cols-2 gap-2"
                                data-compare-frame={frameId}
                              >
                                <DesignCheckpointPreview
                                  frame={frame}
                                  label={checkpointLabel}
                                  width={140}
                                />
                                <DesignCheckpointPreview
                                  frame={currentFrames.get(frameId) ?? null}
                                  label={`Current · revision ${projection.revision}`}
                                  width={140}
                                />
                              </div>
                            ) : (
                              <DesignCheckpointPreview
                                key={frameId}
                                frame={frame}
                                label={`${summary?.name ?? frame?.name ?? "Frame"} · revision ${sideRevision(entry, open.side)}`}
                                width={280}
                              />
                            );
                          })}
                        {checkpoint.frames.length > MAX_PREVIEW_FRAMES && (
                          <p className="text-muted-foreground">
                            {checkpoint.frames.length - MAX_PREVIEW_FRAMES} more frames are not
                            shown
                          </p>
                        )}
                        {!checkpoint.frames.length && (
                          <p className="text-muted-foreground">
                            This entry changed design settings only.
                          </p>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 justify-self-start text-xs"
                          disabled={canvasBusy || !projection.canvas}
                          onClick={() => setConfirm({ entry, side: open.side })}
                        >
                          Restore this version
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {page?.nextOffset !== undefined && (
          <div className="px-3 py-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full text-xs"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </div>

      {page && (
        <footer className="grid gap-1 border-t border-divider px-3 py-2 text-[11px] text-muted-foreground">
          <p>
            {page.total} of {page.limits.entries} entries · {formatHistoryBytes(page.bytes)} of{" "}
            {formatHistoryBytes(page.limits.bytes)}
          </p>
          <div
            className="h-1 overflow-hidden rounded bg-muted"
            role="meter"
            aria-label="History storage used"
            aria-valuemin={0}
            aria-valuemax={page.limits.bytes}
            aria-valuenow={page.bytes}
          >
            <div
              className="h-full bg-primary/60"
              style={{
                width: `${Math.min(100, (page.bytes / Math.max(1, page.limits.bytes)) * 100)}%`,
              }}
            />
          </div>
          <p>
            Older entries are removed automatically when these limits are reached. Protected entries
            (the most recent edits) are always kept so they can be undone or restored.
          </p>
        </footer>
      )}

      <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restore the version {confirm?.side === "after" ? "after" : "before"} “
              {confirm?.entry.label}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && (
                <>
                  {confirm.entry.frames.length
                    ? `This replaces ${confirm.entry.frames.map((frame) => frame.name).join(", ")} with the version from revision ${sideRevision(confirm.entry, confirm.side)}.`
                    : `This restores the design settings from revision ${sideRevision(confirm.entry, confirm.side)}.`}{" "}
                  Other frames are not changed. The restore is recorded as a new history entry, so
                  it can be undone. It applies only if the design is still at revision{" "}
                  {projection.revision}.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) restore(confirm.entry, confirm.side);
                setConfirm(null);
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
