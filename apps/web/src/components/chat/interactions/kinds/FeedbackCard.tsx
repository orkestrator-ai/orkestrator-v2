import { useState } from "react";
import { describeAnchorLocation, describeContentRef, type FeedbackSpec } from "@orkestrator/protocol/rich-interactions";
import { cn } from "@/lib/utils";
import { ActionBar, ContentRefPreview, textareaClass, type KindProps } from "../shared";

/**
 * Feature 6: a durable comment thread anchored to an exact revision. "Save
 * note" starts no agent; "Discuss" and "Request change" deliver once to this
 * session. Agent replies append to the thread; only the user resolves it.
 */
export function FeedbackCard({ spec, draft, setDraft, act, disabled, actions }: KindProps<FeedbackSpec>) {
  const body = typeof draft === "string" ? draft : "";
  const [showTarget, setShowTarget] = useState(false);
  const location = spec.target.location;
  const writeActions = actions.filter((a) => a.id === "save-note" || a.id === "discuss" || a.id === "request-change").map((a) => a.id);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">On</span>
        <span className="font-medium">{describeAnchorLocation(location)}</span>
        <span className="text-muted-foreground">of {describeContentRef(spec.target.source)}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] uppercase", spec.resolved ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground")}>{spec.resolved ? "Resolved" : "Open"}</span>
        <button type="button" className="ml-auto text-primary focus-hairline" onClick={() => setShowTarget((v) => !v)} aria-expanded={showTarget}>
          {showTarget ? "Hide target" : "Show target"}
        </button>
      </div>
      {showTarget ? (
        <div className="relative">
          <ContentRefPreview reference={spec.target.source} description={`The ${describeAnchorLocation(location)} this thread is about`} compact />
          {location.kind === "image-region" ? (
            <p className="mt-1 text-[11px] text-muted-foreground">Region: {Math.round(location.rect.x * 100)}%, {Math.round(location.rect.y * 100)}% · {Math.round(location.rect.width * 100)}% × {Math.round(location.rect.height * 100)}% of the original image.</p>
          ) : null}
        </div>
      ) : null}
      {spec.excerpt ? <blockquote className="border-l-2 border-border pl-2 text-xs text-muted-foreground whitespace-pre-wrap">{spec.excerpt}</blockquote> : null}
      <ol className="flex flex-col gap-1.5" aria-label="Thread">
        {spec.entries.map((entry) => (
          <li key={entry.entryId} className={cn("rounded px-2 py-1.5 text-sm", entry.author === "user" ? "bg-primary/[0.06]" : "bg-muted/30")}>
            <span className="text-[11px] text-muted-foreground">
              {entry.author === "user" ? "You" : "Agent"} · {new Date(entry.createdAt).toLocaleString()}
            </span>
            <p className="whitespace-pre-wrap">{entry.body}</p>
            {entry.resultRef ? <p className="text-[11px] text-muted-foreground">Result: {describeContentRef(entry.resultRef)}</p> : null}
          </li>
        ))}
      </ol>
      {!disabled ? (
        <>
          <textarea className={textareaClass} rows={2} aria-label="Reply" placeholder={spec.entries.length ? "Reply…" : "Your comment…"} value={body} onChange={(e) => setDraft(e.target.value)} />
          <ActionBar actions={actions} only={writeActions} disabled={disabled} primaryDisabledReason={body.trim() ? null : "Write a comment first."} onAction={(a) => act(a.id, { body: body.trim() })} />
          <ActionBar actions={actions} only={spec.resolved ? ["reopen"] : spec.entries.length ? ["resolve"] : []} disabled={disabled} onAction={(a) => act(a.id, {})} />
        </>
      ) : null}
    </div>
  );
}
