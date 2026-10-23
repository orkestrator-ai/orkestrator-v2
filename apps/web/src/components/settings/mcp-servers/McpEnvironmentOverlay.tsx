import { useEffect, useRef, useState } from "react";
import { Download, Loader2, RotateCcw, Undo2, Upload } from "lucide-react";
import { toast } from "sonner";

import {
  isUnknownMcpManagementCommandError,
  type McpConfigSource,
  type McpDefaultsRefreshPreview,
  type McpEnvironmentOverlayState,
  type McpManagementSnapshot,
  type McpOverlayAction,
} from "@orkestrator/protocol/mcp-management";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";

import { McpErrorNotice, mcpProblemFrom, type McpProblem } from "./McpErrorNotice";
import { writeBlockedReason } from "./mcp-rollout";

const STATE_TEXT: Record<McpEnvironmentOverlayState["state"], string> = {
  "in-sync": "Applied in the container",
  pending: "Not in the container yet",
  diverged: "Edited inside the container",
  conflict: "Needs a decision",
};

const STATE_TONE: Record<McpEnvironmentOverlayState["state"], string> = {
  "in-sync": "border-emerald-500/30 text-emerald-300",
  pending: "border-amber-500/30 text-amber-300",
  diverged: "border-amber-500/30 text-amber-300",
  conflict: "border-amber-500/30 text-amber-300",
};

const UNSUPPORTED_BACKEND =
  "This backend cannot manage environment changes yet. Update the backend to use this action.";

function problemFrom(error: unknown): McpProblem {
  if (isUnknownMcpManagementCommandError(error)) return { message: UNSUPPORTED_BACKEND };
  return mcpProblemFrom(error);
}

function successText(action: McpOverlayAction): string {
  switch (action.kind) {
    case "import":
      return "Imported the container's edits";
    case "reapply":
      return "Reapplied this environment's changes";
    case "keep-environment":
      return `Kept this environment's version of ${action.name}`;
    case "take-inherited":
      return `Using the inherited ${action.name}`;
    case "reset":
      return "Restored the inherited servers";
  }
}

/** Whether a source carries this environment's own (overlay) configuration. */
export function isEnvironmentPrivateSource(source: McpConfigSource): boolean {
  return source.scope === "environment-private";
}

/** Why overlay actions are unavailable on this target right now, if they are. */
function blockedReason(snapshot: McpManagementSnapshot): string | null {
  return snapshot.target.readOnlyReason ?? writeBlockedReason(snapshot.target.capabilities) ?? null;
}

function NameList({ label, names }: { label: string; names: string[] }) {
  if (!names.length) return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-foreground">{names.join(", ")}</dd>
    </>
  );
}

/**
 * This environment's own changes to one container source, and what keeps
 * them in the container. Everything shown comes from the snapshot's
 * `overlay`; the only local state is the request in flight and its error,
 * and every action ends by re-reading the snapshot.
 */
