import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type {
  DesignExportPreview,
  DesignExportReceipt,
  DesignExportTarget,
  DesignFailure,
} from "@orkestrator/protocol/design-operations";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { DesignProjection } from "@/stores/designStore";
import { designApi, failureOf } from "./design-client";
import type { DesignCanvasController } from "./design-controller";

/** Mirrors the backend rule: a repository-root file name ending in `.orkdes`. */
export const DESIGN_EXPORT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.orkdes$/;
const PREVIEW_DEBOUNCE_MS = 300;

export type DesignExportApi = Pick<typeof designApi, "exportPreview" | "exportReconcile">;

const COLLISIONS: Record<NonNullable<DesignExportTarget["reason"]>, string> = {
  "other-canvas": "already contains a different design. Replacing it would overwrite that design.",
  "not-design":
    "already exists and is not a design file. Replacing it would overwrite its contents.",
  unreadable: "already exists but could not be read, so Orkestrator cannot tell what it contains.",
  "changed-since-export":
    "holds this design, but it was changed after your last export (edited outside Orkestrator or exported elsewhere).",
  "same-canvas": "is your previous export of this design.",
};

const RECONCILE: Record<string, string> = {
  "not-exported": "The export was not written. You can export again.",
  unavailable: "The repository is not reachable right now. Check again later.",
  none: "There is no unconfirmed export to check.",
};

