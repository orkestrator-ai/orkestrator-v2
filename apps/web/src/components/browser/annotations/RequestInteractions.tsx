/**
 * Pending questions and approvals of a request's turn, answerable from the
 * annotation panel with the same cards (and the same resolver and drafts) as
 * the native chat. The request carries only content-free references; the
 * interaction bodies come from the destination session's projection: the
 * shared renderer cache when its chat tab has loaded it, otherwise one read
 * while this card is on screen. Answers go through
 * `resolve_native_agent_interaction`, exactly as the chat does.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  AgentInteractionApplyOutcome,
  AgentInteractionKind,
  AgentInteractionRequest,
  AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import type { WebAnnotationRequest } from "@orkestrator/protocol/web-annotations";
import { NativeAgentInteractionCard } from "@/components/native-agent/NativeAgentInteractionCard";
import { NativeAgentQuestionCard } from "@/components/native-agent/NativeAgentQuestionCard";
import { Button } from "@/components/ui/button";
import { getNativeAgentProjection, resolveNativeAgentInteraction } from "@/lib/backend/workflows";
import { refreshWebAnnotations } from "@/lib/web-annotations/sync";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useAnnotationPanel } from "./panel-context";

const KIND_LABELS: Record<AgentInteractionKind, string> = {
  question: "question",
  "plan-approval": "plan approval",
  "command-approval": "command approval",
  "file-approval": "file change approval",
  permission: "permission request",
  "mcp-form": "form",
  "mcp-url": "sign-in link",
  elicitation: "request for information",
  "terminal-selection": "terminal choice",
};

function kindLabel(kind: AgentInteractionKind): string {
  return KIND_LABELS[kind] ?? "request";
}

export function pendingRequestInteractions(request: WebAnnotationRequest) {
  return (request.interactions ?? []).filter(
    (item) => item.state === "pending" || item.state === "answering",
  );
}

export function RequestInteractions({
  request,
  onAnswerInChat,
}: {
  request: WebAnnotationRequest;
  onAnswerInChat: () => void;
}) {
  const pending = pendingRequestInteractions(request);
  const { environmentId } = useAnnotationPanel();
  const { transcript, destination } = request;
  const sessionKey = transcript.logicalSessionKey || destination.logicalSessionKey;
  const shared = useNativeAgentProjectionStore((state) => state.projections.get(sessionKey));
  const [fetched, setFetched] = useState<AgentInteractionRequest[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = pending.map((item) => item.id).join("|");

  const known = useMemo(() => {
    const byId = new Map<string, AgentInteractionRequest>();
    const sharedInteractions =
      shared && shared.environmentId === environmentId ? shared.interactions : [];
    for (const item of fetched ?? []) byId.set(item.id, item);
    for (const item of sharedInteractions) byId.set(item.id, item);
    return byId;
  }, [environmentId, fetched, shared]);
  const missing = pending.filter((item) => !known.has(item.id)).length;

  // One read per distinct pending set, only while this card is mounted and
  // the chat tab's own cache does not already hold the bodies. `missing` is
  // derived from `ids` and the caches; re-reading on every cache change would
  // refetch while the chat tab streams.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!ids || missing === 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getNativeAgentProjection({
      environmentId,
      agent: destination.agent,
      logicalSessionKey: sessionKey,
    })
      .then((projection) => {
        if (!cancelled) setFetched(projection?.interactions ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("The question could not be loaded here. Answer it in the chat.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [destination.agent, environmentId, ids, sessionKey]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  if (pending.length === 0) return null;

  const resolve = async (
    interactionId: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome> => {
    const outcome = await resolveNativeAgentInteraction({
      environmentId,
      agent: destination.agent,
      logicalSessionKey: sessionKey,
      interactionId,
      resolution,
    });
    refreshWebAnnotations(environmentId, { requestIds: [request.id] });
    return outcome;
  };

  return (
    <section aria-label="Waiting for your answer" className="space-y-1.5" data-interactions={ids}>
      <p className="text-amber-200">
        The agent is waiting for {pending.length === 1 ? "an answer" : `${pending.length} answers`}{" "}
        ({pending.map((item) => kindLabel(item.kind)).join(", ")})
        {pending.some((item) => !item.blocking) ? "; the turn keeps running meanwhile" : ""}.
      </p>
      {pending.map((item) => {
        const interaction = known.get(item.id);
        if (!interaction) return null;
        return interaction.kind === "question" ? (
          <NativeAgentQuestionCard
            key={item.id}
            interaction={interaction}
            onResolve={(resolution) => resolve(item.id, resolution)}
          />
        ) : (
          <NativeAgentInteractionCard
            key={item.id}
            interaction={interaction}
            onResolve={(resolution) => resolve(item.id, resolution)}
          />
        );
      })}
      {loading && missing > 0 && (
        <p className="flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden /> Loading the question…
        </p>
      )}
      {!loading && missing > 0 && (
        <p className="text-muted-foreground">
          {error ?? "This question is only shown in the chat."}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant={missing > 0 ? "default" : "outline"}
        className="h-6 px-2 text-[11px]"
        onClick={onAnswerInChat}
      >
        Answer in chat
      </Button>
    </section>
  );
}
