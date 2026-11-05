import { Loader2, Plus, RotateCcw, Settings2 } from "lucide-react";
import {
  AGENT_PLATFORM_LABELS,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorSnapshot,
} from "@orkestrator/protocol/coordinator";
import { AgentMailBanner } from "@/components/agent-mail/AgentMailBanner";
import { LazyLoadBoundary, LazyLoadInlineErrorFallback } from "@/components/LazyLoadBoundary";
import { LazyAgentNativeTab } from "@/components/native-agent/LazyAgentNativeTab";
import { Button } from "@/components/ui/button";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useConfigStore } from "@/stores";
import {
  COORDINATOR_COMPOSER_PLACEHOLDER,
  COORDINATOR_STARTER_PROMPTS,
  CoordinatorBanner,
  CoordinatorStartupFailure,
} from "./CoordinatorPanelNotices";
import type { CoordinatorLaunchOptions, PendingCoordinatorLaunch } from "./useCoordinatorLaunches";

interface CoordinatorConversationPaneProps {
  /** The group's front conversation; none when nothing is open. */
  conversation: CoordinatorConversation | undefined;
  paneFocused: boolean;
  projectId: string;
  snapshot: CoordinatorSnapshot;
  availablePlatforms: AgentPlatform[];
  platformNotes: Partial<Record<AgentPlatform, string>>;
  /**
   * This conversation's own first prompt, while it is held. Scoped to the
   * conversation that produced it, so another group cannot replay it into its own.
   */
  launch: PendingCoordinatorLaunch | undefined;
  startConversation: (
    conversation: { id: string; role?: string },
    platform: AgentPlatform,
    launch: CoordinatorLaunchOptions,
    prompt: string,
  ) => Promise<void>;
  confirmUpstreamMerge: (conversation: { role?: string }) => Promise<false | undefined>;
  conversationBusy: boolean;
  newConversationLabel: string;
  onCreateConversation: () => void;
  onRetry: () => void;
  /** Clears this conversation's startup failure, so it connects again. */
  onRetryConversation: (conversationId: string) => void;
  onCloseConversation: (conversationId: string) => void;
}

/** Why a conversation cannot send, or undefined when it can. */
function sendingHeldReason(
  snapshot: CoordinatorSnapshot,
  conversation: CoordinatorConversation,
): string | undefined {
  if (snapshot.workspace.lifecycleState === "paused") {
    return "Coordination is paused. Resume to send.";
  }
  if (snapshot.workspace.lifecycleState === "error") {
    return "The coordinator could not start. Retry to send.";
  }
  if (conversation.startupError) return "This conversation could not start. Retry to send.";
  return undefined;
}

/**
 * One group's front conversation. Only the front tab of each group is mounted;
 * the backend owns the session, so a tab brought forward rehydrates.
 */
