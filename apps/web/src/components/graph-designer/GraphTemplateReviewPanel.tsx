import { useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, ShieldAlert, ShieldX, X } from "lucide-react";
import type {
  GraphProjectTemplateReview,
  GraphProjectTemplateReviewItem,
  GraphTemplateReviewDiff,
  GraphTemplateReviewDiffUnavailable,
} from "@orkestrator/protocol/graphs/sharing";
import { Button } from "@/components/ui/button";
import {
  decideGraphProjectTemplateReview,
  reviewGraphProjectTemplates,
} from "@/lib/backend/graph-template-sharing";
import { onResourceChanged } from "@/lib/resource-sync";
import { cn } from "@/lib/utils";
import { GraphCapabilitySummaryView, GraphCompileCounts } from "./GraphCapabilitySummary";

/**
 * The project template review (item 405, report §6.9): every project
 * template that is untrusted or changed since its approval, with what it would
 * be allowed to do and, for a changed one, a diff against the last approved
 * copy. Approve trusts the reviewed digest (refused when the file changed in
 * the meantime); Reject keeps it untrusted and files that digest under
 * "Rejected" until the file changes again.
 *
 * The list is a backend snapshot, re-read on mount, on a `graph-template`
 * change and after every decision.
 */

const UNAVAILABLE_TEXT: Record<GraphTemplateReviewDiffUnavailable, string> = {
  "never-approved": "Never approved: there is no earlier version to compare with.",
  "not-kept": "The approved version was not kept, so there is nothing to compare with.",
  "too-large": "The template is too large to compare.",
  "edit-distance": "Too much changed to show a line diff.",
  "cpu-budget": "The comparison took too long to show.",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

export function GraphReviewDiff({ diff }: { diff: GraphTemplateReviewDiff }) {
  return (
    <div data-graph-review-diff="" className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">
        Since the approved version <span className="font-mono">{shortDigest(diff.fromDigest)}</span>
        : <span className="text-emerald-300">+{diff.additions}</span>{" "}
        <span className="text-failure">−{diff.deletions}</span>
        {diff.truncated ? " (not every line is shown)" : ""}
      </p>
      {diff.hunks.length > 0 ? (
        <pre className="max-h-72 overflow-auto rounded border border-border bg-muted/30 text-[11px] leading-4">
          {diff.hunks.map((hunk, hunkIndex) => (
            <div key={`${hunk.header}:${hunkIndex}`}>
              <div className="bg-muted/60 px-2 text-muted-foreground">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => (
                <div
                  key={lineIndex}
                  data-diff-line={line.type}
                  className={cn(
                    "px-2 whitespace-pre-wrap break-all",
                    line.type === "add" && "bg-emerald-500/10 text-emerald-300",
                    line.type === "remove" && "bg-red-500/10 text-red-300",
                    line.type === "no-newline" && "text-muted-foreground",
                  )}
                >
                  {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                  {line.text.replace(/\n$/, "")}
                </div>
              ))}
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

function ReviewItem({
  item,
  busy,
  onDecide,
}: {
  item: GraphProjectTemplateReviewItem;
  busy: "approve" | "reject" | null;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  const changed = item.trust === "changed";
  const Icon = changed ? ShieldAlert : ShieldX;
  return (
    <article
      data-graph-review-item={item.path}
      aria-label={`Review ${item.name}`}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <header className="flex flex-wrap items-start gap-2">
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{item.name}</h3>
          <p className="font-mono text-[11px] break-all text-muted-foreground">{item.path}</p>
          <p className="text-[11px] text-muted-foreground">
            {changed ? "Changed since it was approved" : "Not approved"} · digest{" "}
            <span className="font-mono" title={item.digest}>
              {shortDigest(item.digest)}
            </span>
            {item.rejectedAt ? ` · rejected ${item.rejectedAt}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => onDecide("reject")}
            aria-label={`Reject ${item.name}`}
          >
            {busy === "reject" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <X className="size-3.5" />
            )}
            Reject
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => onDecide("approve")}
            aria-label={`Approve ${item.name}`}
          >
            {busy === "approve" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            Approve
          </Button>
        </div>
      </header>
      {item.description ? <p className="text-xs text-foreground">{item.description}</p> : null}
      <GraphCompileCounts compile={item.compile} />
      <GraphCapabilitySummaryView summary={item.capabilities} />
      {item.diff ? (
        <GraphReviewDiff diff={item.diff} />
      ) : item.diffUnavailable ? (
        <p
          data-graph-review-no-diff={item.diffUnavailable}
          className="text-xs text-muted-foreground"
        >
          {UNAVAILABLE_TEXT[item.diffUnavailable]}
        </p>
      ) : null}
    </article>
  );
}

export function GraphTemplateReviewPanel({
  projectId,
  onDecided,
}: {
  projectId: string;
  /** After a decision lands (the library re-reads its trust states). */
  onDecided?: (decision: "approve" | "reject", item: GraphProjectTemplateReviewItem) => void;
}) {
  const [review, setReview] = useState<GraphProjectTemplateReview | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ path: string; decision: "approve" | "reject" } | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  // Bumped to re-read the snapshot (a change announcement, Refresh, a decision).
  const [generation, setGeneration] = useState(0);
  const load = () => {
    setStatus("loading");
    setGeneration((value) => value + 1);
  };

  useEffect(() => {
    let cancelled = false;
    reviewGraphProjectTemplates(projectId).then(
      (snapshot) => {
        if (cancelled) return;
        setReview(snapshot);
        setError(null);
        setStatus("ready");
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(errorText(failure));
        setStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, generation]);

  useEffect(
    () => onResourceChanged("graph-template", () => setGeneration((value) => value + 1)),
    [],
  );

  const decide = async (item: GraphProjectTemplateReviewItem, decision: "approve" | "reject") => {
    setBusy({ path: item.path, decision });
    setDecisionError(null);
    try {
      await decideGraphProjectTemplateReview({
        projectId,
        path: item.path,
        digest: item.digest,
        decision,
      });
      onDecided?.(decision, item);
    } catch (failure) {
      setDecisionError(errorText(failure));
    } finally {
      setBusy(null);
      load();
    }
  };

  const pending = review?.items.filter((item) => !item.rejectedAt) ?? [];
  const rejected = review?.items.filter((item) => item.rejectedAt) ?? [];
  const renderItem = (item: GraphProjectTemplateReviewItem) => (
    <ReviewItem
      key={item.path}
      item={item}
      busy={busy?.path === item.path ? busy.decision : null}
      onDecide={(decision) => void decide(item, decision)}
    />
  );

  return (
    <div data-graph-review-panel="" className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs text-muted-foreground">
          Project templates come from the repository. Each stays untrusted, and cannot launch, until
          you approve the version shown here.
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={load}
          disabled={status === "loading"}
          aria-label="Refresh the review"
        >
          <RefreshCw className={cn("size-3.5", status === "loading" && "animate-spin")} />
        </Button>
      </div>
      {decisionError ? (
        <p role="alert" className="text-xs text-failure">
          {decisionError}
        </p>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="text-xs text-failure">
          Could not load the review: {error}
        </p>
      ) : null}
      {status === "loading" && !review ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" /> Loading…
        </p>
      ) : null}
      {review && review.source.status !== "ok" ? (
        <p className="text-xs text-muted-foreground">
          {review.source.status === "no-checkout"
            ? "This project has no local checkout on this machine."
            : `${review.source.directory} could not be read.`}
        </p>
      ) : null}
      {review && review.source.status === "ok" && review.items.length === 0 ? (
        <p data-graph-review-empty="" className="text-xs text-muted-foreground">
          Every project template is approved.
        </p>
      ) : null}
      {pending.length > 0 ? (
        <section aria-label="Needs review" className="flex flex-col gap-2">
          {pending.map(renderItem)}
        </section>
      ) : null}
      {rejected.length > 0 ? (
        <section aria-label="Rejected" className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Rejected</h3>
          {rejected.map(renderItem)}
        </section>
      ) : null}
    </div>
  );
}
