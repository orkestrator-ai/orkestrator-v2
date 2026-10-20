import { useEffect, useState } from "react";
import { Loader2, Undo2 } from "lucide-react";
import type {
  ChangeProjection,
  ChangesApplyRestoreResult,
  ChangesPrepareRestoreResult,
} from "@orkestrator/protocol/change-resources";
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
import * as backend from "@/lib/backend";
import { changeReason } from "@/lib/changes/labels";

const RISK_TEXT: Record<string, string> = {
  "changes.restore.risk.external-writers":
    "Another program could still write these files between the check and the write.",
  "changes.restore.risk.not-atomic":
    "Files are restored one at a time; a failure can leave some restored.",
};

/**
 * Conditional restore of a retained change. Everything here is backend
 * decided: whether the action is offered (the projection's `restore` action
 * and the backend capability), which files can be written (preflight against
 * the measured after-state), and the outcome. The client only shows the
 * preview and confirms.
 */
export function RestoreChangesButton({ projection }: { projection: ChangeProjection | undefined }) {
  const action = projection?.actions.find((candidate) => candidate.kind === "restore");
  const [enabled, setEnabled] = useState(false);
  const [preview, setPreview] = useState<Extract<
    ChangesPrepareRestoreResult,
    { kind: "preview" }
  > | null>(null);
  const [applyKey, setApplyKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void backend
      .getChangeTrackingCapabilities()
      .then((capabilities) => {
        if (!cancelled) setEnabled(Boolean(capabilities?.restore));
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!action || !enabled) return null;

  const prepare = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await backend.prepareChangeRestore(action.targetToken);
      if (result.kind === "preview") {
        setApplyKey(crypto.randomUUID());
        setPreview(result);
      } else
        setMessage(
          changeReason(result.kind === "disabled" ? result.reasonKey : result.error.reasonKey),
        );
    } catch {
      setMessage("Restore is unavailable");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview || !applyKey) return;
    setBusy(true);
    try {
      const result: ChangesApplyRestoreResult = await backend.applyChangeRestore(
        preview.actionToken,
        applyKey,
      );
      if (result.kind === "applied") {
        setPreview(null);
        setMessage(
          result.outcome === "complete"
            ? `Restored ${result.completedPathIds.length} file${result.completedPathIds.length === 1 ? "" : "s"}.`
            : `Restored ${result.completedPathIds.length}; ${result.failedPathIds.length} could not be restored.`,
        );
      } else {
        setMessage(changeReason(result.error.reasonKey));
      }
    } catch {
      setMessage("The restore result is unknown. Retry to retrieve the same operation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="size-6"
        disabled={!action.enabled || busy}
        title={
          action.enabled
            ? "Restore the files this change touched"
            : changeReason(action.reasonKey ?? "")
        }
        aria-label="Restore these changes"
        data-testid="restore-changes-button"
        onClick={() => void prepare()}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
      </Button>
      {message && !preview ? (
        <span role="status" className="text-[11px] text-muted-foreground">
          {message}
        </span>
      ) : null}
      <AlertDialog
        open={preview !== null}
        onOpenChange={(open) => (open || busy ? undefined : setPreview(null))}
      >
        <AlertDialogContent data-testid="restore-preview">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore these changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Only files that still match what this change produced are restored. Anything edited
              since is skipped, never overwritten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-60 overflow-auto text-xs font-mono">
            {preview?.files.map((file) => (
              <li key={`${file.pathId}:${file.action}`} className="flex gap-2 py-0.5">
                <span className="w-12 shrink-0 text-muted-foreground">{file.action}</span>
                <span className="truncate">{file.pathDisplay}</span>
                {file.reasonKey ? (
                  <span className="text-muted-foreground">— {changeReason(file.reasonKey)}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {preview?.residualRiskKeys.map((key) => (
            <p key={key} className="text-xs text-muted-foreground">
              {RISK_TEXT[key] ?? changeReason(key)}
            </p>
          ))}
          {message ? (
            <p role="status" className="text-xs text-muted-foreground">
              {message}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !preview?.files.some((file) => file.action !== "skip")}
              onClick={(event) => {
                event.preventDefault();
                void apply();
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
