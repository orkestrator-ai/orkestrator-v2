import { useEffect, useId, useState } from "react";
import type { AutoPipelineSources } from "@orkestrator/protocol/build-pipeline";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { AutoPipelineTabData } from "@/types/paneLayout";

/**
 * Picks the finished agent tab to promote, starts drafting in the backend and
 * hands the rest to an `auto-pipeline` tab, so the user can leave while it
 * drafts. Only the manual toolbar supplies an environment; coordinator reviews
 * never mount this.
 */
export function AutoPipelineLaunch({
  environmentId,
  onOpenTab,
}: {
  environmentId: string;
  /** Opens (or focuses) the environment's Auto-pipeline tab; false when it could not. */
  onOpenTab: (target: AutoPipelineTabData) => boolean;
}) {
  const backend = useScopeBackend();
  const fieldId = useId();
  const [sources, setSources] = useState<AutoPipelineSources | null>(null);
  const [tabId, setTabId] = useState("");
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
  function start() {
    if (!selected || selected.disabledReason) return;
    // The backend owns drafting and records its outcome; the tab reads it, so
    // nothing here waits for (or cancels) the draft.
    void backend.draftAutoPipeline(environmentId, selected.tabId).catch(() => undefined);
    onOpenTab({ sourceTabId: selected.tabId, sourceLabel: selected.label });
  }
  if (!sources?.available || !sources.sources.length) return null;
  return (
    <section className="mx-5 mt-5 rounded-lg border border-divider p-4 sm:mx-6">
      <h3 className="text-sm font-semibold">Auto-pipeline</h3>
      <p className="mb-3 text-xs text-zinc-500">
        Turn finished work into a ticket and continue from Review through verification and delivery.
        The draft opens in its own tab for review before anything is created.
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
        disabled={!selected || !!selected.disabledReason}
        onClick={start}
      >
        Auto-pipeline
      </Button>
    </section>
  );
}
