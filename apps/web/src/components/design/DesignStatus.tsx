import { AlertTriangle, CheckCircle2, CloudOff, Loader2, Trash2 } from "lucide-react";
import type { DesignFailure } from "@orkestrator/protocol/design-operations";
import { Button } from "@/components/ui/button";
import type { DesignIntent, DesignProjection } from "@/stores/designStore";
import type { DesignCanvasController } from "./design-controller";

export type DesignSaveState = "loading" | "saving" | "saved" | "review" | "offline" | "stale";

export function saveStateOf(projection: DesignProjection | undefined): DesignSaveState {
  if (!projection || projection.snapshot === "absent" || projection.snapshot === "loading")
    return "loading";
  if (projection.intents.some(needsReview)) return "review";
  if (projection.connection !== "connected") return "offline";
  if (projection.intents.some((intent) => intent.phase !== "settled")) return "saving";
  if (projection.snapshot === "stale") return "stale";
  return "saved";
}

export function needsReview(intent: DesignIntent): boolean {
  return (
    Boolean(intent.restored && intent.phase !== "settled") ||
    Boolean(intent.held) ||
    Boolean(intent.blocked) ||
    (intent.phase === "settled" && intent.outcome !== "committed" && intent.outcome !== "no-op") ||
    (intent.phase === "admitted" && intent.outcome === "unknown")
  );
}

function retryable(failure: DesignFailure | undefined) {
  if (!failure) return false;
  return ["capacity", "renderer-unavailable", "deadline", "disconnected", "storage"].includes(
    failure.code,
  );
}

/** Never sent: a held token or a restored draft/prepared edit waiting for an explicit Resume. */
function awaitingResume(intent: DesignIntent) {
  if (intent.held) return true;
  return (
    Boolean(intent.restored) &&
    !intent.failure &&
    (intent.phase === "draft" || intent.phase === "preparing" || intent.phase === "prepared")
  );
}

/** A token whose outcome is unknown: it is checked again, never sent as a new edit. */
function unresolved(intent: DesignIntent) {
  return Boolean(intent.token) && intent.outcome === "unknown";
}

function reviewMessage(intent: DesignIntent) {
  if (intent.blocked) return "waiting for the edit before it";
  if (intent.held) return "could not be saved in this window; not sent yet";
  if (awaitingResume(intent)) return "not sent before the app closed";
  if (intent.outcome === "executing") return "still running in the workspace";
  if (intent.outcome === "unknown" || intent.phase === "admitted" || intent.phase === "submitting")
    return "outcome unknown; checking the backend";
  return intent.failure?.message ?? "not applied";
}

function geometryOnly(intent: DesignIntent) {
  return intent.descriptor.input.kind === "update_frame";
}

