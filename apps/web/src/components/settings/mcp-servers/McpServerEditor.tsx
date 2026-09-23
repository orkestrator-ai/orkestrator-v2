import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  mcpManagementErrorFromUnknown,
  type McpApplyIntent,
  type McpEditableDefinition,
  type McpFieldError,
  type McpImpactPreview,
  type McpManagementSnapshot,
  type McpMutation,
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as backend from "@/lib/backend";

import {
  definitionInputFromDraft,
  draftFromDefinition,
  emptyDraft,
  isEmptyPatch,
  patchFromDraft,
  type McpDraft,
} from "./mcp-draft";
import { McpMutationPreview } from "./McpMutationPreview";
import { McpServerForm } from "./McpServerForm";
import { describeMcpError, newRequestId } from "./useMcpManagement";

export type McpEditorMode = { kind: "add" } | { kind: "edit"; entryId: string };

interface Props {
  mode: McpEditorMode;
  snapshot: McpManagementSnapshot;
  onClose: () => void;
  onReload: () => void;
}

/**
 * Add/edit dialog. Drafts live only in this component: they are never
 * persisted, and the parent remounts it per target so a draft can never be
 * submitted against a different backend, provider or environment.
 */
export function McpServerEditor({ mode, snapshot, onClose, onReload }: Props) {
  const target = snapshot.target;
  const capabilities = target.capabilities;
  const writableSources = snapshot.sources.filter(
    (source) => source.writable && source.format !== "runtime",
  );
  const [sourceId, setSourceId] = useState<string | null>(
    mode.kind === "add" ? (target.defaultSourceId ?? null) : null,
  );
  const [definition, setDefinition] = useState<McpEditableDefinition | null>(null);
  const [draft, setDraft] = useState<McpDraft>(() =>
    emptyDraft(capabilities.transports.stdio.supported ? "stdio" : "http"),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<"form" | "review">("form");
  const [preview, setPreview] = useState<McpImpactPreview | null>(null);
  const [errors, setErrors] = useState<McpFieldError[]>([]);
  const [problem, setProblem] = useState<{ message: string; conflict: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // One id per intent for the reviewed draft: a click retried after a lost
  // response is answered from the operation record instead of saving twice.
  const requestIds = useRef<Partial<Record<McpApplyIntent | "preview", string>>>({});
  const backToForm = () => {
    requestIds.current = {};
    setStep("form");
  };

  useEffect(() => {
    if (mode.kind !== "edit") return;
    let cancelled = false;
    backend
      .getMcpDefinition(target.targetId, mode.entryId)
      .then((loaded) => {
        if (cancelled) return;
        setDefinition(loaded);
        setDraft(draftFromDefinition(loaded));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(describeMcpError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, target.targetId]);

  const source = useMemo(
    () =>
      snapshot.sources.find(
        (candidate) =>
          candidate.sourceId === (mode.kind === "add" ? sourceId : definition?.sourceId),
      ),
    [snapshot.sources, mode.kind, sourceId, definition?.sourceId],
  );

  const buildMutation = (
    applyIntent: McpApplyIntent,
    key: McpApplyIntent | "preview",
  ): McpMutation | null => {
    const requestId = (requestIds.current[key] ??= newRequestId());
    if (mode.kind === "add") {
      if (!source) return null;
      return {
        requestId,
        targetId: target.targetId,
        applyIntent,
        operation: {
          kind: "add",
          sourceId: source.sourceId,
          expectedRevision: source.revision,
          definition: definitionInputFromDraft(draft, capabilities.operations.setEnabled.supported),
        },
      };
    }
    if (!definition) return null;
    return {
      requestId,
      targetId: target.targetId,
      applyIntent,
      operation: {
        kind: "update",
        entryId: definition.entryId,
        expectedRevision: definition.sourceRevision,
        patch: patchFromDraft(definition, draft),
      },
    };
  };

  const review = async () => {
    const mutation = buildMutation("save", "preview");
    if (!mutation) return;
    if (mutation.operation.kind === "update" && isEmptyPatch(mutation.operation.patch)) {
      setProblem({ message: "Nothing has changed.", conflict: false });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await backend.validateMcpMutation(mutation);
      setErrors(result.fieldErrors);
      if (result.valid && result.preview) {
        setPreview(result.preview);
        setStep("review");
      }
    } catch (error) {
      const detail = mcpManagementErrorFromUnknown(error);
      setProblem({
        message: describeMcpError(error),
        conflict: detail?.code === "revision-conflict",
      });
    } finally {
      setBusy(false);
    }
  };

  const submit = async (applyIntent: McpApplyIntent) => {
    const mutation = buildMutation(applyIntent, applyIntent);
    if (!mutation) return;
    setBusy(true);
    setProblem(null);
    try {
      await backend.mutateMcpDefinition(mutation);
      toast.success(applyIntent === "save" ? "Server saved" : "Server saved; applying");
      onClose();
    } catch (error) {
      const detail = mcpManagementErrorFromUnknown(error);
      if (detail?.code === "invalid-definition") {
        setErrors(detail.field ? [{ field: detail.field, message: detail.message }] : []);
        backToForm();
      }
      setProblem({
        message: describeMcpError(error),
        conflict: detail?.code === "revision-conflict",
      });
    } finally {
      setBusy(false);
    }
  };

  const reloadLatest = async () => {
    // Keep the non-secret draft; require a fresh preview against the new revision.
    setProblem(null);
    backToForm();
    onReload();
    if (mode.kind === "edit") {
      try {
        const latest = await backend.getMcpDefinition(target.targetId, mode.entryId);
        setDefinition(latest);
        // Retained arguments are referenced by position in the saved revision;
        // against a newer revision that position may hold something else, so
        // such a draft is rebuilt. Key-based rows are checked by the backend.
        if (draft.args.some((arg) => arg.kind === "keep")) {
          setDraft(draftFromDefinition(latest));
          setProblem({
            message: "Reloaded the latest saved version. Make your change again.",
            conflict: false,
          });
        }
      } catch (error) {
        setLoadError(describeMcpError(error));
      }
    }
  };

  const title =
    mode.kind === "add"
      ? `Add ${target.providerLabel} server`
      : `Edit ${definition?.name ?? "server"}`;
  const loading = mode.kind === "edit" && !definition && !loadError;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        onEscapeKeyDown={(event) => {
          // Close this dialog only, not the settings page behind it.
          event.preventDefault();
          if (!busy) onClose();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {target.context.locationLabel}. {capabilities.apply.description}
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="text-sm text-red-300" role="alert">
            {loadError}
          </p>
        ) : loading ? (
          <div className="flex justify-center py-8" role="status" aria-label="Loading server">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : step === "form" ? (
          <div className="space-y-5">
            {mode.kind === "add" ? (
              <div className="space-y-1.5">
                <Label htmlFor="mcp-server-scope">Save to</Label>
                <Select value={sourceId ?? undefined} onValueChange={setSourceId}>
                  <SelectTrigger id="mcp-server-scope">
                    <SelectValue placeholder="Choose where to save" />
                  </SelectTrigger>
                  <SelectContent>
                    {writableSources.map((candidate) => (
                      <SelectItem key={candidate.sourceId} value={candidate.sourceId}>
                        {candidate.label} — {candidate.displayPath}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {source?.trustReason ? (
                  <p className="text-xs text-muted-foreground">{source.trustReason}</p>
                ) : null}
                {!writableSources.length ? (
                  <p className="text-xs text-amber-300">
                    No writable configuration file is available for this target.
                  </p>
                ) : null}
              </div>
            ) : definition ? (
              <p className="text-xs text-muted-foreground">
                Saved in {source?.label ?? "its source"}{" "}
                <span className="font-mono">{source?.displayPath}</span>
              </p>
            ) : null}
            {definition?.readOnlyReason ? (
              <p className="text-sm text-amber-300" role="alert">
                {definition.readOnlyReason}
              </p>
            ) : (
              <McpServerForm
                draft={draft}
                onChange={setDraft}
                capabilities={capabilities}
                isNew={mode.kind === "add"}
                errors={errors}
                projectScope={source?.scope === "project"}
                locationLabel={target.context.locationLabel}
                preservedFields={definition?.preservedFields ?? []}
              />
            )}
          </div>
        ) : preview ? (
          <McpMutationPreview preview={preview} />
        ) : null}

        {problem ? (
          <div
            className="flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div className="space-y-2">
              <p>{problem.message}</p>
              {problem.conflict ? (
                <Button size="sm" variant="outline" onClick={() => void reloadLatest()}>
                  Reload latest and review again
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          {step === "review" ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={backToForm}>
                Back
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void submit("save")}>
                Save
              </Button>
              <Button disabled={busy} onClick={() => void submit("save-and-apply")}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save and apply
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={
                  busy ||
                  loading ||
                  !!loadError ||
                  !!definition?.readOnlyReason ||
                  (mode.kind === "add" && !source)
                }
                onClick={() => void review()}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Review change
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
