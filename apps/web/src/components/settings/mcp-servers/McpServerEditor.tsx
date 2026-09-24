import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { Z_FULLSCREEN_DIALOG, Z_FULLSCREEN_DIALOG_POPOVER } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";

import {
  definitionInputFromDraft,
  draftFromDefinition,
  emptyDraft,
  isEmptyPatch,
  patchFromDraft,
  rebaseDraft,
  type McpDraft,
} from "./mcp-draft";
import { McpDiscardDialog } from "./McpDiscardDialog";
import { McpErrorNotice, mcpProblemFrom, type McpProblem } from "./McpErrorNotice";
import { localAddErrors, localPatchErrors } from "./mcp-local-validation";
import { applyBlockedReason, writeBlockedReason } from "./mcp-rollout";
import { McpMutationPreview } from "./McpMutationPreview";
import { McpServerForm } from "./McpServerForm";
import { describeMcpError, newRequestId } from "./useMcpManagement";

export type McpEditorMode = { kind: "add" } | { kind: "edit"; entryId: string };

interface Props {
  mode: McpEditorMode;
  snapshot: McpManagementSnapshot;
  onClose: () => void;
  onReload: () => void;
  /** Whether the draft holds unsaved changes; lets the parent confirm a discard. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Return focus to whatever opened the dialog (there is no DialogTrigger). */
  onRestoreFocus?: () => void;
}

/** Values typed into secret-bearing fields, kept off screen in error text. */
function typedSecretValues(draft: McpDraft): string[] {
  return [...draft.env, ...draft.headers]
    .filter((row) => row.mode === "set")
    .map((row) => row.value);
}

function isBlankDraft(draft: McpDraft): boolean {
  return (
    !draft.name.trim() &&
    !(draft.command.kind === "set" && draft.command.value.trim()) &&
    !(draft.url.kind === "set" && draft.url.value.trim()) &&
    !draft.args.length &&
    !draft.cwd.trim() &&
    !draft.env.length &&
    !draft.headers.length &&
    draft.enabled &&
    Object.values(draft.advanced).every(
      (value) => value === "" || (Array.isArray(value) && !value.length),
    )
  );
}

/**
 * Add/edit dialog. Drafts live only in this component: they are never
 * persisted, and the parent remounts it per target so a draft can never be
 * submitted against a different backend, provider or environment.
 */
