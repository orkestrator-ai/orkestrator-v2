import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Check, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type {
  AutoPipelineDraft,
  AutoPipelineEdits,
  AutoPipelineState,
} from "@orkestrator/protocol/build-pipeline";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { AutoPipelineTabData } from "@/types/paneLayout";
import { AutoPipelineBuildNotes } from "./AutoPipelineBuildNotes";
import { AutoPipelineCriteriaField } from "./AutoPipelineCriteriaField";
import { AutoPipelineDescriptionField } from "./AutoPipelineDescriptionField";

export type AutoPipelineStep = "draft" | "details" | "criteria" | "confirm";
const STEPS: readonly { id: AutoPipelineStep; label: string }[] = [
  { id: "draft", label: "Draft" },
  { id: "details", label: "Details" },
  { id: "criteria", label: "Acceptance criteria" },
  { id: "confirm", label: "Confirm" },
];
/** How often a visible tab re-reads the backend's state. */
const POLL_MS = 1500;
/** Edits are saved to the backend this long after the last keystroke. */
const SAVE_DELAY_MS = 600;

function editsOf(draft: AutoPipelineDraft): AutoPipelineEdits {
  return {
    title: draft.title,
    description: draft.description,
    acceptanceCriteria: [...draft.acceptanceCriteria],
  };
}

/** Why the edited ticket cannot be confirmed yet, per step; empty when it can. */
export function autoPipelineProblems(
  edits: AutoPipelineEdits,
): Partial<Record<"details" | "criteria", string>> {
  const problems: Partial<Record<"details" | "criteria", string>> = {};
  if (!edits.title.trim()) problems.details = "Enter a title.";
  else if (!edits.description.trim()) problems.details = "Enter a description.";
  if (!edits.acceptanceCriteria.length)
    problems.criteria = "Add at least one acceptance criterion.";
  else if (edits.acceptanceCriteria.some((value) => !value.trim()))
    problems.criteria = "Fill in or remove the empty acceptance criterion.";
  return problems;
}

/**
 * Promotes one finished agent tab into a build pipeline, as a tab of its own:
 * drafting, editing the ticket and confirming all happen here, one step at a
 * time. Drafting and promotion run in the backend, and edits are saved there,
 * so switching tabs or environments neither cancels nor loses anything; the
 * tab re-reads where things stand whenever it is shown.
 */
