import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  mcpManagementErrorFromUnknown,
  type McpApplyIntent,
  type McpDefinitionSummary,
  type McpImpactPreview,
  type McpManagementSnapshot,
  type McpMutation,
  type McpMutationOperation,
} from "@orkestrator/protocol/mcp-management";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";

import { McpErrorNotice, mcpProblemFrom, type McpProblem } from "./McpErrorNotice";
import { applyBlockedReason, writeBlockedReason } from "./mcp-rollout";
import { McpMutationPreview } from "./McpMutationPreview";
import { newRequestId } from "./useMcpManagement";

export type McpEntryAction = {
  kind: "rename" | "remove" | "set-enabled";
  entry: McpDefinitionSummary;
};

function copyFor(action: McpEntryAction, enable: boolean, sourceLabel: string, newName: string) {
  const { entry } = action;
  if (action.kind === "remove")
    return {
      title: `Remove ${entry.name}?`,
      description: `Only this entry is removed from ${sourceLabel}. Same-name servers elsewhere, sign-ins and plugins are not touched.`,
      save: "Remove",
      apply: "Remove and apply",
      done: `Removed ${entry.name}`,
    };
  if (action.kind === "set-enabled") {
    const verb = enable ? "Enable" : "Disable";
    return {
      title: `${verb} ${entry.name}?`,
      description: `Only this entry's enabled setting in ${sourceLabel} changes. Everything else about it is kept.`,
      save: verb,
      apply: `${verb} and apply`,
      done: `${verb}d ${entry.name}`,
    };
  }
  return {
    title: `Rename ${entry.name}`,
    description: "The entry is renamed in one step, keeping all of its settings.",
    save: "Rename",
    apply: "Rename and apply",
    done: `Renamed to ${newName}`,
  };
}

/**
 * Rename, remove and enable/disable. All preview first — removal and
 * disabling especially, because a lower-priority definition with the same
 * name may become effective — and each is a single conflict-checked backend
 * operation.
 */
