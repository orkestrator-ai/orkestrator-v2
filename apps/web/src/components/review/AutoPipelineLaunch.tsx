import { AutoPipelineBuildNotes } from "./AutoPipelineBuildNotes";
import { AutoPipelineDescriptionField } from "./AutoPipelineDescriptionField";
import { AutoPipelineCriteriaField } from "./AutoPipelineCriteriaField";
import { useEffect, useId, useState, useRef } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AutoPipelineDraft, AutoPipelineSources } from "@orkestrator/protocol/build-pipeline";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type DraftTab = "description" | "criteria";
/** Both panels share one height (editor plus a wrapped hint), so switching tabs never moves the dialog. */
const TAB_PANEL = "min-h-[calc(min(55vh,34rem)+2.5rem)]";

/** Only the manual toolbar supplies an environment; coordinator reviews never mount this. */
export function AutoPipelineLaunch({
  environmentId,
  onPromoted,
}: {
  environmentId: string;
  onPromoted: () => void;
}) {
  const backend = useScopeBackend();
  const fieldId = useId();
  const [sources, setSources] = useState<AutoPipelineSources | null>(null);
  const [tabId, setTabId] = useState("");
  const [draft, setDraft] = useState<AutoPipelineDraft | null>(null);
  const [tab, setTab] = useState<DraftTab>("description");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const draftingTab = useRef<string | null>(null);
  const descriptionEditor = useRef<HTMLTextAreaElement>(null);
  useEffect(
    () => () => {
      if (draftingTab.current)
        void backend
          .cancelAutoPipelineDraft(environmentId, draftingTab.current)
          .catch(() => undefined);
    },
    [backend, environmentId],
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      void backend
        .autoPipelineSources(environmentId)
        .then(
          (value) => {
            if (disposed) return;
            setSources(value);
            setTabId((current) =>
              value.sources.some((source) => source.tabId === current)
                ? current
                : (value.sources[0]?.tabId ?? ""),
            );
          },
          () => {
            if (!disposed) setSources(null);
          },
        )
        .finally(() => {
          refreshing = false;
        });
    };
    refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      clearInterval(timer);
      disposed = true;
    };
  }, [backend, environmentId]);
  const selected = sources?.sources.find((source) => source.tabId === tabId);
  const confirmBlocked =
    !draft ||
    !draft.title.trim() ||
    !draft.description.trim() ||
    !draft.acceptanceCriteria.length ||
    draft.acceptanceCriteria.some((value) => !value.trim());
  async function generate() {
    if (busy || !selected || selected.disabledReason) return;
    const request = ++generation.current;
    draftingTab.current = tabId;
    setDraft(null);
    setBusy(true);
    setOpen(true);
    setError(null);
    try {
      const value = await backend.draftAutoPipeline(environmentId, tabId);
      if (request === generation.current) {
        setDraft(value);
        setTab("description");
      }
    } catch (failure) {
      if (request === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request === generation.current) {
        draftingTab.current = null;
        setBusy(false);
      }
    }
  }
  async function confirm() {
    if (!draft || busy || confirmBlocked) return;
    setBusy(true);
    setError(null);
    try {
      await backend.confirmAutoPipeline(draft.id, {
        title: draft.title,
        description: draft.description,
        acceptanceCriteria: draft.acceptanceCriteria,
      });
      setOpen(false);
      toast.success("Auto-pipeline started", {
        description: "The ticket was created and the pipeline continues from Review.",
      });
      onPromoted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  function closeDraft() {
    if (busy && draft) return;
    if (draftingTab.current) {
      void backend
        .cancelAutoPipelineDraft(environmentId, draftingTab.current)
        .catch(() => undefined);
      draftingTab.current = null;
    }
    generation.current++;
    setDraft(null);
    setOpen(false);
    setBusy(false);
  }
  if (!sources?.available || !sources.sources.length) return null;
  const promoting = busy && !!draft;
  return (
    <section className="mx-5 mt-5 rounded-lg border border-divider p-4 sm:mx-6">
      <h3 className="text-sm font-semibold">Auto-pipeline</h3>
      <p className="mb-3 text-xs text-zinc-500">
        Turn finished work into a ticket and continue from Review through verification and delivery.
        Review the draft before anything is created.
      </p>
      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor={`${fieldId}-source`} className="shrink-0 text-xs font-medium text-zinc-400">
          Build transcript
        </label>
        <NativeSelect
          id={`${fieldId}-source`}
          aria-label="Build transcript"
          size="sm"
          wrapperClassName="flex-1"
          value={tabId}
          disabled={busy}
          onChange={(event) => setTabId(event.target.value)}
        >
          {sources.sources.map((source) => (
            <option key={source.tabId} value={source.tabId}>
              {source.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {selected?.disabledReason && (
        <p role="status" className="my-2 text-xs text-muted-foreground">
          {selected.disabledReason}
        </p>
      )}
      <Button
        type="button"
        className="mt-3"
        disabled={busy || !selected || !!selected.disabledReason}
        onClick={() => void generate()}
      >
        Auto-pipeline
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) closeDraft();
        }}
      >
        <DialogContent
          aria-busy={busy}
          showCloseButton={!promoting}
          className="flex max-h-[min(56rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 [--modal-max-width:64rem] sm:p-0"
          onEscapeKeyDown={(event) => {
            const editor = descriptionEditor.current;
            if (editor && editor.ownerDocument.activeElement === editor) {
              event.preventDefault();
              editor.blur();
            }
          }}
        >
          <DialogHeader className="m-0 shrink-0 px-5 pb-4 pt-5 sm:m-0 sm:px-6">
            <DialogTitle className="text-base">Review Auto-pipeline draft</DialogTitle>
            <DialogDescription>
              Confirm creates a ticket, commits the listed pending files and adopts this tab as the
              finished Build step.
            </DialogDescription>
          </DialogHeader>
          <div
            role="region"
            aria-label="Auto-pipeline draft"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6"
          >
            {busy && !draft && (
              <p
                role="status"
                className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
              >
                <Loader2
                  aria-hidden="true"
                  data-testid="auto-pipeline-spinner"
                  className="size-4 shrink-0 animate-spin text-primary"
                />
                Drafting ticket and Build notes…
              </p>
            )}
            {!draft && error && (
              <p className="py-2 text-sm text-muted-foreground">
                No draft was produced. Retry drafting or continue with a plain Multi Review.
              </p>
            )}
            {draft && (
              <fieldset disabled={busy} className="min-w-0 space-y-5 border-0">
                <div className="space-y-1.5">
                  <Label htmlFor={`${fieldId}-title`}>Title</Label>
                  <Input
                    id={`${fieldId}-title`}
                    value={draft.title}
                    maxLength={240}
                    aria-invalid={!draft.title.trim()}
                    onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  />
                </div>
                <Tabs value={tab} onValueChange={(value) => setTab(value as DraftTab)}>
                  <TabsList className="w-full">
                    <TabsTrigger value="description">Description</TabsTrigger>
                    <TabsTrigger value="criteria">
                      Acceptance criteria ({draft.acceptanceCriteria.length})
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="description" className={`${TAB_PANEL} space-y-1.5 pt-1`}>
                    <AutoPipelineDescriptionField
                      inputRef={descriptionEditor}
                      value={draft.description}
                      disabled={busy}
                      onChange={(description) => setDraft({ ...draft, description })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Markdown. Click the description to edit it; click away to preview.
                    </p>
                  </TabsContent>
                  <TabsContent value="criteria" className={`${TAB_PANEL} pt-1`}>
                    <AutoPipelineCriteriaField
                      criteria={draft.acceptanceCriteria}
                      onChange={(acceptanceCriteria) => setDraft({ ...draft, acceptanceCriteria })}
                    />
                  </TabsContent>
                </Tabs>
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
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-input-surface px-3 py-2 font-mono text-xs">
                    {draft.uncommittedFiles.join("\n") || "No uncommitted files"}
                  </pre>
                </section>
              </fieldset>
            )}
          </div>
          {/* Outcome sits beside the buttons, so a refusal is visible wherever the body is scrolled. */}
          {(error || promoting) && (
            <div className="shrink-0 border-t border-divider px-5 py-3 sm:px-6">
              {error ? (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 break-words">{error}</span>
                </p>
              ) : (
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2
                    aria-hidden="true"
                    data-testid="auto-pipeline-spinner"
                    className="size-4 shrink-0 animate-spin text-primary"
                  />
                  Promoting environment: committing pending files and starting the pipeline…
                </p>
              )}
            </div>
          )}
          <DialogFooter className="m-0 shrink-0 flex-row flex-wrap justify-end border-t border-divider px-5 py-4 sm:m-0 sm:px-6">
            <Button type="button" variant="outline" disabled={promoting} onClick={closeDraft}>
              Cancel
            </Button>
            {error && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void generate();
                  }}
                >
                  Retry drafting
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                >
                  Plain Multi Review
                </Button>
              </>
            )}
            {draft && (
              <Button
                type="button"
                disabled={busy || confirmBlocked}
                onClick={() => void confirm()}
              >
                {promoting && <Loader2 className="animate-spin" />}
                Confirm Auto-pipeline
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