export function AutoPipelineTab({
  environmentId,
  data,
  isActive,
}: {
  environmentId: string;
  data: AutoPipelineTabData;
  isActive: boolean;
}) {
  const backend = useScopeBackend();
  const fieldId = useId();
  const sourceTabId = data.sourceTabId;
  const [state, setState] = useState<AutoPipelineState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [step, setStep] = useState<AutoPipelineStep>("details");
  const [local, setLocal] = useState<{ draftId: string; edits: AutoPipelineEdits } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pendingSave = useRef<{ draftId: string; edits: AutoPipelineEdits } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(
    () =>
      backend.getAutoPipelineState(environmentId, sourceTabId).then(
        (value) => {
          setState(value);
          setReadError(null);
        },
        (error: unknown) => setReadError(error instanceof Error ? error.message : String(error)),
      ),
    [backend, environmentId, sourceTabId],
  );
  // Re-read on every return to the tab and keep polling while it is shown.
  useEffect(() => {
    if (!isActive) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [isActive, refresh]);

  const flushSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const pending = pendingSave.current;
    pendingSave.current = null;
    if (!pending) return Promise.resolve();
    return backend.saveAutoPipelineEdits(pending.draftId, pending.edits);
  }, [backend]);
  // Leaving the tab is not discarding it: hand the last edits to the backend.
  useEffect(() => () => void flushSave().catch(() => undefined), [flushSave]);

  const reviewing = state?.phase === "ready" || state?.phase === "promoting" ? state : null;
  const draft = reviewing?.draft ?? null;
  const edits = draft
    ? local?.draftId === draft.id
      ? local.edits
      : (reviewing?.edits ?? editsOf(draft))
    : null;
  const promoting = state?.phase === "promoting" || submitting;
  // A promotion is the Confirm step's outcome, so returning mid-promotion lands there.
  const currentStep: AutoPipelineStep = !draft
    ? "draft"
    : state?.phase === "promoting"
      ? "confirm"
      : step === "draft"
        ? "details"
        : step;
  const problems = edits ? autoPipelineProblems(edits) : {};

  function change(next: AutoPipelineEdits) {
    if (!draft || promoting) return;
    setLocal({ draftId: draft.id, edits: next });
    pendingSave.current = { draftId: draft.id, edits: next };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flushSave().catch(() => undefined), SAVE_DELAY_MS);
  }

  function startDrafting() {
    setActionError(null);
    setStep("details");
    setState({ phase: "drafting" });
    // The backend records the outcome; the state read shows it, here or after a return.
    void backend.draftAutoPipeline(environmentId, sourceTabId).then(
      () => void refresh(),
      () => void refresh(),
    );
  }

  function cancelDrafting() {
    void backend
      .cancelAutoPipelineDraft(environmentId, sourceTabId)
      .catch(() => undefined)
      .finally(() => void refresh());
  }

  async function confirm() {
    if (!draft || !edits || promoting || Object.keys(problems).length) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await flushSave();
      setState({ phase: "promoting", draft, edits });
      await backend.confirmAutoPipeline(draft.id, {
        title: edits.title,
        description: edits.description,
        acceptanceCriteria: edits.acceptanceCriteria,
      });
      toast.success("Auto-pipeline started", {
        description: "The ticket was created and the pipeline continues from Review.",
      });
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSubmitting(false);
      void refresh();
    }
  }

  const confirmError =
    actionError ?? (state?.phase === "ready" ? (state.confirmError ?? null) : null);
  const stepIndex = STEPS.findIndex((entry) => entry.id === currentStep);

  return (
    <div
      data-auto-pipeline-tab={sourceTabId}
      className={cn(
        "absolute inset-0 flex min-w-0 flex-col overflow-hidden bg-background",
        !isActive && "hidden",
      )}
    >
      <header className="shrink-0 border-b border-divider px-5 pb-3 pt-4 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-base font-semibold">Auto-pipeline</h2>
          {data.sourceLabel && (
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              From <span className="text-foreground">{data.sourceLabel}</span>
            </p>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Turn finished work into a ticket and continue from Review through verification and
          delivery. You can leave this tab while it works.
        </p>
        <nav aria-label="Auto-pipeline steps" className="mt-3">
          <ol className="flex flex-wrap items-center gap-1.5">
            {STEPS.map((entry, index) => {
              const done = index < stepIndex || (entry.id === "draft" && !!draft);
              const current = entry.id === currentStep;
              const reachable = !!draft && entry.id !== "draft" && !promoting;
              const problem =
                entry.id === "details" || entry.id === "criteria" ? problems[entry.id] : undefined;
              return (
                <li key={entry.id} className="flex items-center gap-1.5">
                  {index > 0 && <span aria-hidden className="hidden h-px w-6 bg-border sm:block" />}
                  <button
                    type="button"
                    disabled={!reachable}
                    aria-current={current ? "step" : undefined}
                    onClick={() => setStep(entry.id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                      current
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border/70 text-muted-foreground",
                      reachable && !current && "hover:border-border hover:text-foreground",
                      !reachable && "cursor-default",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "grid size-4 place-items-center rounded-full text-[10px] tabular-nums",
                        done && !problem
                          ? "bg-primary text-primary-foreground"
                          : problem && draft
                            ? "bg-destructive/80 text-white"
                            : "bg-muted text-muted-foreground",
                      )}
                    >
                      {done && !problem ? <Check className="size-3" /> : index + 1}
                    </span>
                    {entry.label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      </header>

      <div
        role="region"
        aria-label="Auto-pipeline draft"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6"
      >
        <div className="mx-auto w-full max-w-4xl">
          {!state && !readError && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Loading…
            </p>
          )}
          {!state && readError && (
            <p role="alert" className="text-sm text-destructive">
              {readError}
            </p>
          )}
          {state?.phase === "idle" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                No draft yet. Drafting reads the source tab&apos;s transcript and the branch&apos;s
                changes, then proposes a ticket and Build notes for you to review. Nothing is
                created until you confirm.
              </p>
              <Button type="button" onClick={startDrafting}>
                Draft ticket
              </Button>
            </div>
          )}
          {state?.phase === "drafting" && (
            <div className="space-y-3">
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2
                  aria-hidden="true"
                  data-testid="auto-pipeline-spinner"
                  className="size-4 shrink-0 animate-spin text-primary"
                />
                Drafting ticket and Build notes… this can take a couple of minutes.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={cancelDrafting}>
                Cancel drafting
              </Button>
            </div>
          )}
          {state?.phase === "failed" && (
            <div className="space-y-3">
              <p
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 break-words">{state.error}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                No draft was produced. Retry drafting, or start a plain Multi Review from the
                toolbar.
              </p>
              <Button type="button" onClick={startDrafting}>
                Retry drafting
              </Button>
            </div>
          )}
          {state?.phase === "promoted" && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm"
            >
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
              Auto-pipeline started. The ticket was created and the pipeline continues from Review.
              You can close this tab.
            </p>
          )}
          {draft && edits && (
            <fieldset disabled={promoting} className="min-w-0 border-0">
              {currentStep === "details" && (
                <div className="space-y-5">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${fieldId}-title`}>Title</Label>
                    <Input
                      id={`${fieldId}-title`}
                      value={edits.title}
                      maxLength={240}
                      aria-invalid={!edits.title.trim()}
                      onChange={(event) =>
                        change({ ...edits, title: event.target.value.replace(/[\r\n]+/g, " ") })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="text-sm font-medium">Description</h3>
                    <AutoPipelineDescriptionField
                      value={edits.description}
                      disabled={promoting}
                      onChange={(description) => change({ ...edits, description })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Markdown. Click the description to edit it; click away to preview.
                    </p>
                  </div>
                </div>
              )}
              {currentStep === "criteria" && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Each criterion is checked independently by Verify.
                  </p>
                  <AutoPipelineCriteriaField
                    criteria={edits.acceptanceCriteria}
                    onChange={(acceptanceCriteria) => change({ ...edits, acceptanceCriteria })}
                  />
                </div>
              )}
              {currentStep === "confirm" && (
                <div className="space-y-5">
                  {Object.keys(problems).length > 0 && (
                    <ul
                      aria-label="Before confirming"
                      className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                    >
                      {problems.details && <li>Details: {problems.details}</li>}
                      {problems.criteria && <li>Acceptance criteria: {problems.criteria}</li>}
                    </ul>
                  )}
                  <section className="space-y-1.5">
                    <h3 className="text-sm font-medium">Ticket</h3>
                    <div className="rounded-md border border-border/70 bg-input-surface px-4 py-3 text-sm">
                      <p className="font-medium">{edits.title || "Untitled"}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {edits.acceptanceCriteria.length} acceptance criteria
                      </p>
                    </div>
                  </section>
                  <section className="space-y-1.5">
                    <h3 className="text-sm font-medium">
                      Build notes{" "}
                      <span className="font-normal text-muted-foreground">(read-only)</span>
                    </h3>
                    <div className="rounded-md border border-border/70 bg-input-surface px-4 py-3">
                      <AutoPipelineBuildNotes notes={draft.notes} />
                    </div>
                  </section>
                  <section className="space-y-1.5">
                    <h3 className="text-sm font-medium">Files to commit</h3>
                    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-input-surface px-3 py-2 font-mono text-xs">
                      {draft.uncommittedFiles.join("\n") || "No uncommitted files"}
                    </pre>
                  </section>
                  <p className="text-xs text-muted-foreground">
                    Confirm closes this environment&apos;s terminal shells, including the one setup
                    leaves open, so nothing writes while the work is committed. It then commits the
                    files above, creates the ticket and adopts the source tab as the finished Build
                    step.
                  </p>
                </div>
              )}
            </fieldset>
          )}
        </div>
      </div>

      {draft && edits && (
        <footer className="shrink-0 border-t border-divider px-5 py-3 sm:px-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
            {(confirmError || promoting) && (
              <div>
                {promoting ? (
                  <p
                    role="status"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Loader2
                      aria-hidden="true"
                      data-testid="auto-pipeline-spinner"
                      className="size-4 shrink-0 animate-spin text-primary"
                    />
                    Promoting environment: closing terminals, committing pending files and starting
                    the pipeline…
                  </p>
                ) : (
                  <p
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 break-words">{confirmError}</span>
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={promoting}
                onClick={startDrafting}
              >
                <RotateCcw />
                Draft again
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                {currentStep !== "details" && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={promoting}
                    onClick={() => setStep(currentStep === "confirm" ? "criteria" : "details")}
                  >
                    Back
                  </Button>
                )}
                {currentStep !== "confirm" ? (
                  <Button
                    type="button"
                    onClick={() => setStep(currentStep === "details" ? "criteria" : "confirm")}
                  >
                    Next
                  </Button>
                ) : (
                  <Button
                    type="button"
                    disabled={promoting || Object.keys(problems).length > 0}
                    title={Object.values(problems)[0]}
                    onClick={() => void confirm()}
                  >
                    {promoting && <Loader2 className="animate-spin" />}
                    Confirm Auto-pipeline
                  </Button>
                )}
              </div>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
