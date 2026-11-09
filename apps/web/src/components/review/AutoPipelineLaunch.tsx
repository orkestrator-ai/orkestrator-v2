import { AutoPipelineBuildNotes } from "./AutoPipelineBuildNotes";
import { useEffect, useState, useRef } from "react";
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
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
    setBusy(true);
    setOpen(true);
    setError(null);
    try {
      const value = await backend.draftAutoPipeline(environmentId, tabId);
      if (request === generation.current) setDraft(value);
    } catch (failure) {
      if (request === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request === generation.current) setBusy(false);
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
        <DialogContent className="max-h-[90vh] overflow-y-auto [--modal-max-width:48rem]">
          <DialogHeader>
            <DialogTitle>Review Auto-pipeline draft</DialogTitle>
            <DialogDescription>
              Confirm creates a ticket, commits the listed pending files and adopts this tab as the
              finished Build step.
            </DialogDescription>
          </DialogHeader>
          {busy && (
            <p role="status">
              {draft ? "Promoting environment…" : "Drafting ticket and Build notes…"}
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
              <label className="block text-sm">
                Description
                <textarea
                  className="mt-1 block min-h-32 w-full rounded border bg-background p-2"
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <div>
                <h3 className="text-sm font-semibold">Acceptance criteria</h3>
                {draft.acceptanceCriteria.map((criterion, index) => (
                  <div key={index} className="my-2 flex flex-wrap gap-2">
                    <input
                      aria-label={`Criterion ${index + 1}`}
                      className="min-w-0 flex-1 rounded border bg-background p-2"
                      value={criterion}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          acceptanceCriteria: draft.acceptanceCriteria.map((value, i) =>
                            i === index ? event.target.value : value,
                          ),
                        })
                      }
                    />
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
              </div>
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
                    setDraft(null);
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
