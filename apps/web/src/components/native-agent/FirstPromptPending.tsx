import { useMemo, useState } from "react";
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { LiveElapsed } from "@/components/chat/LiveElapsed";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { getNativeAgentAdapter } from "./adapter";
import { createOptimisticNativeMessage } from "@/lib/chat/client-only-messages";

/** What the first prompt is waiting on, and so who the person is waiting for. */
export type FirstPromptPhase =
  /** Orkestrator is recording the tab's agent choice before it sends anything. */
  | "saving"
  /** The request is with the backend and the agent's own process is starting. */
  | "starting";

export interface FirstPromptPendingState {
  platform: AgentPlatform;
  phase: FirstPromptPhase;
  text: string;
  attachments: Array<{ path: string; name: string; previewUrl?: string }>;
  /** `Date.now()` when the person pressed send; drives the elapsed clock. */
  startedAt: number;
  createdAt: string;
}

/**
 * The status line, and whose wait it is.
 *
 * Kept as plain data so the wording is testable and so a step Orkestrator owns
 * is never described as the agent's, or the other way round.
 */
export function firstPromptStatus(
  platform: AgentPlatform,
  phase: FirstPromptPhase,
): { headline: string; detail: string } {
  const agent = AGENT_PLATFORM_LABELS[platform];
  return phase === "saving"
    ? {
        headline: "Saving your tab…",
        detail: "Orkestrator is recording your agent choice.",
      }
    : {
        headline: `Starting ${agent}…`,
        detail: `Your tab is saved. Waiting for ${agent} to start, which can take several seconds.`,
      };
}

/**
 * The first prompt as an already-sent conversation, until the backend answers.
 *
 * Replaces a bare centred label. The message appears on the frame the person
 * pressed send, and the status row says which side is being waited on, so a
 * slow agent start is not mistaken for a slow Orkestrator.
 */
export function FirstPromptPending({ pending }: { pending: FirstPromptPendingState }) {
  const message = useMemo(
    () =>
      createOptimisticNativeMessage(
        "first-prompt-pending",
        pending.text,
        pending.attachments,
        pending.createdAt,
      ),
    [pending.attachments, pending.createdAt, pending.text],
  );
  const { headline, detail } = firstPromptStatus(pending.platform, pending.phase);
  return (
    <div
      data-testid="first-prompt-pending"
      className="@container flex h-full min-h-0 flex-col overflow-y-auto bg-background py-4"
    >
      <NativeMessage message={message} />
      <div className="px-2 @sm:px-4">
        <div className="mx-auto max-w-3xl min-w-0 text-muted-foreground">
          <div className="chat-status-row min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span role="status" className="agent-thinking-shimmer text-xs">
                {headline}
              </span>
              <LiveElapsed startedAt={pending.startedAt} />
            </div>
          </div>
          <p
            data-testid="first-prompt-pending-detail"
            className="pb-2 text-xs text-muted-foreground/70"
          >
            {detail}
          </p>
        </div>
      </div>
    </div>
  );
}

/** The wait for an agent's first session to exist. */
export function LaunchingAgentStatus({ label }: { label: string }) {
  return (
    <span role="status" className="agent-thinking-shimmer text-xs">
      Launching {label}…
    </span>
  );
}

/**
 * A first prompt shown as sent, above the composer it left, until its agent is
 * bound. Laid out as the agent tab that replaces it draws its opening preview.
 */
export function SentFirstPrompt({
  platform,
  text,
  attachments,
}: {
  platform: AgentPlatform;
  text: string;
  attachments: FirstPromptPendingState["attachments"];
}) {
  const [createdAt] = useState(() => new Date().toISOString());
  const message = useMemo(
    () => createOptimisticNativeMessage("first-prompt-sent", text, attachments, createdAt),
    [attachments, createdAt, text],
  );
  return (
    <div data-testid="first-prompt-sent" className="min-h-0 flex-1 overflow-y-auto py-4">
      <NativeMessage message={message} />
      <div className="px-2 @sm:px-4">
        <div className="chat-status-row mx-auto max-w-3xl min-w-0">
          <div className="flex items-center gap-2 text-muted-foreground">
            <LaunchingAgentStatus label={getNativeAgentAdapter(platform).label} />
          </div>
        </div>
      </div>
      {/* The docked composer floats over the transcript. */}
      <div className="h-32 shrink-0" aria-hidden="true" />
    </div>
  );
}