export function CoordinatorConversationPane({
  conversation,
  paneFocused,
  projectId,
  snapshot,
  availablePlatforms,
  platformNotes,
  launch,
  startConversation,
  confirmUpstreamMerge,
  conversationBusy,
  newConversationLabel,
  onCreateConversation,
  onRetry,
  onRetryConversation,
  onCloseConversation,
}: CoordinatorConversationPaneProps) {
  const enabledPlatforms = useConfigStore((state) => state.config.global.enabledAgentPlatforms);
  if (!conversation) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <p className="text-sm text-muted-foreground">
            No coordinator is open. Mail for the coordinator will start one with the default agent.
          </p>
          <Button
            className="mt-3"
            variant="outline"
            disabled={conversationBusy}
            onClick={onCreateConversation}
          >
            <Plus className="size-4" />
            {newConversationLabel}
          </Button>
        </div>
      </div>
    );
  }
  const providerState = conversation.agent
    ? snapshot.providerAvailability[conversation.agent]
    : undefined;
  // A banner over the transcript rather than a replacement for it: the
  // conversation stays readable while its platform is unavailable.
  const providerUnavailable = Boolean(conversation.agent && !providerState?.available);
  const environmentId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
  const heldReason = sendingHeldReason(snapshot, conversation);
  // A platform turned off is Platforms' to fix; anything else here is the safety level.
  const platformOff = Boolean(
    conversation.agent && !normalizeAgentPlatforms(enabledPlatforms).includes(conversation.agent),
  );
  return (
    <div key={conversation.id} className="flex h-full min-h-0 flex-col">
      {conversation.startupError ? (
        <CoordinatorStartupFailure
          title={conversation.title}
          error={conversation.startupError}
          busy={conversationBusy}
          onRetry={() => onRetryConversation(conversation.id)}
          onClose={() => onCloseConversation(conversation.id)}
        />
      ) : null}
      {providerUnavailable && conversation.agent ? (
        <CoordinatorBanner
          tone="warning"
          action={
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => requestGlobalSettings(platformOff ? "platforms" : "coordinator")}
              >
                <Settings2 className="size-3.5" />
                {platformOff ? "Platform settings" : "Coordinator settings"}
              </Button>
              <Button size="sm" variant="outline" onClick={onRetry}>
                <RotateCcw className="size-3.5" />
                Retry
              </Button>
            </div>
          }
        >
          <span className="font-medium">
            {AGENT_PLATFORM_LABELS[conversation.agent]} is unavailable for Coordinator.
          </span>{" "}
          <span className="text-muted-foreground">{providerState?.reason}</span>
        </CoordinatorBanner>
      ) : null}
      <AgentMailBanner
        environmentId={environmentId}
        tabId={conversation.tabId}
        agentAvailable={availablePlatforms.length > 0}
      />
      <div className="relative min-h-0 flex-1">
        <LazyLoadBoundary
          loadingFallback={
            <div role="status" className="grid h-full place-items-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Loading conversation</span>
            </div>
          }
          renderError={(details) => <LazyLoadInlineErrorFallback {...details} />}
        >
          <LazyAgentNativeTab
            tabId={conversation.tabId}
            data={{
              platform: conversation.agent,
              environmentId,
              isLocal: true,
              sessionId: conversation.providerSessionId,
            }}
            isActive
            ownsGlobalShortcuts={paneFocused}
            executionPolicy="coordinator-read-only"
            coordinatorProjectId={projectId}
            coordinatorWorkspacePath={snapshot.projectPath}
            availablePlatforms={availablePlatforms}
            platformNotes={platformNotes}
            composerPlaceholder={COORDINATOR_COMPOSER_PLACEHOLDER}
            connectionEnabled={providerState?.available !== false}
            {...(heldReason ? { sendingHeldReason: heldReason } : {})}
            // Only the main coordinator delegates, so only it is offered work
            // that has to run in a pipeline or environment.
            {...(conversation.role === "main"
              ? { unassignedStarterPrompts: COORDINATOR_STARTER_PROMPTS }
              : {})}
            emptyPlatformsMessage="No agent platform meets this coordinator's read-only requirement on this machine. Enable a qualified platform, or lower the coordinator safety level in Settings."
            emptyPlatformsAction={
              <Button
                size="sm"
                variant="outline"
                onClick={() => requestGlobalSettings("coordinator")}
              >
                <Settings2 className="size-3.5" />
                Coordinator settings
              </Button>
            }
            onAssignPlatform={
              conversation.agent
                ? undefined
                : (platform, prompt, options) =>
                    startConversation(conversation, platform, options, prompt)
            }
            beforeSend={
              conversation.role === "side" ? undefined : () => confirmUpstreamMerge(conversation)
            }
            {...(launch
              ? {
                  initialPrompt: launch.prompt,
                  initialAgentModel: launch.modelId,
                  initialReasoningEffort: launch.reasoningId,
                  initialConversationMode: launch.mode,
                  initialFastMode: launch.fastMode,
                  initialExecutionProfileId: launch.executionProfileId,
                }
              : {})}
          />
        </LazyLoadBoundary>
      </div>
    </div>
  );
}