export function DesignExportDialog({
  open,
  onOpenChange,
  controller,
  projection,
  api = designApi,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: DesignCanvasController;
  projection: DesignProjection;
  /** Injected in tests (must be referentially stable); defaults to the design client. */
  api?: DesignExportApi;
}) {
  const { environmentId, canvasId } = projection;
  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const [preview, setPreview] = useState<DesignExportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<DesignFailure | null>(null);
  const [replace, setReplace] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [waitNotice, setWaitNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<DesignExportReceipt | null>(null);
  const [failure, setFailure] = useState<DesignFailure | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNotice, setCheckNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // `preview`: each preview request records its sequence; responses from an
  // older request (renamed, closed, other canvas) are ignored. `session`:
  // bumped on open/close so an export, wait or check that outlives the dialog
  // session never writes into a later one.
  const epochs = useRef({ preview: 0, session: 0 });
  const shown = useRef<DesignExportTarget | null>(null);

  const runPreview = useCallback(
    (path?: string) => {
      const id = ++epochs.current.preview;
      setPreviewing(true);
      setPreviewError(null);
      api.exportPreview(environmentId, canvasId, path).then(
        (result) => {
          if (id !== epochs.current.preview) return;
          const previous = shown.current;
          if (
            !previous ||
            previous.relativePath !== result.target.relativePath ||
            previous.fingerprint !== result.target.fingerprint
          ) {
            // A different target needs its own explicit decision.
            setReplace(false);
            setConfirmed(false);
          }
          shown.current = result.target;
          if (path === undefined) setName(result.target.relativePath);
          setPreview(result);
          setPreviewing(false);
        },
        (reason: unknown) => {
          if (id !== epochs.current.preview) return;
          shown.current = null;
          setPreview(null);
          setPreviewError(failureOf(reason));
          setPreviewing(false);
        },
      );
    },
    [api, canvasId, environmentId],
  );

  // Open: preview the remembered association or the suggested default name.
  useEffect(() => {
    if (!open) return;
    epochs.current.session++;
    shown.current = null;
    setName("");
    setEdited(false);
    setPreview(null);
    setReplace(false);
    setConfirmed(false);
    setWaiting(false);
    setWaitNotice(null);
    setReceipt(null);
    setFailure(null);
    setChecking(false);
    setCheckNotice(null);
    runPreview();
    const current = epochs.current;
    return () => {
      current.preview++;
      current.session++;
    };
  }, [open, runPreview]);

  const valid = DESIGN_EXPORT_NAME.test(name);

  // Re-preview an edited name after a pause.
  useEffect(() => {
    if (!open || !edited || !valid) return;
    const timer = setTimeout(() => runPreview(name), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [edited, name, open, runPreview, valid]);

  // A newly committed revision changes what would be exported: re-read it.
  // Only a revision change triggers this; name edits re-preview above.
  const committedRevision = projection.revision;
  const previewedPath = preview?.target.relativePath;
  const previewedRevision = preview?.revision;
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!open || !previewedPath || previewedRevision === undefined) return;
    if (previewedRevision >= committedRevision) return;
    runPreview(previewedPath);
  }, [committedRevision]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  const rename = (value: string) => {
    epochs.current.preview++;
    shown.current = null;
    setName(value);
    setEdited(true);
    setPreview(null);
    setPreviewing(DESIGN_EXPORT_NAME.test(value));
    setPreviewError(null);
    setReplace(false);
    setConfirmed(false);
    setFailure(null);
  };

  const pending = projection.workspace?.pendingExport;
  const unsettled = projection.intents.filter((intent) => intent.phase !== "settled").length;
  const exporting = projection.busy.export;
  const target = preview?.target;
  const collision = Boolean(target?.needsReplaceConfirmation);
  const replaceable = Boolean(target?.fingerprint);
  const blockedByPending = pending?.state === "unknown" || pending?.state === "writing";
  const canExport =
    Boolean(preview && target && valid && target.relativePath === name) &&
    !previewing &&
    !exporting &&
    !waiting &&
    !checking &&
    !blockedByPending &&
    (!collision || (replace && confirmed && replaceable));

  const doExport = async () => {
    if (!preview || !target || !canExport) return;
    const id = epochs.current.session;
    setFailure(null);
    setReceipt(null);
    try {
      const result = await controller.exportSave(
        target.relativePath,
        preview.revision,
        target.exists ? target.fingerprint : undefined,
      );
      if (id === epochs.current.session) setReceipt(result);
    } catch (error) {
      if (id !== epochs.current.session) return;
      const next = failureOf(error);
      setFailure(next);
      // The file or the design changed after the preview: show the new state.
      if (next.code === "export-collision" || next.code === "conflict")
        runPreview(target.relativePath);
    }
  };

  const waitForEdits = async () => {
    const id = epochs.current.session;
    setWaiting(true);
    setWaitNotice(null);
    const settled = await controller.settleEdits();
    if (id !== epochs.current.session) return;
    setWaiting(false);
    if (!settled)
      setWaitNotice("Some edits are still pending or need review; they are not included.");
    if (valid) runPreview(name);
  };

  const checkExport = async () => {
    const id = epochs.current.session;
    setChecking(true);
    setCheckNotice(null);
    try {
      const result = await api.exportReconcile(environmentId, canvasId);
      if (id !== epochs.current.session) return;
      if (result.state === "exported" && result.receipt) setReceipt(result.receipt);
      else setCheckNotice(RECONCILE[result.state] ?? "The export state could not be determined.");
    } catch (error) {
      if (id === epochs.current.session) setCheckNotice(failureOf(error).message);
    } finally {
      if (id === epochs.current.session) setChecking(false);
      void controller.refresh();
    }
  };

  const revision = preview?.revision;
  const association = preview?.association;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export design to repository</DialogTitle>
          <DialogDescription>
            Writes a portable .orkdes copy of one committed revision into the repository root. Your
            workspace copy is saved automatically; the exported file is separate and can be
            committed with your code.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 text-sm">
          {pending?.state === "unknown" && (
            <div
              role="alert"
              className="grid gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2"
            >
              <p>
                The export of revision {pending.revision} to {pending.relativePath} did not confirm.
                It may or may not have been written. Check it before exporting again.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                disabled={checking}
                onClick={() => void checkExport()}
              >
                {checking && <Loader2 className="size-3 animate-spin" />}
                Check export
              </Button>
            </div>
          )}
          {pending?.state === "writing" && (
            <p role="status" className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Exporting revision {pending.revision} to{" "}
              {pending.relativePath}…
            </p>
          )}
          {pending?.state === "failed" && pending.failure && (
            <p role="alert" className="text-destructive">
              The last export failed: {pending.failure.message}
            </p>
          )}
          {checkNotice && <p role="status">{checkNotice}</p>}

          <div className="grid gap-1">
            <label htmlFor="design-export-name" className="text-xs font-medium">
              File name
            </label>
            <Input
              id="design-export-name"
              ref={input}
              value={name}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={Boolean(name) && !valid}
              aria-describedby="design-export-name-help"
              disabled={exporting}
              onChange={(event) => rename(event.target.value)}
            />
            <p id="design-export-name-help" className="text-xs text-muted-foreground">
              Saved in the repository root. Use letters, numbers, dots, dashes or underscores,
              ending in .orkdes; folders are not supported.
            </p>
            {name && !valid && (
              <p role="alert" className="text-xs text-destructive">
                “{name}” is not a valid file name. It must start with a letter or number and end in
                .orkdes.
              </p>
            )}
          </div>

          {previewing && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Checking {name || "the repository"}…
            </p>
          )}
          {previewError && (
            <p role="alert" className="text-xs text-destructive">
              {previewError.message}
            </p>
          )}

          {target && !previewing && (
            <div
              className="grid gap-2 rounded border border-divider p-2 text-xs"
              data-target-state={target.reason ?? (target.exists ? "exists" : "new")}
            >
              {!target.exists && <p>New file: {target.relativePath} will be created.</p>}
              {target.exists && !collision && (
                <p>
                  {target.relativePath} is your previous export of this design
                  {association ? ` (revision ${association.lastExportedRevision})` : ""}. It is safe
                  to update.
                </p>
              )}
              {collision && (
                <>
                  <p className="flex gap-1">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-500" />
                    <span>
                      {target.relativePath} {COLLISIONS[target.reason ?? "not-design"]}
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setReplace(false);
                        setConfirmed(false);
                        input.current?.focus();
                        input.current?.setSelectionRange(
                          0,
                          Math.max(0, name.length - ".orkdes".length),
                        );
                      }}
                    >
                      Choose a new name
                    </Button>
                    <Button
                      variant={replace ? "secondary" : "outline"}
                      size="sm"
                      aria-pressed={replace}
                      disabled={!replaceable}
                      onClick={() => setReplace(true)}
                    >
                      Replace it
                    </Button>
                  </div>
                  {!replaceable && (
                    <p>This file cannot be replaced from here; choose a new name.</p>
                  )}
                  {replace && replaceable && (
                    <label className="flex items-start gap-2">
                      <Checkbox
                        checked={confirmed}
                        onCheckedChange={(value) => setConfirmed(value === true)}
                        aria-label={`Confirm replacing ${target.relativePath}`}
                      />
                      <span>
                        I understand {target.relativePath} will be overwritten. It is replaced only
                        if it has not changed since this check.
                      </span>
                    </label>
                  )}
                </>
              )}
            </div>
          )}

          {revision !== undefined && (
            <p className="text-xs" data-export-revision={revision}>
              Exports committed revision {revision}.
            </p>
          )}
          {unsettled > 0 && revision !== undefined && (
            <p role="note" className="text-xs text-amber-600">
              {unsettled === 1 ? "1 edit is" : `${unsettled} edits are`} not committed yet and{" "}
              {unsettled === 1 ? "is" : "are"} not part of revision {revision}.
            </p>
          )}
          {waitNotice && <p className="text-xs text-amber-600">{waitNotice}</p>}

          {failure && (
            <p role="alert" className="text-xs text-destructive">
              {failure.code === "export-collision"
                ? `${failure.message}. The file changed since it was checked; review it again.`
                : failure.code === "conflict"
                  ? "The design changed before the export started. Review the new revision and export again."
                  : failure.message}
            </p>
          )}
          {receipt && (
            <div role="status" className="grid gap-1 text-xs">
              <p className="flex items-center gap-1">
                <CheckCircle2 className="size-3 text-emerald-500" /> Exported revision{" "}
                {receipt.revision} to {receipt.relativePath}
              </p>
              {Math.max(projection.revision, receipt.currentRevision) > receipt.revision && (
                <p className="text-muted-foreground">
                  The workspace has newer changes (revision{" "}
                  {Math.max(projection.revision, receipt.currentRevision)}) that are not in this
                  export.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {receipt ? "Done" : "Cancel"}
          </Button>
          {unsettled > 0 ? (
            <>
              <Button
                variant="outline"
                disabled={waiting || exporting}
                onClick={() => void waitForEdits()}
              >
                {waiting && <Loader2 className="size-3 animate-spin" />}
                Wait for pending edits
              </Button>
              <Button disabled={!canExport} onClick={() => void doExport()}>
                {exporting && <Loader2 className="size-3 animate-spin" />}
                Export committed revision {revision ?? "…"} now
              </Button>
            </>
          ) : (
            <Button disabled={!canExport} onClick={() => void doExport()}>
              {exporting && <Loader2 className="size-3 animate-spin" />}
              {collision && replace ? "Replace and export" : `Export revision ${revision ?? "…"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
