import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import type {
  McpApplyIntent,
  McpDefinitionSummary,
  McpImpactPreview,
  McpManagementSnapshot,
  McpMutation,
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
import * as backend from "@/lib/backend";

import { McpMutationPreview } from "./McpMutationPreview";
import { describeMcpError, newRequestId } from "./useMcpManagement";

export type McpEntryAction = { kind: "rename" | "remove"; entry: McpDefinitionSummary };

/**
 * Rename and remove. Both preview first — removal especially, because a
 * lower-priority definition with the same name may become effective — and
 * both are single conflict-checked backend operations.
 */
export function McpEntryDialog({
  action,
  snapshot,
  onClose,
}: {
  action: McpEntryAction;
  snapshot: McpManagementSnapshot;
  onClose: () => void;
}) {
  const { entry } = action;
  const source = snapshot.sources.find((candidate) => candidate.sourceId === entry.sourceId);
  const [newName, setNewName] = useState(entry.name);
  const [preview, setPreview] = useState<McpImpactPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestIds = useRef<Partial<Record<McpApplyIntent | "preview", string>>>({});

  const mutation = (applyIntent: McpApplyIntent, key: McpApplyIntent | "preview"): McpMutation => ({
    requestId: (requestIds.current[key] ??= newRequestId()),
    targetId: snapshot.target.targetId,
    applyIntent,
    operation:
      action.kind === "remove"
        ? { kind: "remove", entryId: entry.entryId, expectedRevision: source?.revision ?? "" }
        : {
            kind: "rename",
            entryId: entry.entryId,
            expectedRevision: source?.revision ?? "",
            newName: newName.trim(),
          },
  });

  const loadPreview = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await backend.validateMcpMutation(mutation("save", "preview"));
      if (result.valid) setPreview(result.preview);
      else setProblem(result.fieldErrors.map((error) => error.message).join(" "));
    } catch (error) {
      setProblem(describeMcpError(error));
    } finally {
      setBusy(false);
    }
  };

  // Removal previews immediately; rename previews once a name is chosen. Once
  // per opened dialog: `loadPreview` has a new identity every render.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (action.kind === "remove") void loadPreview();
  }, []);
  /* oxlint-enable react-hooks/exhaustive-deps */

  const submit = async (applyIntent: McpApplyIntent) => {
    setBusy(true);
    setProblem(null);
    try {
      await backend.mutateMcpDefinition(mutation(applyIntent, applyIntent));
      toast.success(
        action.kind === "remove" ? `Removed ${entry.name}` : `Renamed to ${newName.trim()}`,
      );
      onClose();
    } catch (error) {
      setProblem(describeMcpError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="sm:max-w-xl"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (!busy) onClose();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {action.kind === "remove" ? `Remove ${entry.name}?` : `Rename ${entry.name}`}
          </DialogTitle>
          <DialogDescription>
            {action.kind === "remove"
              ? `Only this entry is removed from ${source?.label ?? "its source"}. Same-name servers elsewhere, sign-ins and plugins are not touched.`
              : "The entry is renamed in one step, keeping all of its settings."}
          </DialogDescription>
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
        {problem ? (
          <p className="text-sm text-red-300" role="alert">
            {problem}
          </p>
        ) : null}
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {!preview ? (
            <Button
              disabled={
                busy ||
                (action.kind === "rename" && (!newName.trim() || newName.trim() === entry.name))
              }
              onClick={() => void loadPreview()}
            >
              Review change
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void submit("save")}>
                {action.kind === "remove" ? "Remove" : "Rename"}
              </Button>
              <Button
                variant={action.kind === "remove" ? "destructive" : "default"}
                disabled={busy}
                onClick={() => void submit("save-and-apply")}
              >
                {action.kind === "remove" ? "Remove and apply" : "Rename and apply"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
