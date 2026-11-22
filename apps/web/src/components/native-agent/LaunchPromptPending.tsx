import { useMemo, useState, type ReactNode } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { TAB_ICON_CLASS, TAB_STRIP_CLASS, TabShell } from "@/components/pane-layout/TabShell";
import { createOptimisticNativeMessage } from "@/lib/chat/client-only-messages";
import { getNativeAgentAdapter } from "./adapter";
import { startupPromptDisplayText } from "./startup-prompt-preview";

/** What a new environment's opening prompt is waiting on before its agent tab exists. */
export type LaunchPromptStage = "creating-worktree" | "starting-container" | "preparing";

export function launchPromptStageText(stage: LaunchPromptStage): string {
  switch (stage) {
    case "creating-worktree":
      return "Creating worktree…";
    case "starting-container":
      return "Starting container…";
    case "preparing":
      return "Preparing environment…";
  }
}

/**
 * A new environment's opening prompt, drawn before its agent tab exists.
 *
 * Creating a worktree or booting a container comes before the backend can
 * publish the agent tab, so without this the prompt the user just wrote
 * disappears behind a spinner and comes back seconds later. This keeps it on
 * screen from the click onwards, laid out the way the agent tab will show it
 * (one tab, the prompt as a sent message, a status row, the composer docked at
 * the bottom), so the tab replaces it without anything moving.
 *
 * Presentation only: the backend owns the launch and sends the prompt.
 */
export function LaunchPromptPending({
  environmentId,
  platform,
  prompt,
  stage,
  detail,
}: {
  environmentId: string;
  platform: AgentPlatform | undefined;
  prompt: string;
  stage: LaunchPromptStage;
  /** Optional affordance beside the status, such as a way to see container logs. */
  detail?: ReactNode;
}) {
  // The agent tab's own label, so "Message Claude" reads the same in both views.
  // Unknown for the first instant of a launch: left blank rather than guessed,
  // so it never names one agent and then another.
  const label = platform ? getNativeAgentAdapter(platform).label : "";
  // The moment this view first drew the prompt; the agent tab's own preview
  // takes the same role once it mounts.
  const [createdAt] = useState(() => new Date().toISOString());
  const text = startupPromptDisplayText(prompt);
  const message = useMemo(
    () =>
      createOptimisticNativeMessage(`launch-prompt-pending:${environmentId}`, text, [], createdAt),
    [createdAt, environmentId, text],
  );
  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-background"
      data-testid="launch-prompt-pending"
    >
      <div className={TAB_STRIP_CLASS} aria-hidden="true">
        <TabShell isActive>
          {platform ? (
            <AgentPlatformIcon platform={platform} accent className={TAB_ICON_CLASS} />
          ) : null}
          <span className="min-w-12 truncate">{label}</span>
        </TabShell>
      </div>
      <div className="@container flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto py-4">
          <NativeMessage message={message} />
          <div className="px-2 @sm:px-4">
            <div className="mx-auto max-w-3xl min-w-0 text-muted-foreground">
              <div className="chat-status-row min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span role="status" className="agent-thinking-shimmer text-xs">
                    {launchPromptStageText(stage)}
                  </span>
                  {detail}
                </div>
              </div>
            </div>
          </div>
        </div>
        {/* The composer's footprint, so the real one docks into the same place. */}
        <div className="mx-auto w-full max-w-3xl px-2 pb-3 @sm:px-4" aria-hidden="true">
          <div className="rounded-lg border border-border/60 bg-muted-foreground/5 px-3 py-2.5">
            <div className="min-h-5 text-sm text-muted-foreground/60">
              {label ? `Message ${label}` : ""}
            </div>
            <div className="min-h-10" />
          </div>
        </div>
      </div>
    </div>
  );
}
