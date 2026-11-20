import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Image as ImageIcon,
  Link2,
  RefreshCw,
  Send,
} from "lucide-react";
import type { ArtifactPublicationView } from "@orkestrator/protocol/transcript-artifact-commands";
import {
  describeContentRef,
  type ContentRef,
  type RichInteractionReceipt,
} from "@orkestrator/protocol/rich-interactions";
import type { RichInteractionViewRecord } from "@orkestrator/protocol/contract/domains/rich-interactions";
import { Button } from "@/components/ui/button";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { useRichTranscriptScope } from "@/lib/chat/rich-identity";
import { deliveryLabel } from "@/lib/chat/rich-interactions";
import { onResourceChanged } from "@/lib/resource-sync";
import { cn } from "@/lib/utils";
import { ArtifactPart } from "../rich/ArtifactPart";
import { MarkdownImage } from "../rich/MediaBlock";
import { CodeBlock } from "../rich/CodeBlock";
import { MermaidBlock } from "../rich/MermaidBlock";

export type RichActionView = RichInteractionViewRecord["actions"][number];

/** The props every registered kind renderer receives. */
export interface KindProps<Spec> {
  view: RichInteractionViewRecord;
  spec: Spec;
  draft: unknown;
  setDraft: (value: unknown) => void;
  /** Submit an action. `keepDraft` keeps the rest of the draft (progress saves). */
  act: (actionId: string, result: unknown, options?: { keepDraft?: boolean }) => void;
  /** Closed, expired, superseded or submitting: controls are inert. */
  disabled: boolean;
  actions: RichActionView[];
}

export const textareaClass =
  "w-full resize-y rounded-md border border-border/70 bg-input-surface px-3 py-2 text-sm focus-hairline disabled:opacity-60";
export const inputClass =
  "w-full rounded-md border border-border/70 bg-input-surface px-2.5 py-1.5 text-sm focus-hairline disabled:opacity-60";
export const eyebrowClass =
  "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";

export function action(actions: readonly RichActionView[], id: string): RichActionView | undefined {
  return actions.find((candidate) => candidate.id === id);
}

/**
 * Host-owned action buttons. A label is presentation only: the button submits
 * the registered action id, and an unavailable action stays visible with its
 * reason instead of failing on click.
 */
export function ActionBar({
  actions,
  disabled,
  onAction,
  only,
  primaryDisabledReason,
}: {
  actions: readonly RichActionView[];
  disabled: boolean;
  onAction: (action: RichActionView) => void;
  only?: readonly string[];
  /** Why the primary actions cannot be used yet (e.g. nothing selected). */
  primaryDisabledReason?: string | null;
}) {
  const shown = only ? actions.filter((a) => only.includes(a.id)) : actions;
  const reasons = shown.filter((a) => !a.available && a.unavailableReason);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {primaryDisabledReason ? (
          <span className="mr-auto text-xs text-muted-foreground">{primaryDisabledReason}</span>
        ) : null}
        {shown.map((a) => (
          <Button
            key={a.id}
            size="sm"
            variant={
              a.style === "destructive"
                ? "destructive"
                : a.style === "secondary"
                  ? "outline"
                  : "default"
            }
            disabled={disabled || !a.available || Boolean(primaryDisabledReason)}
            title={a.description ?? a.unavailableReason}
            onClick={() => onAction(a)}
          >
            {a.label}
          </Button>
        ))}
      </div>
      {reasons.map((a) => (
        <p key={a.id} className="text-right text-[11px] text-muted-foreground">
          {a.label}: {a.unavailableReason}
        </p>
      ))}
    </div>
  );
}

