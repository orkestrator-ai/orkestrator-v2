import { AutoPipelineBuildNotes } from "./AutoPipelineBuildNotes";
import { AutoPipelineDescriptionField } from "./AutoPipelineDescriptionField";
import { useEffect, useState, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { AutoPipelineDraft, AutoPipelineSources } from "@orkestrator/protocol/build-pipeline";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { Button } from "@/components/ui/button";
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
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      await backend.confirmAutoPipeline(draft.id, {
        title: draft.title,
        description: draft.description,
        acceptanceCriteria: draft.acceptanceCriteria,
      });
      setOpen(false);
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
    setOpen(false);
    setBusy(false);
  }
  if (!sources?.available || !sources.sources.length) return null;
  return (
    <section className="mx-5 my-4 rounded-lg border border-divider p-4">
      <h3 className="font-semibold">Auto-pipeline</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Turn finished work into a ticket and continue from Review through verification and delivery.
        Review the draft before anything is created.
      </p>
      <label className="block text-sm">
        Build transcript
        <select
          aria-label="Build transcript"
          value={tabId}
          disabled={busy}
          onChange={(event) => setTabId(event.target.value)}
          className="mx-2 rounded border bg-background p-2"
        >
          {sources.sources.map((source) => (
            <option key={source.tabId} value={source.tabId}>
              {source.label}
            </option>
          ))}
        </select>
      </label>
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
          className="max-h-[90vh] overflow-y-auto [--modal-max-width:64rem]"
          onEscapeKeyDown={(event) => {
            const editor = descriptionEditor.current;
            if (editor && editor.ownerDocument.activeElement === editor) {
              event.preventDefault();
              editor.blur();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Review Auto-pipeline draft</DialogTitle>
            <DialogDescription>
              Confirm creates a ticket, commits the listed pending files and adopts this tab as the
              finished Build step.
            </DialogDescription>
          </DialogHeader>
          {busy && (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Loader2
                aria-hidden="true"
                data-testid="auto-pipeline-spinner"
                className="size-4 shrink-0 animate-spin text-primary"
              />
              <span>{draft ? "Promoting environment…" : "Drafting ticket and Build notes…"}</span>
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {draft && (
            <fieldset disabled={busy} className="space-y-4">
              <label className="block text-sm">
                Title
                <input
                  className="mt-1 block w-full rounded border bg-background p-2"
                  value={draft.title}
                  maxLength={240}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
              <Tabs value={tab} onValueChange={(value) => setTab(value as DraftTab)}>
                <TabsList className="w-full">
                  <TabsTrigger value="description">Description</TabsTrigger>
                  <TabsTrigger value="criteria">
                    Acceptance criteria ({draft.acceptanceCriteria.length})
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="description" className={`${TAB_PANEL} space-y-1`}>
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
                <TabsContent value="criteria" className={TAB_PANEL}>
                  {draft.acceptanceCriteria.map((criterion, index) => (
                    <div key={index} className="my-2 flex flex-wrap items-start gap-2">
                      <div className="min-w-[min(100%,18rem)] flex-1">
                        <textarea
                          aria-label={`Criterion ${index + 1}`}
                          rows={1}
                          aria-invalid={!criterion.trim()}
                          aria-describedby={
                            !criterion.trim() ? `criterion-${index}-error` : undefined
                          }
                          className="field-sizing-content min-h-9 w-full resize-none rounded border bg-background p-2 text-sm"
                          value={criterion}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              acceptanceCriteria: draft.acceptanceCriteria.map((value, i) =>
                                i === index ? event.target.value.replace(/[\r\n]+/g, " ") : value,
                              ),
                            })
                          }
                        />
                        {!criterion.trim() && (
                          <p
                            id={`criterion-${index}-error`}
                            className="mt-1 text-xs text-destructive"
                          >
                            Enter an acceptance criterion.
                          </p>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={index === 0}
                        aria-label={`Move criterion ${index + 1} up`}
                        onClick={() => {
                          const criteria = [...draft.acceptanceCriteria];
                          [criteria[index - 1], criteria[index]] = [
                            criteria[index]!,
                            criteria[index - 1]!,
                          ];
                          setDraft({ ...draft, acceptanceCriteria: criteria });
                        }}
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`Remove criterion ${index + 1}`}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            acceptanceCriteria: draft.acceptanceCriteria.filter(
                              (_, i) => i !== index,
                            ),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setDraft({ ...draft, acceptanceCriteria: [...draft.acceptanceCriteria, ""] })
                    }
                  >
                    Add criterion
                  </Button>
                </TabsContent>
              </Tabs>
              <section>
                <h3 className="text-sm font-semibold">Build notes (read-only)</h3>
                <AutoPipelineBuildNotes notes={draft.notes} />
              </section>
              <section>
                <h3 className="text-sm font-semibold">Files to commit</h3>
                <pre className="whitespace-pre-wrap break-words text-xs">
                  {draft.uncommittedFiles.join("\n") || "No uncommitted files"}
                </pre>
              </section>
            </fieldset>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy && !!draft} onClick={closeDraft}>
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
                disabled={
                  busy ||
                  !draft.title.trim() ||
                  !draft.description.trim() ||
                  !draft.acceptanceCriteria.length ||
                  draft.acceptanceCriteria.some((value) => !value.trim())
                }
                onClick={() => void confirm()}
              >
                Confirm Auto-pipeline
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
