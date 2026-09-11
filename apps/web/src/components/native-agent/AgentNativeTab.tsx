import { memo, useCallback, useMemo, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { Button } from "@/components/ui/button";
import { createPersistedPaneLayoutInput, flushPaneLayoutNow } from "@/lib/pane-layout-persistence";
import { writeCoordinatorAttachment } from "@/lib/backend";
import { createSessionKey } from "@/lib/utils";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { type AgentNativeTabProps, findNativeAgentAdapter } from "./adapter";
import { UnassignedNativeAgentComposer } from "./AgentNativeTab.helpers";
import { SharedNativeAgentController } from "./AgentNativeTab.controller";

export const AgentNativeTab = memo(function AgentNativeTab(props: AgentNativeTabProps) {
  const [awaitingDurability, setAwaitingDurability] = useState(false);
  const [durabilityError, setDurabilityError] = useState<string | null>(null);
  const [pendingDurabilityOperation, setPendingDurabilityOperation] = useState<
    "send" | "resume" | null
  >(null);
  const [resumeRequestedPlatform, setResumeRequestedPlatform] = useState<AgentPlatform | null>(
    null,
  );
  const adapter = useMemo(
    () => (props.data.platform ? findNativeAgentAdapter(props.data.platform) : undefined),
    [props.data.platform],
  );
  const persistLockedPane = useCallback(
    async (operation: "send" | "resume") => {
      setAwaitingDurability(true);
      setDurabilityError(null);
      setPendingDurabilityOperation(operation);
      const environment = usePaneLayoutStore.getState().environments.get(props.data.environmentId);
      if (!environment) {
        setDurabilityError("The locked agent tab is no longer available to save.");
        setAwaitingDurability(false);
        return;
      }
      try {
        await flushPaneLayoutNow(
          props.data.environmentId,
          createPersistedPaneLayoutInput(environment),
        );
        if (operation === "send") {
          const sessionKey = createSessionKey(props.data.environmentId, props.tabId);
          const draft = useNativeComposeStore.getState().drafts.get(sessionKey);
          // Attachment metadata is not encoded in the persisted initial prompt.
          // Preserve it until the shared controller has handed the files to the
          // backend; text-only drafts can be cleared immediately.
          if ((draft?.attachments.length ?? 0) === 0) {
            useNativeComposeStore.getState().clearDraft(sessionKey);
          }
        }
        setPendingDurabilityOperation(null);
        setAwaitingDurability(false);
      } catch (error) {
        console.warn("[AgentNativeTab] Failed to persist provider lock:", error);
        setDurabilityError("The agent choice is locked, but could not be saved.");
        setAwaitingDurability(false);
      }
    },
    [props.data.environmentId, props.tabId],
  );
  const lockAndSend = useCallback(
    async (
      platform: AgentPlatform,
      prompt: string,
      options: {
        modelId?: string;
        reasoningId?: string;
        fastMode: boolean;
        mode?: "build" | "plan";
        executionProfileId?: string;
      },
    ) => {
      setAwaitingDurability(true);
      setDurabilityError(null);
      const paneStore = usePaneLayoutStore.getState();
      const lockedPlatform = paneStore.lockTabNativePlatform(
        props.tabId,
        platform,
        props.data.environmentId,
        {
          initialPrompt: prompt,
          initialAgentModel: options.modelId,
          initialReasoningEffort: options.reasoningId,
          initialConversationMode: options.mode,
          initialFastMode: options.fastMode,
          initialExecutionProfileId: options.executionProfileId,
        },
      );
      if (!lockedPlatform) {
        setDurabilityError("This tab could not be locked to an agent.");
        setPendingDurabilityOperation(null);
        setAwaitingDurability(false);
        return;
      }
      await persistLockedPane("send");
    },
    [persistLockedPane, props.data.environmentId, props.tabId],
  );
  /**
   * Bind a coordinator conversation to the platform its first prompt chose.
   *
   * The pane store owns a normal tab's provider lock, but a coordinator
   * conversation is durable backend state that outlives any pane. The backend
   * is therefore the authority here, and nothing is dispatched until it has
   * accepted the assignment — a failure leaves the composer exactly as the user
   * left it, with the draft intact, rather than a half-bound conversation.
   */
  const assignAndSend = useCallback(
    async (
      platform: AgentPlatform,
      prompt: string,
      options: {
        modelId?: string;
        reasoningId?: string;
        fastMode: boolean;
        mode?: "build" | "plan";
        executionProfileId?: string;
      },
    ) => {
      setAwaitingDurability(true);
      setDurabilityError(null);
      setPendingDurabilityOperation("send");
      try {
        await props.onAssignPlatform?.(platform, prompt, options);
        setPendingDurabilityOperation(null);
      } catch (error) {
        setDurabilityError(
          error instanceof Error ? error.message : "This conversation could not be started.",
        );
      } finally {
        setAwaitingDurability(false);
      }
    },
    [props],
  );
  const lockAndResume = useCallback(
    async (platform: AgentPlatform) => {
      const selectedAdapter = findNativeAgentAdapter(platform);
      if (!selectedAdapter?.capabilities.resume) return;
      setAwaitingDurability(true);
      setDurabilityError(null);
      const paneStore = usePaneLayoutStore.getState();
      const lockedPlatform = paneStore.lockTabNativePlatform(
        props.tabId,
        platform,
        props.data.environmentId,
      );
      const lockedAdapter = lockedPlatform ? findNativeAgentAdapter(lockedPlatform) : undefined;
      if (!lockedPlatform || !lockedAdapter?.capabilities.resume) {
        setDurabilityError("This tab could not be opened for session resume.");
        setPendingDurabilityOperation(null);
        setAwaitingDurability(false);
        return;
      }
      setResumeRequestedPlatform(lockedPlatform);
      await persistLockedPane("resume");
    },
    [persistLockedPane, props.data.environmentId, props.tabId],
  );

  // Stable across renders: the paste handler re-registers its document
  // listener whenever this identity changes.
  const writeCoordinatorImage = useCallback(
    (filename: string, base64Data: string) =>
      writeCoordinatorAttachment(props.data.environmentId, filename, base64Data),
    [props.data.environmentId],
  );

  // A tab whose platform has no adapter is a data problem, not a crash. Render
  // the mismatch instead of throwing out of the pane and taking its siblings
  // down with it.
  if (!props.data.platform) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {durabilityError ? (
          // Inline rather than replacing the composer: a failed assignment
          // leaves the conversation unbound, and the draft the user typed is
          // still the thing they want to send.
          <div
            role="alert"
            className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-sm text-destructive"
          >
            {durabilityError}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          <UnassignedNativeAgentComposer
            tabId={props.tabId}
            environmentId={props.data.environmentId}
            containerId={props.data.containerId}
            disabled={awaitingDurability}
            onSend={(platform, prompt, options) => {
              void (props.onAssignPlatform
                ? assignAndSend(platform, prompt, options)
                : lockAndSend(platform, prompt, options));
            }}
            // A coordinator conversation owns its provider session, so there is no
            // rollout for it to adopt.
            {...(props.onAssignPlatform
              ? {}
              : {
                  onResume: (platform: AgentPlatform) => {
                    void lockAndResume(platform);
                  },
                })}
            {...(props.coordinatorProjectId ? { projectId: props.coordinatorProjectId } : {})}
            {...(props.coordinatorWorkspacePath
              ? { workspacePath: props.coordinatorWorkspacePath }
              : {})}
            {...(props.executionPolicy === "coordinator-read-only"
              ? {
                  // The checkout this conversation reads is the user's own, so a
                  // pasted image is staged under application data instead — the
                  // same place the assigned composer writes one.
                  writeImage: writeCoordinatorImage,
                }
              : {})}
            {...(props.availablePlatforms ? { platformFilter: props.availablePlatforms } : {})}
            {...(props.unassignedPlaceholder ? { placeholder: props.unassignedPlaceholder } : {})}
            {...(props.emptyPlatformsMessage
              ? { emptyPlatformsMessage: props.emptyPlatformsMessage }
              : {})}
          />
        </div>
      </div>
    );
  }
  if (awaitingDurability) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Saving agent choice…
      </div>
    );
  }
  if (durabilityError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-destructive">
        <p>{durabilityError}</p>
        {pendingDurabilityOperation ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void persistLockedPane(pendingDurabilityOperation);
            }}
          >
            Retry save
          </Button>
        ) : null}
      </div>
    );
  }
  if (!adapter) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        This tab refers to an unsupported agent, so it cannot be opened.
      </div>
    );
  }

  return (
    <SharedNativeAgentController
      {...props}
      initialResumeOpen={resumeRequestedPlatform === props.data.platform}
    />
  );
});
