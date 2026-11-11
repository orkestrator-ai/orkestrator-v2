import { useCallback, useMemo } from "react";
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
import {
  FLOATING_NOTICE_ACTION,
  FloatingNoticeLayer,
  TRANSCRIPT_COLUMN_REM,
} from "@/components/ui/floating-notice";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useConfigStore } from "@/stores";
import type { AgentPlatformBadge } from "@/components/chat/AgentModelPicker";
import { CoordinatorIntroCard } from "./CoordinatorIntro";
import {
  COORDINATOR_COMPOSER_PLACEHOLDER,
  COORDINATOR_SIDE_AGENT_EXPLANATION,
  COORDINATOR_SIDE_COMPOSER_PLACEHOLDER,
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
  /** Each available platform's read-only tier, as a pill in the picker. */
  platformBadges: Partial<Record<AgentPlatform, AgentPlatformBadge>>;
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
  platformOff: boolean,
): string | undefined {
  const agent = conversation.agent;
  if (agent && !snapshot.providerAvailability[agent]?.available) {
    return platformOff
      ? `${AGENT_PLATFORM_LABELS[agent]} is turned off. Turn it on to send.`
      : `${AGENT_PLATFORM_LABELS[agent]} is below the coordinator safety level. Change it to send.`;
  }
  if (snapshot.workspace.lifecycleState === "paused") {
    return "Coordination is paused. Resume to send.";
  }
  if (snapshot.workspace.lifecycleState === "error") {
    return "The coordinator could not start. Retry to send.";
  }
  if (conversation.startupError) return "This conversation could not start. Retry to send.";
  return undefined;
}

/*
 * The agent tab is memoized, so everything it is given here keeps its identity
 * across renders that change none of its inputs: built once per module, or
 * memoized per conversation below.
 */
const MAIN_UNASSIGNED = {
  unassignedStarterPrompts: COORDINATOR_STARTER_PROMPTS,
  unassignedIntro: <CoordinatorIntroCard />,
};
const EMPTY_PLATFORMS_ACTION = (
  <Button size="sm" variant="outline" onClick={() => requestGlobalSettings("coordinator")}>
    <Settings2 className="size-3.5" />
    Coordinator settings
  </Button>
);

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
  platformBadges,
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
  const workspaceId = snapshot.workspace.id;
  const conversationId = conversation?.id;
  const platform = conversation?.agent;
  const providerSessionId = conversation?.providerSessionId;
  const environmentId = conversationId
    ? coordinatorRuntimeId(workspaceId, conversationId)
    : undefined;
  const data = useMemo(
    () =>
      environmentId
        ? { platform, environmentId, isLocal: true, sessionId: providerSessionId }
        : undefined,
    [environmentId, platform, providerSessionId],
  );
  const role = conversation?.role;
  const assignTo = useMemo(
    () => (conversationId ? { id: conversationId, ...(role ? { role } : {}) } : undefined),
    [conversationId, role],
  );
  const onAssignPlatform = useCallback(
    (assigned: AgentPlatform, prompt: string, options: CoordinatorLaunchOptions) =>
      assignTo ? startConversation(assignTo, assigned, options, prompt) : Promise.resolve(),
    [assignTo, startConversation],
  );
  const beforeSend = useCallback(
    () => (assignTo ? confirmUpstreamMerge(assignTo) : Promise.resolve(undefined)),
    [assignTo, confirmUpstreamMerge],
  );
  if (!conversation || !data) {
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
  const side = conversation.role === "side";
  // A platform turned off is Platforms' to fix; anything else here is the safety level.
  const platformOff = Boolean(
    conversation.agent && !normalizeAgentPlatforms(enabledPlatforms).includes(conversation.agent),
  );
  const heldReason = sendingHeldReason(snapshot, conversation, platformOff);
  return (
    <div key={conversation.id} className="relative flex h-full min-h-0 min-w-0 flex-col">
      {/* Conversation notices stay inside this pane, including when it is hidden. */}
      <FloatingNoticeLayer independent columnRem={TRANSCRIPT_COLUMN_REM}>
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
            label="Agent unavailable"
            summary={`${AGENT_PLATFORM_LABELS[conversation.agent]} is unavailable for Coordinator.`}
            action={
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  className={FLOATING_NOTICE_ACTION}
                  onClick={() => requestGlobalSettings(platformOff ? "platforms" : "coordinator")}
                >
                  <Settings2 className="size-3" />
                  {platformOff ? "Platform settings" : "Coordinator settings"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={FLOATING_NOTICE_ACTION}
                  onClick={onRetry}
                >
                  <RotateCcw className="size-3" />
                  Retry
                </Button>
              </>
            }
          >
            <span className="font-medium">
              {AGENT_PLATFORM_LABELS[conversation.agent]} is unavailable for Coordinator.
            </span>{" "}
            <span className="text-muted-foreground">{providerState?.reason}</span>
          </CoordinatorBanner>
        ) : null}
        <AgentMailBanner
          environmentId={data.environmentId}
          tabId={conversation.tabId}
          agentAvailable={conversation.agent ? !providerUnavailable : availablePlatforms.length > 0}
          deliveryHeldReason={heldReason}
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
              data={data}
              isActive
              ownsGlobalShortcuts={paneFocused}
              executionPolicy="coordinator-read-only"
              coordinatorProjectId={projectId}
              coordinatorConversationId={conversation.id}
              coordinatorWorkspacePath={snapshot.projectPath}
              availablePlatforms={availablePlatforms}
              platformNotes={platformNotes}
              platformBadges={platformBadges}
              // A side agent launches nothing, so it is not asked what to get
              // done, and its hint says what it is for. The main has no line
              // under its composer: the placeholder covers @ and ! instead.
              composerPlaceholder={
                side ? COORDINATOR_SIDE_COMPOSER_PLACEHOLDER : COORDINATOR_COMPOSER_PLACEHOLDER
              }
              {...(side ? { composerHint: COORDINATOR_SIDE_AGENT_EXPLANATION } : {})}
              {...(heldReason ? { sendingHeldReason: heldReason } : {})}
              // Only the main coordinator delegates, so only it is offered work
              // that has to run in a pipeline or environment.
              {...(conversation.role === "main" ? MAIN_UNASSIGNED : {})}
              emptyPlatformsMessage="No agent platform meets this coordinator's read-only requirement on this machine. Enable a qualified platform, or lower the coordinator safety level in Settings."
              emptyPlatformsAction={EMPTY_PLATFORMS_ACTION}
              onAssignPlatform={conversation.agent ? undefined : onAssignPlatform}
              beforeSend={side ? undefined : beforeSend}
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
      </FloatingNoticeLayer>
    </div>
  );
}