export function McpServerEditor({
  mode,
  snapshot,
  onClose,
  onReload,
  onDirtyChange,
  onRestoreFocus,
}: Props) {
  const target = snapshot.target;
  const capabilities = target.capabilities;
  // Backend rollout gate: offer only what the backend will accept.
  const writeBlocked = writeBlockedReason(capabilities);
  const applyBlocked = applyBlockedReason(capabilities);
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
  const [problem, setProblem] = useState<McpProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // Set once a review was refused locally, so fixing a field clears its error
  // immediately instead of on the next click.
  const [checkedLocally, setCheckedLocally] = useState(false);
  // One id per intent for the reviewed draft: a click retried after a lost
  // response is answered from the operation record instead of saving twice.
  // A definite backend answer ends the request (see `settle`).
  const requestIds = useRef<Partial<Record<McpApplyIntent | "preview", string>>>({});
  // Source revision a new server is checked against, pinned per source when
  // first used. The live snapshot refreshes on every change event; reading it
  // per request would give a retried mutation a different fingerprint. Only a
  // deliberate reload re-pins it. Edits pin `definition.sourceRevision`.
  const pinnedRevisions = useRef<Record<string, string | null>>({});
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const backToForm = () => {
    requestIds.current = {};
    setStep("form");
  };
  const settle = (key: McpApplyIntent | "preview", error: unknown) => {
    // A transport failure may have reached the backend: keep the id so a
    // retry replays. A structured answer is final for that id.
    if (mcpManagementErrorFromUnknown(error)) delete requestIds.current[key];
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

  const localErrors = (candidate: McpDraft) => {
    if (mode.kind === "add")
      return localAddErrors(
        candidate,
        definitionInputFromDraft(
          candidate,
          capabilities.operations.setEnabled.supported,
          capabilities.fields.advanced,
        ),
        capabilities,
      );
    return definition
      ? localPatchErrors(
          candidate,
          patchFromDraft(definition, candidate, capabilities.fields.advanced),
        )
      : [];
  };
  const changeDraft = (next: McpDraft) => {
    setDraft(next);
    if (checkedLocally) setErrors(localErrors(next));
  };

  const dirty =
    mode.kind === "add"
      ? !isBlankDraft(draft)
      : !!definition &&
        !isEmptyPatch(patchFromDraft(definition, draft, capabilities.fields.advanced));
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  // The rollout gate changed under us: re-read so the controls match it.
  const refreshIfGated = (error: unknown) => {
    if (mcpManagementErrorFromUnknown(error)?.code === "management-disabled") onReload();
  };
  const problemFrom = (error: unknown) =>
    mcpProblemFrom(error, { redact: typedSecretValues(draftRef.current) });

  const buildMutation = (
    applyIntent: McpApplyIntent,
    key: McpApplyIntent | "preview",
  ): McpMutation | null => {
    const requestId = (requestIds.current[key] ??= newRequestId());
    if (mode.kind === "add") {
      if (!source) return null;
      if (!(source.sourceId in pinnedRevisions.current))
        pinnedRevisions.current[source.sourceId] = source.revision;
      return {
        requestId,
        targetId: target.targetId,
        applyIntent,
        operation: {
          kind: "add",
          sourceId: source.sourceId,
          expectedRevision: pinnedRevisions.current[source.sourceId] ?? null,
          definition: definitionInputFromDraft(
            draft,
            capabilities.operations.setEnabled.supported,
            capabilities.fields.advanced,
          ),
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
        patch: patchFromDraft(definition, draft, capabilities.fields.advanced),
      },
    };
  };

  const review = async () => {
    // The preview serves both Save and Save and apply, so it is requested
    // with the stronger intent: it must describe everything applying may do,
    // including starting a stdio server's command.
    if (mode.kind === "add" ? !source : !definition) return;
    if (
      definition &&
      isEmptyPatch(patchFromDraft(definition, draft, capabilities.fields.advanced))
    ) {
      setProblem({ message: "Nothing has changed.", conflict: false });
      return;
    }
    const local = localErrors(draft);
    setCheckedLocally(true);
    setErrors(local);
    if (local.length) {
      setProblem(null);
      return;
    }
    // …unless applying is switched off, in which case only Save is offered.
    const mutation = buildMutation(applyBlocked ? "save" : "save-and-apply", "preview");
    if (!mutation) return;
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
      settle("preview", error);
      refreshIfGated(error);
      setProblem(problemFrom(error));
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
      settle(applyIntent, error);
      const detail = mcpManagementErrorFromUnknown(error);
      if (detail?.code === "invalid-definition") {
        setErrors(detail.field ? [{ field: detail.field, message: detail.message }] : []);
        backToForm();
      }
      refreshIfGated(error);
      setProblem(problemFrom(error));
    } finally {
      setBusy(false);
    }
  };

  const reloadLatest = async () => {
    // Keep the non-secret draft; require a fresh preview against the new revision.
    setProblem(null);
    backToForm();
    // A new server re-pins its source revision from the refreshed snapshot on
    // the next review.
    pinnedRevisions.current = {};
    onReload();
    if (mode.kind === "edit") {
      const original = definition;
      try {
        const latest = await backend.getMcpDefinition(target.targetId, mode.entryId);
        setDefinition(latest);
        // Carry only the fields the user changed onto the latest revision, so
        // another writer's change to an untouched field is not reverted.
        // Edited arguments that retain saved values by position cannot move:
        // that position may hold something else now, so the draft is rebuilt.
        const rebased = original ? rebaseDraft(original, draftRef.current, latest) : null;
        setDraft(rebased ?? draftFromDefinition(latest));
        if (!rebased) {
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

  // Escape, Cancel and the overlay ask before an unsaved draft is dropped.
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <DialogContent
          className={cn("max-h-[90vh] overflow-y-auto sm:max-w-2xl", Z_FULLSCREEN_DIALOG)}
          overlayClassName={Z_FULLSCREEN_DIALOG}
          onCloseAutoFocus={(event) => {
            if (!onRestoreFocus) return;
            event.preventDefault();
            onRestoreFocus();
          }}
          onEscapeKeyDown={(event) => {
            // Close this dialog only, not the settings page behind it.
            event.preventDefault();
            requestClose();
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
                    <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
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
                  onChange={changeDraft}
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

          {writeBlocked || (step === "review" && applyBlocked) ? (
            <p className="text-xs text-amber-300" role="note">
              {writeBlocked ?? applyBlocked}
            </p>
          ) : null}

          {problem ? (
            <McpErrorNotice problem={problem}>
              {problem.conflict ? (
                <Button size="sm" variant="outline" onClick={() => void reloadLatest()}>
                  Reload latest and review again
                </Button>
              ) : null}
            </McpErrorNotice>
          ) : null}

          <DialogFooter className="gap-2">
            {step === "review" ? (
              <>
                <Button variant="ghost" disabled={busy} onClick={backToForm}>
                  Back
                </Button>
                <Button
                  variant={applyBlocked ? "default" : "outline"}
                  disabled={busy || !!writeBlocked}
                  onClick={() => void submit("save")}
                >
                  Save
                </Button>
                {applyBlocked ? null : (
                  <Button
                    disabled={busy || !!writeBlocked}
                    onClick={() => void submit("save-and-apply")}
                  >
                    {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Save and apply
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="ghost" disabled={busy} onClick={requestClose}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    busy ||
                    loading ||
                    !!loadError ||
                    !!definition?.readOnlyReason ||
                    !!writeBlocked ||
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
      <McpDiscardDialog
        open={confirmClose}
        reason="close"
        onKeep={() => setConfirmClose(false)}
        onDiscard={() => {
          setConfirmClose(false);
          onClose();
        }}
      />
    </>
  );
}