/** Operation-specific recovery: Retry, Apply to current, Reselect, Discard, Cancel. */
export function DesignReviewList({
  projection,
  controller,
  onReselect,
}: {
  projection: DesignProjection;
  controller: DesignCanvasController;
  onReselect: (intent: DesignIntent) => void;
}) {
  const items = projection.intents.filter(needsReview);
  if (!items.length) return null;
  return (
    <section
      aria-label="Edits needing review"
      className="max-h-40 overflow-y-auto border-b border-divider bg-amber-500/5 px-3 py-2 text-xs"
    >
      <h3 className="mb-1 flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3.5" />{" "}
        {items.length === 1 ? "1 edit needs review" : `${items.length} edits need review`}
      </h3>
      <ul className="space-y-1.5">
        {items.map((intent) => {
          const frameExists = projection.canvas?.frames.some((frame) => frame.id === intent.lane);
          const conflict = intent.failure?.code === "conflict";
          const current = projection.canvas?.frames.find((frame) => frame.id === intent.lane);
          return (
            <li key={intent.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{intent.label}</span>
                <span className="text-muted-foreground">
                  {" — "}
                  {reviewMessage(intent)}
                </span>
              </span>
              {awaitingResume(intent) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  onClick={() => controller.resume(intent.id)}
                >
                  {intent.held ? "Resume" : "Resume draft"}
                </Button>
              )}
              {intent.phase === "settled" && unresolved(intent) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  onClick={() => controller.resume(intent.id)}
                >
                  Check again
                </Button>
              )}
              {retryable(intent.failure) && !unresolved(intent) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  onClick={() => controller.resume(intent.id)}
                >
                  Retry
                </Button>
              )}
              {conflict && geometryOnly(intent) && current && frameExists && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  onClick={() => controller.resume(intent.id, { frameRevision: current.revision })}
                >
                  Apply to current frame
                </Button>
              )}
              {conflict && !geometryOnly(intent) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  onClick={() => onReselect(intent)}
                >
                  Reselect
                </Button>
              )}
              {intent.phase === "prepared" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => void controller.cancelQueued(intent.id)}
                >
                  Cancel queued edit
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => void controller.discard(intent.id)}
              >
                Discard draft
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function DesignSaveIndicator({ projection }: { projection: DesignProjection | undefined }) {
  const state = saveStateOf(projection);
  const pending = projection?.intents.filter((intent) => intent.phase !== "settled").length ?? 0;
  const labels: Record<DesignSaveState, string> = {
    loading: "Loading design…",
    saving: pending > 1 ? `Saving ${pending} edits in workspace…` : "Saving in workspace…",
    saved: "Saved in workspace",
    review: "Needs review",
    offline: "Offline — edits are kept",
    stale: "Checking for changes…",
  };
  const icon =
    state === "saved" ? (
      <CheckCircle2 className="size-3 text-emerald-500" />
    ) : state === "saving" || state === "loading" || state === "stale" ? (
      <Loader2 className="size-3 animate-spin" />
    ) : state === "offline" ? (
      <CloudOff className="size-3" />
    ) : (
      <AlertTriangle className="size-3 text-amber-500" />
    );
  return (
    <span className="flex items-center gap-1" data-save-state={state}>
      {icon}
      {labels[state]}
    </span>
  );
}

export function DesignExportIndicator({
  projection,
}: {
  projection: DesignProjection | undefined;
}) {
  const association = projection?.workspace?.export;
  const pending = projection?.workspace?.pendingExport;
  if (pending?.state === "unknown")
    return <span className="text-amber-600">Export to {pending.relativePath} unconfirmed</span>;
  if (pending?.state === "writing") return <span>Exporting revision {pending.revision}…</span>;
  if (!association) return null;
  const outdated = association.lastExportedRevision !== projection?.revision;
  return (
    <span title={`Exported ${new Date(association.exportedAt).toLocaleString()}`}>
      Exported revision {association.lastExportedRevision} to {association.relativePath}
      {outdated ? " · newer workspace changes" : ""}
    </span>
  );
}

export function DesignUnavailablePanel({
  projection,
  onClose,
  onRestore,
  onRecoveryCopy,
}: {
  projection: DesignProjection;
  onClose?: () => void;
  onRestore?: () => void;
  onRecoveryCopy?: () => void;
}) {
  const deleted = projection.snapshot === "deleted";
  const invalid = projection.snapshot === "invalid";
  return (
    <div role="alert" className="grid flex-1 place-content-center gap-3 p-8 text-center">
      <Trash2 className="mx-auto size-8 text-muted-foreground" />
      <h2 className="text-base font-semibold">
        {deleted
          ? `“${projection.tombstone?.name ?? "This design"}” was deleted`
          : invalid
            ? "This design needs recovery"
            : "This design is no longer available"}
      </h2>
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">
        {deleted
          ? "It is in the recycle bin. Restore it to keep editing; nothing else changes until you do."
          : invalid
            ? (projection.problem?.message ?? "The saved workspace record could not be read.")
            : "It may have been purged or belongs to an environment that was removed."}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {deleted && projection.tombstone?.restorable && onRestore && (
          <Button size="sm" onClick={onRestore}>
            Restore design
          </Button>
        )}
        {projection.canvas && onRecoveryCopy && (
          <Button size="sm" variant="outline" onClick={onRecoveryCopy}>
            Save recovery copy (revision {projection.canvas.revision})
          </Button>
        )}
        {onClose && (
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close tab
          </Button>
        )}
      </div>
    </div>
  );
}

export function DesignConnectionBanner({
  projection,
  onRetry,
}: {
  projection: DesignProjection;
  onRetry: () => void;
}) {
  if (projection.connection === "connected" && !projection.readError) return null;
  const message =
    projection.connection === "unauthorized"
      ? "Sign in again to keep editing. Your edits are kept."
      : projection.connection !== "connected"
        ? "The backend is unreachable. Showing the last known version; edits are kept and sent when it reconnects."
        : projection.readError?.message;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-divider bg-muted/60 px-3 py-1.5 text-xs"
    >
      <CloudOff className="size-3.5 shrink-0" />
      <span className="flex-1">{message}</span>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onRetry}>
        Retry now
      </Button>
    </div>
  );
}