export function McpEnvironmentSourceControls({
  snapshot,
  source,
  onReload,
}: {
  snapshot: McpManagementSnapshot;
  source: McpConfigSource;
  onReload: () => void;
}) {
  const overlay = source.overlay;
  const container = snapshot.target.context.location === "container";
  const blocked = blockedReason(snapshot);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<McpProblem | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const refreshTrigger = useRef<HTMLButtonElement | null>(null);
  const resetTrigger = useRef<HTMLButtonElement | null>(null);

  const refreshable = container && isEnvironmentPrivateSource(source);
  if (!overlay && !refreshable) return null;

  const run = async (action: McpOverlayAction, key: string) => {
    setBusy(key);
    setProblem(null);
    try {
      await backend.resolveMcpEnvironmentOverlay({
        targetId: snapshot.target.targetId,
        sourceId: source.sourceId,
        expectedRevision: source.revision,
        action,
      });
      toast.success(successText(action));
    } catch (error) {
      setProblem(problemFrom(error));
    } finally {
      setBusy(null);
      onReload();
    }
  };

  const disabled = busy !== null || !!blocked;
  const actionButton = (
    action: McpOverlayAction,
    label: string,
    icon: React.ReactNode,
    ariaLabel?: string,
  ) => {
    const key =
      action.kind === "keep-environment" || action.kind === "take-inherited"
        ? `${action.kind}:${action.name}`
        : action.kind;
    return (
      <Button
        key={key}
        type="button"
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-xs"
        disabled={disabled}
        title={blocked ?? undefined}
        aria-label={ariaLabel}
        onClick={() => void run(action, key)}
      >
        {busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : icon}
        {label}
      </Button>
    );
  };

  return (
    <div
      role="group"
      className="mt-1.5 space-y-2"
      aria-label={`${source.label}: this environment's changes`}
    >
      {overlay ? (
        <div className="space-y-1.5 rounded-md border border-white/10 bg-zinc-950/40 px-2.5 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground">This environment's changes</span>
            <span
              className={cn("rounded border px-1.5 py-0.5 text-[11px]", STATE_TONE[overlay.state])}
            >
              {STATE_TEXT[overlay.state]}
            </span>
          </div>
          {overlay.added.length || overlay.replaced.length || overlay.removed.length ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
              <NameList label="Added" names={overlay.added} />
              <NameList label="Replaced" names={overlay.replaced} />
              <NameList label="Removed" names={overlay.removed} />
            </dl>
          ) : (
            <p className="text-muted-foreground">No servers differ from the inherited ones.</p>
          )}
          {overlay.state === "pending" ? (
            <p className="text-amber-300">
              The container restarted outside Orkestrator and holds the inherited servers again.
              Reapply to write this environment's changes back.
            </p>
          ) : null}
          {overlay.state === "diverged" ? (
            <p className="text-amber-300">
              The file was edited inside the container
              {overlay.divergedNames.length ? (
                <>
                  {" "}
                  (<span className="break-all font-mono">{overlay.divergedNames.join(", ")}</span>)
                </>
              ) : null}
              . Changes here are blocked until you import those edits or reapply this environment's
              changes over them.
            </p>
          ) : null}
          {overlay.state === "conflict" && overlay.conflicts.length ? (
            <ul className="space-y-1.5" aria-label="Conflicting servers">
              {overlay.conflicts.map((conflict) => (
                <li key={conflict.name} className="space-y-1">
                  <p className="text-amber-300">
                    <span className="break-all font-mono text-foreground">{conflict.name}</span>:{" "}
                    {conflict.reason}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {actionButton(
                      { kind: "keep-environment", name: conflict.name },
                      "Keep this environment's version",
                      null,
                      `Keep this environment's version of ${conflict.name}`,
                    )}
                    {actionButton(
                      { kind: "take-inherited", name: conflict.name },
                      "Use the inherited one",
                      null,
                      `Use the inherited ${conflict.name}`,
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {overlay.state === "diverged"
              ? actionButton(
                  { kind: "import" },
                  "Import container edits",
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />,
                )
              : null}
            {overlay.state === "diverged" || overlay.state === "pending"
              ? actionButton(
                  { kind: "reapply" },
                  "Reapply this environment's changes",
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />,
                )
              : null}
            <Button
              ref={resetTrigger}
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              disabled={disabled}
              title={blocked ?? undefined}
              onClick={() => setConfirmReset(true)}
            >
              {busy === "reset" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Reset to inherited…
            </Button>
          </div>
        </div>
      ) : null}
      {refreshable ? (
        <Button
          ref={refreshTrigger}
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          disabled={disabled}
          title={blocked ?? undefined}
          onClick={() => setRefreshOpen(true)}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Refresh from backend user…
        </Button>
      ) : null}
      {problem ? <McpErrorNotice problem={problem} /> : null}

      <AlertDialog open={confirmReset} onOpenChange={(next) => !next && setConfirmReset(false)}>
        <AlertDialogContent
          className={Z_FULLSCREEN_DIALOG}
          overlayClassName={Z_FULLSCREEN_DIALOG}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            resetTrigger.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to the inherited servers?</AlertDialogTitle>
            <AlertDialogDescription>
              Every change this environment made to {source.label} is dropped, including edits made
              inside the container, and the servers it inherited are restored. Nothing else in the
              file changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmReset(false)}>
              Keep changes
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmReset(false);
                void run({ kind: "reset" }, "reset");
              }}
            >
              Reset
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {refreshOpen ? (
        <McpDefaultsRefreshDialog
          snapshot={snapshot}
          source={source}
          onReload={onReload}
          onClose={() => setRefreshOpen(false)}
          onRestoreFocus={() => refreshTrigger.current?.focus()}
        />
      ) : null}
    </div>
  );
}

/**
 * Preview, then apply, a re-import of the backend user's servers into one
 * container source. The preview token binds the refresh to exactly the files
 * the preview read; a stale one is refused and the preview is taken again.
 */
export function McpDefaultsRefreshDialog({
  snapshot,
  source,
  onClose,
  onReload,
  onRestoreFocus,
}: {
  snapshot: McpManagementSnapshot;
  source: McpConfigSource;
  onClose: () => void;
  onReload: () => void;
  onRestoreFocus?: () => void;
}) {
  const [preview, setPreview] = useState<McpDefaultsRefreshPreview | null>(null);
  const [problem, setProblem] = useState<McpProblem | null>(null);
  // A failed refresh drops its preview: the token may be stale, so the only
  // way forward is a fresh preview.
  const [failedRefresh, setFailedRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const targetId = snapshot.target.targetId;
  const sourceId = source.sourceId;

  const loadPreview = async () => {
    setBusy(true);
    setProblem(null);
    setFailedRefresh(false);
    setPreview(null);
    try {
      setPreview(await backend.previewMcpEnvironmentDefaults({ targetId, sourceId }));
    } catch (error) {
      setProblem(problemFrom(error));
      onReload();
    } finally {
      setBusy(false);
    }
  };

  // Once per opened dialog: `loadPreview` has a new identity every render.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    void loadPreview();
  }, []);
  /* oxlint-enable react-hooks/exhaustive-deps */

  const refresh = async () => {
    if (!preview) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await backend.refreshMcpEnvironmentDefaults({
        targetId,
        sourceId,
        previewToken: preview.previewToken,
      });
      if (result.stagedCopy === "unavailable")
        toast.warning(
          "Refreshed. The copy a rebuild starts from could not be updated, so refresh again after the next rebuild.",
        );
      else toast.success("Refreshed from the backend user");
      onReload();
      onClose();
    } catch (error) {
      setPreview(null);
      setFailedRefresh(true);
      setProblem(problemFrom(error));
      onReload();
    } finally {
      setBusy(false);
    }
  };

  const hasChanges = !!preview && !preview.unchanged;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className={cn("sm:max-w-xl", Z_FULLSCREEN_DIALOG)}
        overlayClassName={Z_FULLSCREEN_DIALOG}
        onCloseAutoFocus={(event) => {
          if (!onRestoreFocus) return;
          event.preventDefault();
          onRestoreFocus();
        }}
        onEscapeKeyDown={(event) => {
          // Close this dialog only, not the settings page behind it.
          event.preventDefault();
          if (!busy) onClose();
        }}
      >
        <DialogHeader>
          <DialogTitle>Refresh from backend user</DialogTitle>
          <DialogDescription>
            Re-import the backend user's current servers into {source.label} for{" "}
            {snapshot.target.context.locationLabel}. This environment's own changes are kept.
          </DialogDescription>
        </DialogHeader>
        {busy && !preview ? (
          <div
            className="flex justify-center py-4"
            role="status"
            aria-label="Checking what would change"
          >
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {preview ? (
          preview.unchanged ? (
            <p className="rounded-md border border-white/10 bg-zinc-900/45 p-3 text-sm text-muted-foreground">
              Nothing to refresh: this environment already has the backend user's current servers.
            </p>
          ) : (
            <div
              className="space-y-3 rounded-md border border-white/10 bg-zinc-900/45 p-3 text-sm"
              aria-label="Refresh preview"
            >
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
                <NameList label="Added" names={preview.added} />
                <NameList label="Changed" names={preview.changed} />
                <NameList label="Removed" names={preview.removed} />
                <NameList label="Edited in the container" names={preview.diverged} />
              </dl>
              {preview.conflicts.length ? (
                <div className="space-y-1 text-xs">
                  <p className="text-amber-300">Conflicts with this environment's changes:</p>
                  <ul className="space-y-0.5 pl-1">
                    {preview.conflicts.map((conflict) => (
                      <li key={conflict.name}>
                        <span className="break-all font-mono text-foreground">{conflict.name}</span>
                        <span className="text-muted-foreground">: {conflict.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.warnings.length ? (
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )
        ) : null}
        {problem ? (
          <McpErrorNotice problem={problem}>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadPreview()}>
              {failedRefresh ? "Preview again" : "Try again"}
            </Button>
          </McpErrorNotice>
        ) : null}
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {hasChanges ? "Cancel" : "Done"}
          </Button>
          {hasChanges ? (
            <Button disabled={busy} onClick={() => void refresh()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Refresh
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