export function McpEntryDialog({
  action,
  snapshot,
  onClose,
  onReload,
  onDirtyChange,
  onRestoreFocus,
}: {
  action: McpEntryAction;
  snapshot: McpManagementSnapshot;
  /** `done` is true once the change was saved. */
  onClose: (done: boolean) => void;
  onReload?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Return focus to the row action that opened the dialog. */
  onRestoreFocus?: () => void;
}) {
  const { entry } = action;
  const source = snapshot.sources.find((candidate) => candidate.sourceId === entry.sourceId);
  const [newName, setNewName] = useState(entry.name);
  const [preview, setPreview] = useState<McpImpactPreview | null>(null);
  const [problem, setProblem] = useState<McpProblem | null>(null);
  const [busy, setBusy] = useState(false);
  // The direction chosen when the dialog opened. A reload re-checks it
  // against the latest file but never flips what the user asked for.
  const [enable] = useState(() => entry.enabled === false);
  // The revision the user saw when opening the dialog. The live snapshot keeps
  // refreshing underneath; reading it per request would change a retried
  // mutation's fingerprint and turn a lost response into a request conflict.
  // Only an explicit "Reload latest" re-pins it.
  const expectedRevision = useRef(source?.revision ?? "");
  // One id per intent: a retry after a lost response is answered from the
  // operation record. A definite backend answer ends that request, so the
  // next attempt gets a new id instead of replaying the recorded failure.
  const requestIds = useRef<Partial<Record<McpApplyIntent | "preview", string>>>({});
  const settle = (key: McpApplyIntent | "preview", error: unknown) => {
    if (mcpManagementErrorFromUnknown(error)) delete requestIds.current[key];
  };
  const copy = copyFor(action, enable, source?.label ?? "its source", newName.trim());
  const writeBlocked = writeBlockedReason(snapshot.target.capabilities);
  const applyBlocked = applyBlockedReason(snapshot.target.capabilities);
  const gated = (error: unknown) => {
    // The rollout gate changed under us: re-read so the list matches it.
    if (mcpManagementErrorFromUnknown(error)?.code === "management-disabled") onReload?.();
  };

  const dirty = action.kind === "rename" && newName.trim() !== entry.name;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  const operation = (): McpMutationOperation => {
    const pinned = { entryId: entry.entryId, expectedRevision: expectedRevision.current };
    if (action.kind === "remove") return { kind: "remove", ...pinned };
    if (action.kind === "set-enabled") return { kind: "set-enabled", ...pinned, enabled: enable };
    return { kind: "rename", ...pinned, newName: newName.trim() };
  };
  const mutation = (applyIntent: McpApplyIntent, key: McpApplyIntent | "preview"): McpMutation => ({
    requestId: (requestIds.current[key] ??= newRequestId()),
    targetId: snapshot.target.targetId,
    applyIntent,
    operation: operation(),
  });

  const loadPreview = async () => {
    setBusy(true);
    setProblem(null);
    try {
      // Shared by both buttons, so it describes the stronger intent — unless
      // applying is switched off and only the save is offered.
      const result = await backend.validateMcpMutation(
        mutation(applyBlocked ? "save" : "save-and-apply", "preview"),
      );
      if (result.valid) setPreview(result.preview);
      else setProblem({ message: result.fieldErrors.map((error) => error.message).join(" ") });
    } catch (error) {
      settle("preview", error);
      gated(error);
      setProblem(mcpProblemFrom(error));
    } finally {
      setBusy(false);
    }
  };

  // Removal and enable/disable preview immediately; rename previews once a
  // name is chosen. Once per opened dialog: `loadPreview` has a new identity
  // every render.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (action.kind !== "rename") void loadPreview();
  }, []);
  /* oxlint-enable react-hooks/exhaustive-deps */

  const submit = async (applyIntent: McpApplyIntent) => {
    setBusy(true);
    setProblem(null);
    try {
      await backend.mutateMcpDefinition(mutation(applyIntent, applyIntent));
      toast.success(copy.done);
      onClose(true);
    } catch (error) {
      settle(applyIntent, error);
      gated(error);
      setProblem(mcpProblemFrom(error));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Re-read the entry, re-pin its revision and start a new request: the
   * previous preview described a file that no longer exists, so a fresh one
   * is required before anything can be submitted.
   */
  const reloadLatest = async () => {
    setBusy(true);
    setProblem(null);
    setPreview(null);
    requestIds.current = {};
    onReload?.();
    let reloaded = false;
    try {
      const latest = await backend.getMcpDefinition(snapshot.target.targetId, entry.entryId);
      expectedRevision.current = latest.sourceRevision;
      reloaded = true;
    } catch (error) {
      setProblem(mcpProblemFrom(error));
    } finally {
      setBusy(false);
    }
    if (reloaded && action.kind !== "rename") await loadPreview();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose(false)}>
      <DialogContent
        className={cn("sm:max-w-xl", Z_FULLSCREEN_DIALOG)}
        overlayClassName={Z_FULLSCREEN_DIALOG}
        onCloseAutoFocus={(event) => {
          if (!onRestoreFocus) return;
          event.preventDefault();
          onRestoreFocus();
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (!busy) onClose(false);
        }}
      >
        <DialogHeader>
          <DialogTitle className="break-all">{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {action.kind === "rename" ? (
          <div className="space-y-1.5">
            <Label htmlFor="mcp-rename">New name</Label>
            <Input
              id="mcp-rename"
              className="font-mono"
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value);
                setPreview(null);
                requestIds.current = {};
              }}
            />
            <p className="text-xs text-muted-foreground">
              {snapshot.target.capabilities.nameRule.description}
            </p>
          </div>
        ) : null}
        {busy && !preview ? (
          <div className="flex justify-center py-4" role="status" aria-label="Checking the change">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {preview ? <McpMutationPreview preview={preview} /> : null}
        {writeBlocked || (preview && applyBlocked) ? (
          <p className="text-xs text-amber-300" role="note">
            {writeBlocked ?? applyBlocked}
          </p>
        ) : null}
        {problem ? (
          <McpErrorNotice problem={problem}>
            {problem.conflict ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void reloadLatest()}
              >
                Reload latest and review again
              </Button>
            ) : null}
          </McpErrorNotice>
        ) : null}
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => onClose(false)}>
            Cancel
          </Button>
          {!preview ? (
            <Button
              disabled={
                busy ||
                !!writeBlocked ||
                (action.kind === "rename" && (!newName.trim() || newName.trim() === entry.name))
              }
              onClick={() => void loadPreview()}
            >
              Review change
            </Button>
          ) : (
            <>
              <Button
                variant={
                  !applyBlocked ? "outline" : action.kind === "remove" ? "destructive" : "default"
                }
                disabled={busy || !!writeBlocked}
                onClick={() => void submit("save")}
              >
                {copy.save}
              </Button>
              {applyBlocked ? null : (
                <Button
                  variant={action.kind === "remove" ? "destructive" : "default"}
                  disabled={busy || !!writeBlocked}
                  onClick={() => void submit("save-and-apply")}
                >
                  {copy.apply}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