export function RefChip({ reference }: { reference: ContentRef }) {
  const icon =
    reference.kind === "workspace-image" ? (
      <ImageIcon className="size-3" />
    ) : reference.kind === "url" ? (
      <Link2 className="size-3" />
    ) : (
      <FileText className="size-3" />
    );
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {icon}
      <span className="truncate">{describeContentRef(reference)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Artifact references resolved through the conversation's publication ledger

/** Reads one page of the publication ledger, newest first. */
export function useConversationPublications(beforeSequence?: number) {
  const scope = useRichTranscriptScope();
  const backend = useScopeBackend();
  const environmentId = scope?.environmentId;
  const logicalSessionKey = scope?.logicalSessionKey;
  const key = JSON.stringify([scope?.backendId, environmentId, logicalSessionKey, beforeSequence]);
  const [state, setState] = useState<{
    key: string;
    publications: ArtifactPublicationView[];
    nextSequence: number | null;
    loaded: boolean;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (!environmentId || !logicalSessionKey) return;
    let sequence = 0;
    const read = () => {
      const requested = ++sequence;
      void backend
        .listTranscriptArtifactPublications({
          environmentId,
          logicalSessionKey,
          newestFirst: true,
          ...(beforeSequence === undefined ? {} : { beforeSequence }),
        })
        .then((page) => {
          if (requested === sequence) setState({ key, ...page, loaded: true, failed: false });
        })
        .catch(() => {
          if (requested === sequence)
            setState({ key, publications: [], nextSequence: null, loaded: true, failed: true });
        });
    };
    read();
    const off = onResourceChanged("transcript-artifact", read);
    return () => {
      sequence += 1;
      off();
    };
  }, [backend, beforeSequence, environmentId, key, logicalSessionKey]);
  return state?.key === key
    ? state
    : { publications: [], nextSequence: null, loaded: false, failed: false };
}

type ArtifactReference = Extract<ContentRef, { kind: "artifact" }>;

/** Resolves only the named revisions in the current conversation. */
export function useReferencedPublications(references: readonly ArtifactReference[]) {
  const scope = useRichTranscriptScope();
  const backend = useScopeBackend();
  const environmentId = scope?.environmentId;
  const logicalSessionKey = scope?.logicalSessionKey;
  const targets = JSON.stringify(
    references.map(({ artifactId, revision }) => [artifactId, revision]),
  );
  const key = JSON.stringify([scope?.backendId, environmentId, logicalSessionKey, targets]);
  const [state, setState] = useState<{
    key: string;
    publications: ArtifactPublicationView[];
  } | null>(null);
  useEffect(() => {
    if (!environmentId || !logicalSessionKey || targets === "[]") return;
    let sequence = 0;
    const pairs = JSON.parse(targets) as [string, number][];
    const read = () => {
      const requested = ++sequence;
      void Promise.all(
        pairs.map(async ([artifactId, revision]) => {
          try {
            const args = { environmentId, logicalSessionKey };
            const page = await backend.listTranscriptArtifactPublications({
              ...args,
              artifactId,
              revision,
              limit: 1,
            });
            const match = page.publications.find(
              (p) => p.ref.artifactId === artifactId && p.ref.revision === revision,
            );
            return (
              match &&
              (await backend.getTranscriptArtifactPublication({
                ...args,
                publicationId: match.ref.publicationId,
              }))
            );
          } catch {
            return undefined;
          }
        }),
      ).then((matches) => {
        if (requested === sequence)
          setState({ key, publications: matches.filter((match) => match !== undefined) });
      });
    };
    read();
    const off = onResourceChanged("transcript-artifact", read);
    return () => {
      sequence += 1;
      off();
    };
  }, [backend, environmentId, key, logicalSessionKey, targets]);
  return state?.key === key
    ? { publications: state.publications, loaded: true }
    : { publications: [], loaded: targets === "[]" || !environmentId || !logicalSessionKey };
}

/**
 * A preview of one referenced revision, rendered by the existing trusted
 * viewers. An artifact renders through its verified publication card at the
 * exact revision named, never a newer one; when that revision was never
 * published here the description stays and the reason is shown.
 */
export function ContentRefPreview({
  reference,
  description,
  compact,
}: {
  reference: ContentRef;
  description: string;
  compact?: boolean;
}) {
  const { publications, loaded } = useReferencedPublications(
    reference.kind === "artifact" ? [reference] : [],
  );
  if (reference.kind === "artifact") {
    const publication = publications.find(
      (p) =>
        p.ref.artifactId === reference.artifactId &&
        p.ref.revision === reference.revision &&
        p.availability === "available",
    );
    if (publication) {
      return (
        <div className={cn("min-w-0", compact && "max-h-72 overflow-auto")}>
          <ArtifactPart
            part={{
              type: "artifact",
              content: publication.ref.summary,
              artifact: publication.ref,
              publishedAt: publication.publishedAt,
              conversationSequence: publication.conversationSequence,
            }}
          />
        </div>
      );
    }
    return (
      <PreviewUnavailable description={description}>
        {loaded
          ? `Revision ${reference.revision} of ${reference.artifactId} is unavailable in this conversation.`
          : "Loading preview…"}
      </PreviewUnavailable>
    );
  }
  if (
    reference.kind === "workspace-image" ||
    (reference.kind === "file" && /\.(png|jpe?g|gif|webp|svg)$/iu.test(reference.path))
  ) {
    return (
      <div
        className={cn(
          "min-w-0 overflow-hidden rounded border border-border/60",
          compact && "max-h-72",
        )}
      >
        <MarkdownImage src={reference.path} alt={description} />
      </div>
    );
  }
  return (
    <PreviewUnavailable description={description}>
      Preview: <RefChip reference={reference} />
    </PreviewUnavailable>
  );
}

function PreviewUnavailable({
  description,
  children,
}: {
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <p className="text-foreground/90">{description}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}

/** A bounded source preview (Mermaid, diff, plain text) in the existing viewers. */
export function SourcePreview({
  kind,
  source,
  blockKey,
}: {
  kind: "diagram" | "diff" | "text";
  source: string;
  blockKey: string;
}) {
  if (kind === "diagram") return <MermaidBlock source={source} closed blockKey={blockKey} />;
  return (
    <CodeBlock
      source={source}
      language={kind === "diff" ? "diff" : null}
      closed
      blockKey={blockKey}
    />
  );
}

// ---------------------------------------------------------------------------
// Receipts

const DELIVERY_TONE: Record<RichInteractionReceipt["delivery"], string> = {
  recorded: "text-muted-foreground",
  pending: "text-muted-foreground",
  queued: "text-primary",
  delivered: "text-success",
  applied: "text-success",
  failed: "text-failure",
  unknown: "text-amber-400",
};

export function ReceiptList({
  receipts,
  onRetry,
}: {
  receipts: readonly RichInteractionReceipt[];
  onRetry: (receiptId: string) => void;
}) {
  if (receipts.length === 0) return null;
  const shown = receipts.slice(-5);
  return (
    <ul
      className="flex flex-col gap-1 border-t border-border/60 bg-white/[0.015] px-3 py-2"
      aria-label="Submitted decisions"
    >
      {receipts.length > shown.length ? (
        <li className="text-[11px] text-muted-foreground">
          {receipts.length - shown.length} earlier decisions
        </li>
      ) : null}
      {shown.map((receipt) => (
        <li key={receipt.receiptId} className="flex flex-wrap items-center gap-2 text-xs">
          {receipt.delivery === "delivered" ||
          receipt.delivery === "applied" ||
          receipt.delivery === "recorded" ? (
            <CheckCircle2 className={cn("size-3.5", DELIVERY_TONE[receipt.delivery])} aria-hidden />
          ) : receipt.delivery === "failed" || receipt.delivery === "unknown" ? (
            <AlertTriangle
              className={cn("size-3.5", DELIVERY_TONE[receipt.delivery])}
              aria-hidden
            />
          ) : receipt.delivery === "queued" ? (
            <Send className="size-3.5 text-primary" aria-hidden />
          ) : (
            <Clock className="size-3.5 text-muted-foreground" aria-hidden />
          )}
          <span className="font-medium">{receipt.actionLabel}</span>
          <span className="text-muted-foreground">rev {receipt.requestRevision}</span>
          <span className={DELIVERY_TONE[receipt.delivery]}>{deliveryLabel(receipt.delivery)}</span>
          {receipt.deliveryDetail &&
          receipt.delivery !== "queued" &&
          receipt.delivery !== "delivered" ? (
            <span className="text-muted-foreground">— {receipt.deliveryDetail}</span>
          ) : null}
          {receipt.route === "agent-followup" &&
          (receipt.delivery === "unknown" || receipt.delivery === "failed") ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => onRetry(receipt.receiptId)}
            >
              <RefreshCw className="mr-1 size-3" aria-hidden />
              Retry delivery
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function Section({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-2", className)}>
      {title ? <h4 className={eyebrowClass}>{title}</h4> : null}
      {children}
    </section>
  );
}

export function ProvenanceBadge({ provenance }: { provenance: string }) {
  const observed =
    provenance === "orkestrator-observed" ||
    provenance === "observed" ||
    provenance === "user-confirmed";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        observed ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
      )}
      title={
        observed
          ? "Observed by Orkestrator or confirmed by you"
          : "Reported by the agent; not independently verified"
      }
    >
      {provenance.replace(/-/g, " ")}
    </span>
  );
}
