import { memo, useCallback, type ComponentType } from "react";
import { AlertTriangle, Layers, X } from "lucide-react";
import {
  RICH_KIND_MODULES,
  type RichInteractionKind,
} from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { useRichTranscriptScope } from "@/lib/chat/rich-identity";
import {
  deliveryLabel,
  useInteractionController,
  useRichInteraction,
  type RichInteractionView,
} from "@/lib/chat/rich-interactions";
import { cn } from "@/lib/utils";
import { KIND_RENDERERS } from "./kind-registry";
import { ReceiptList, type KindProps } from "./shared";

/**
 * The shared shell of every rich interaction card (spec "Shared interaction
 * architecture"): title, kind, source revision, state, the kind's trusted
 * controls, the submit lifecycle and the receipts. It owns no decision state
 * of its own: the request snapshot comes from the backend and is re-read on
 * remount, reconnect and change hints.
 */
export const RichInteractionCard = memo(function RichInteractionCard({
  interactionId,
  environmentId: explicitEnvironmentId,
}: {
  interactionId: string;
  environmentId?: string;
}) {
  const scope = useRichTranscriptScope();
  const environmentId = explicitEnvironmentId ?? scope?.environmentId ?? null;
  const { load, refresh, replace } = useRichInteraction(environmentId, interactionId);
  const view = load.view;
  if (!environmentId)
    return (
      <CardNotice title="Interaction" message="This interaction belongs to another session view." />
    );
  if (load.status === "missing")
    return <CardNotice title="Interaction unavailable" message={load.message} />;
  if (!view) {
    return load.status === "error" ? (
      <CardNotice title="Interaction" message={load.message} onRetry={() => void refresh()} />
    ) : (
      <div
        className="my-2 rounded-lg border border-border/70 bg-zinc-900/60 px-3 py-3 text-xs text-muted-foreground"
        aria-busy="true"
      >
        Loading interaction…
      </div>
    );
  }
  return (
    <LoadedCard
      environmentId={environmentId}
      view={view}
      replace={replace}
      refresh={refresh}
      loadError={load.status === "error" ? load.message : null}
    />
  );
});

function LoadedCard({
  environmentId,
  view,
  replace,
  refresh,
  loadError,
}: {
  environmentId: string;
  view: RichInteractionView;
  replace: (view: RichInteractionView) => void;
  refresh: () => Promise<RichInteractionView | null>;
  loadError: string | null;
}) {
  const controller = useInteractionController(environmentId, view, replace, refresh);
  const { request } = view;
  const Renderer = KIND_RENDERERS[request.kind as RichInteractionKind] as
    ComponentType<KindProps<unknown>> | undefined;
  // Discrete outcomes only, announced politely (never every keystroke).
  const announcement = controller.outcome
    ? controller.outcome.ok
      ? `${deliveryLabel(controller.outcome.receipt.delivery)}: ${controller.outcome.receipt.actionLabel}`
      : `Not submitted: ${controller.outcome.message}`
    : "";
  const act = useCallback(
    (actionId: string, result: unknown, options?: { keepDraft?: boolean }) =>
      void controller.submit(actionId, result, options),
    [controller],
  );
  const closed = !view.open;
  const disabled = closed || controller.submitting;
  const module = RICH_KIND_MODULES[request.kind as RichInteractionKind];
  const stateLabel =
    request.state === "superseded"
      ? "Superseded"
      : request.state === "expired"
        ? "Expired"
        : request.state === "closed"
          ? request.submissions
            ? "Answered"
            : "Closed"
          : null;

  return (
    <div
      className="my-2 overflow-hidden rounded-lg border border-border/70 bg-zinc-900/90 shadow-sm shadow-black/15"
      role="group"
      aria-label={request.title}
      aria-busy={controller.submitting || undefined}
      data-interaction-id={request.interactionId}
      data-interaction-kind={request.kind}
    >
      <div className="flex items-center gap-2 border-b border-border/60 bg-white/[0.02] px-3 py-2">
        <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-xs font-medium">{request.title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {module?.title ?? request.kind}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
          {stateLabel ? <span className="rounded bg-muted px-1.5 py-0.5">{stateLabel}</span> : null}
          <span
            title={
              request.revisionAuthor === "user"
                ? "Last revised by you"
                : "Last revised by the agent"
            }
          >
            rev {request.revision}
          </span>
          {view.open && request.origin === "agent" ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Dismiss without deciding"
              title="Dismiss without deciding"
              onClick={() => void controller.dismiss()}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </span>
      </div>
      {request.body ? (
        <p className="border-b border-border/40 px-3 py-2 text-sm leading-relaxed text-foreground/90">
          {request.body}
        </p>
      ) : null}
      <div className="px-3 py-3">
        {Renderer ? (
          <Renderer
            view={view}
            spec={request.spec}
            draft={controller.draft}
            setDraft={controller.setDraft}
            act={act}
            disabled={disabled}
            actions={view.actions}
          />
        ) : (
          <div className="text-sm">
            <p className="text-muted-foreground">
              This client cannot show {request.kind} controls. The request reads:
            </p>
            <pre className="mt-2 whitespace-pre-wrap text-xs">{request.fallbackText}</pre>
          </div>
        )}
      </div>
      {request.state === "superseded" && request.supersededBy ? (
        <Banner tone="muted">
          This request was replaced by a newer one; answer the current request instead.
        </Banner>
      ) : null}
      {controller.staleDraft ? (
        <Banner tone="muted">
          The agent revised this request after your last draft. Review the new revision; your
          earlier draft was kept for reference.
        </Banner>
      ) : null}
      {controller.draftConflict ? (
        <Banner tone="error">
          Another window saved a newer draft of this card. Your edits here are kept; reload to
          compare.
        </Banner>
      ) : null}
      {controller.outcome && !controller.outcome.ok ? (
        <Banner tone="error">
          {controller.outcome.message}
          {controller.outcome.retryable
            ? " It is safe to retry: the same submission is recognised."
            : ""}
        </Banner>
      ) : null}
      {loadError ? <Banner tone="muted">Showing the last known state: {loadError}</Banner> : null}
      <ReceiptList
        receipts={view.receipts}
        onRetry={(receiptId) => void controller.retryDelivery(receiptId)}
      />
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: "error" | "muted"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 border-t px-3 py-2 text-xs",
        tone === "error"
          ? "border-destructive/30 bg-destructive/10 text-failure"
          : "border-border/60 bg-muted/30 text-muted-foreground",
      )}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

function CardNotice({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="my-2 flex items-center gap-2 rounded-lg border border-border/70 bg-zinc-900/60 px-3 py-2 text-xs text-muted-foreground"
      role="status"
    >
      <Layers className="size-3.5" aria-hidden />
      <span className="font-medium text-foreground/80">{title}</span>
      <span>{message}</span>
      {onRetry ? (
        <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
