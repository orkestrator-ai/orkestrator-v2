import { memo, useCallback, useMemo, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { Button } from "@/components/ui/button";
import { createPersistedPaneLayoutInput, flushPaneLayoutNow } from "@/lib/pane-layout-persistence";
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

  // A tab whose platform has no adapter is a data problem, not a crash. Render
  // the mismatch instead of throwing out of the pane and taking its siblings
  // down with it.
  if (!props.data.platform) {
    return (
      <UnassignedNativeAgentComposer
        tabId={props.tabId}
        environmentId={props.data.environmentId}
        containerId={props.data.containerId}
        disabled={awaitingDurability}
        onSend={(platform, prompt, options) => {
          void lockAndSend(platform, prompt, options);
        }}
        onResume={(platform) => {
          void lockAndResume(platform);
        }}
      />
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
