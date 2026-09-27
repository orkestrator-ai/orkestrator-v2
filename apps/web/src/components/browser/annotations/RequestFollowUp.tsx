/**
 * "Send remaining work": preview which notes of a settled request still need
 * work (backend-chosen defaults, `web_annotation_request_follow_up`) and which
 * are left out and why, then open the composer for a follow-up request
 * (`followUpOf`). Nothing is sent from here.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  WEB_ANNOTATION_COMMANDS,
  type WebAnnotationFollowUpCandidates,
  type WebAnnotationRequest,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { useWebAnnotationCache } from "@/hooks/useWebAnnotations";
import { describeWebAnnotationError, webAnnotationCommand } from "@/lib/web-annotations/client";
import { annotationTitle } from "./format";
import { useAnnotationPanel } from "./panel-context";
import type { ComposerItem } from "./RequestComposer";

const REMAINING_REASONS: Record<
  WebAnnotationFollowUpCandidates["remaining"][number]["reason"],
  string
> = {
  "not-addressed": "not addressed yet",
  unreported: "no outcome was reported",
  "request-failed": "the request failed",
  "changed-since": "the note changed since it was sent",
};

const EXCLUDED_REASONS: Record<
  WebAnnotationFollowUpCandidates["excluded"][number]["reason"],
  string
> = {
  accepted: "accepted",
  deleted: "deleted",
  archived: "archived",
  addressed: "reported addressed",
};

/** Excluded items the user may still add back (deleted/archived ones cannot run). */
function includable(reason: WebAnnotationFollowUpCandidates["excluded"][number]["reason"]) {
  return reason === "accepted" || reason === "addressed";
}

export function RequestFollowUp({
  request,
  onPrepare,
  onClose,
}: {
  request: WebAnnotationRequest;
  onPrepare: (items: ComposerItem[], followUpOf: string) => void;
  onClose: () => void;
}) {
  const { environmentId } = useAnnotationPanel();
  const cache = useWebAnnotationCache(environmentId);
  const [candidates, setCandidates] = useState<WebAnnotationFollowUpCandidates | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [continuing, setContinuing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void webAnnotationCommand(WEB_ANNOTATION_COMMANDS.requestFollowUp, {
      environmentId,
      requestId: request.id,
    })
      .then((result) => {
        if (cancelled) return;
        setCandidates(result);
        setSelected(new Set(result.remaining.map((item) => item.annotationId)));
      })
      .catch((caught) => {
        if (!cancelled) setError(describeWebAnnotationError(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, request.id]);

  const title = (annotationId: string, reference: number) => {
    const summary = cache.summaries.get(annotationId);
    return summary ? `#${reference} ${annotationTitle(summary)}` : `Note #${reference}`;
  };

  const toggle = (annotationId: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(annotationId);
    else next.delete(annotationId);
    setSelected(next);
  };

  const proceed = async () => {
    if (!candidates || selected.size === 0) return;
    setContinuing(true);
    setError(null);
    try {
      // The composer checks every note against its current revisions, so
      // read them now rather than trusting the request's older selection.
      const ids = [
        ...candidates.remaining.map((item) => item.annotationId),
        ...candidates.excluded.map((item) => item.annotationId),
      ].filter((id, index, all) => selected.has(id) && all.indexOf(id) === index);
      const items: ComposerItem[] = [];
      for (const annotationId of ids) {
        const { annotation } = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.get, {
          environmentId,
          annotationId,
          entryLimit: 1,
        });
        items.push({ annotation });
      }
      onPrepare(items, request.id);
    } catch (caught) {
      setError(describeWebAnnotationError(caught));
    } finally {
      setContinuing(false);
    }
  };

  return (
    <section
      aria-label="Send remaining work"
      className="space-y-1.5 rounded border border-border/60 bg-muted/10 p-1.5"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <p className="font-medium">Send remaining work</p>
      {loading && (
        <p className="flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden /> Checking what
          remains…
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {candidates && (
        <>
          {candidates.remaining.length === 0 && (
            <p className="text-muted-foreground">
              Nothing remains: every note was accepted or reported addressed. You can still add
              notes back below.
            </p>
          )}
          <ul className="space-y-0.5" aria-label="Follow-up notes">
            {candidates.remaining.map((item) => (
              <li key={item.annotationId} data-follow-up="remaining">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={selected.has(item.annotationId)}
                    onChange={(event) => toggle(item.annotationId, event.target.checked)}
                  />
                  <span>
                    {title(item.annotationId, item.reference)}{" "}
                    <span className="text-muted-foreground">
                      — {REMAINING_REASONS[item.reason]}
                    </span>
                  </span>
                </label>
              </li>
            ))}
            {candidates.excluded.map((item) => (
              <li key={item.annotationId} data-follow-up="excluded">
                <label className="flex items-center gap-1.5 text-muted-foreground">
                  <input
                    type="checkbox"
                    disabled={!includable(item.reason)}
                    checked={selected.has(item.annotationId)}
                    onChange={(event) => toggle(item.annotationId, event.target.checked)}
                  />
                  <span>
                    {title(item.annotationId, item.reference)} — left out:{" "}
                    {EXCLUDED_REASONS[item.reason]}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            The follow-up links to this request and summarizes its result for the agent.
          </p>
        </>
      )}
      <div className="flex gap-1.5">
        <Button
          type="button"
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={!candidates || selected.size === 0 || continuing}
          onClick={() => void proceed()}
        >
          {continuing && <Loader2 className="mr-1 h-3 w-3 motion-safe:animate-spin" aria-hidden />}
          Continue with {selected.size} note{selected.size === 1 ? "" : "s"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}
