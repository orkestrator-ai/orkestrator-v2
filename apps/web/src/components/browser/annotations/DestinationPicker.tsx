import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import {
  WEB_ANNOTATION_COMMANDS,
  type WebAnnotationDestination,
  type WebAnnotationDestinationOption,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import {
  describeWebAnnotationError,
  newWebAnnotationOperationId,
  webAnnotationCommand,
} from "@/lib/web-annotations/client";
import { openNewAgentSession } from "@/lib/web-annotations/navigation";
import { refreshWebAnnotations } from "@/lib/web-annotations/sync";
import { cn } from "@/lib/utils";
import {
  rememberedDestinationTabId,
  useWebAnnotationPreferencesStore,
} from "@/stores/webAnnotationPreferencesStore";

/** Last destination chosen per environment (a persisted preference; preselects only). */
export { rememberedDestinationTabId };

const HOLD_LABELS: Record<WebAnnotationDestinationOption["holds"][number], string> = {
  "compose-draft": "An unsent draft in this chat will hold the queue",
  "parked-dispatch": "An earlier prompt needs attention before this runs",
  "queued-prompts": "Queued prompts run first",
};

const ACTIVITY_LABELS: Record<WebAnnotationDestinationOption["activity"], string> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting for input",
  unknown: "Activity unknown",
};

/** Image support, labelled by how it was determined (the model, or only the agent). */
export function imageSupportLabel(option: WebAnnotationDestinationOption): string {
  if (!option.images) return "Text only";
  return option.imageSupport === "agent"
    ? "Images supported by the agent (model not verified)"
    : "Images supported";
}

export function destinationName(destination: WebAnnotationDestination | null | undefined) {
  if (!destination) return "an agent";
  return destination.label ?? destination.agent;
}

/**
 * Explicit destination choice. A remembered default is displayed on the
 * action buttons but never sends anything by itself.
 */
export function DestinationPicker({
  environmentId,
  value,
  onChange,
  fallback,
  defaultFor,
  excludeTabId,
}: {
  environmentId: string;
  value: WebAnnotationDestinationOption | null;
  onChange: (option: WebAnnotationDestinationOption | null) => void;
  /** Annotation-level default destination, if any. */
  fallback?: WebAnnotationDestination | null;
  /** Persist the choice as this annotation's default destination. */
  defaultFor?: { annotationId: string; metadataRevision: number } | null;
  /** A session this choice must not return to (the one being retargeted away from). */
  excludeTabId?: string | null;
}) {
  const [options, setOptions] = useState<WebAnnotationDestinationOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.destinations, {
        environmentId,
      });
      const usable = excludeTabId
        ? result.options.filter((option) => option.destination.tabId !== excludeTabId)
        : result.options;
      setOptions(usable);
      return usable;
    } catch (loadError) {
      setError(describeWebAnnotationError(loadError));
      return null;
    } finally {
      setLoading(false);
    }
  }, [environmentId, excludeTabId]);

  const valueTabId = value?.destination.tabId ?? null;
  // Preselect once per load; later renders must not override a user choice.
  const latest = useRef({ onChange, fallback, valueTabId });
  latest.current = { onChange, fallback, valueTabId };
  useEffect(() => {
    void load().then((loaded) => {
      const { onChange: select, fallback: annotationDefault, valueTabId: chosen } = latest.current;
      if (!loaded || chosen) return;
      const remembered = rememberedDestinationTabId(environmentId);
      // The note's own default is the most specific choice; the last
      // destination used in this environment comes next. Both only preselect.
      const preferred =
        loaded.find(
          (option) => annotationDefault && option.destination.tabId === annotationDefault.tabId,
        ) ??
        loaded.find((option) => option.destination.tabId === remembered) ??
        loaded.find((option) => option.isDefault) ??
        null;
      if (preferred) select(preferred);
    });
  }, [environmentId, load]);

  const choose = (option: WebAnnotationDestinationOption) => {
    onChange(option);
    useWebAnnotationPreferencesStore
      .getState()
      .rememberDestination(environmentId, option.destination.tabId);
    if (defaultFor) {
      void webAnnotationCommand(WEB_ANNOTATION_COMMANDS.update, {
        environmentId,
        operationId: newWebAnnotationOperationId("default-destination"),
        annotationId: defaultFor.annotationId,
        expectedMetadataRevision: defaultFor.metadataRevision,
        defaultDestination: option.destination,
      })
        .then(() =>
          refreshWebAnnotations(environmentId, { annotationIds: [defaultFor.annotationId] }),
        )
        .catch(() => undefined);
    }
  };

  return (
    <fieldset className="space-y-1.5">
      <legend className="flex w-full items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>Agent session</span>
        <span className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={() => void load()}
            aria-label="Refresh agent sessions"
          >
            <RefreshCw
              className={cn("h-3 w-3", loading && "motion-safe:animate-spin")}
              aria-hidden
            />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={() => {
              const opened = openNewAgentSession(environmentId);
              setNotice(
                opened
                  ? "A new agent tab opened. Choose its agent there, then refresh this list. Nothing was sent."
                  : "Could not open a new agent tab here.",
              );
            }}
          >
            <Plus className="h-3 w-3" aria-hidden />
            New agent session
          </Button>
        </span>
      </legend>
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
      {notice && <p className="text-[11px] text-muted-foreground">{notice}</p>}
      {options === null ? (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden /> Loading sessions…
        </p>
      ) : options.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No agent sessions in this environment yet. Open a new agent session to discuss or request
          changes.
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label="Agent session"
          className="max-h-44 space-y-1 overflow-y-auto"
        >
          {options.map((option) => {
            const selected = valueTabId === option.destination.tabId;
            return (
              <button
                key={option.destination.tabId}
                type="button"
                role="radio"
                aria-checked={selected}
                data-destination={option.destination.tabId}
                onClick={() => choose(option)}
                className={cn(
                  "block w-full rounded border px-2 py-1.5 text-left text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "border-primary/60 bg-primary/10" : "border-border/60",
                )}
              >
                <span className="block truncate font-medium text-foreground">
                  {option.title}
                  {option.isDefault ? " · default" : ""}
                </span>
                <span className="block text-muted-foreground">
                  {option.destination.agent}
                  {option.model ? ` · ${option.model}` : ""} · {ACTIVITY_LABELS[option.activity]} ·{" "}
                  {imageSupportLabel(option)}
                </span>
                <span className="block text-muted-foreground">
                  {option.planMode
                    ? "Discuss uses read-only plan mode"
                    : "Discuss is advisory (no read-only mode)"}
                  {option.resultTools ? " · reports structured results" : ""}
                </span>
                {option.holds.map((hold) => (
                  <span key={hold} className="block text-amber-200">
                    {HOLD_LABELS[hold]}
                  </span>
                ))}
              </button>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
