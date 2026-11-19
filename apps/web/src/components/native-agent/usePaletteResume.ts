import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  observeNativeAgentResumeRequest,
  retryNativeAgentResumeSave,
  runNativeAgentResumeRequest,
  type NativeAgentResumeIntent,
} from "@/lib/native-agent-resume-requests";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { createPersistedPaneLayoutInput, flushPaneLayoutNow } from "@/lib/pane-layout-persistence";
import { paneLayoutStore } from "@/stores/paneLayoutStore";

/** Adopts the conversation chosen in History only after its exact tab is durable. */
export function usePaletteResume({
  scope,
  environmentId,
  tabId,
  platform,
  initialResume,
  resumeChosenSession,
  setAwaitingResumeChoice,
}: {
  scope: NodeScope;
  environmentId: string;
  tabId: string;
  platform: AgentPlatform;
  initialResume?: NativeAgentResumeIntent;
  resumeChosenSession: (providerSessionId: string) => Promise<void>;
  setAwaitingResumeChoice: (awaiting: boolean) => void;
}) {
  const paneLayouts = scope.store(paneLayoutStore);
  const resumeChosenSessionRef = useRef(resumeChosenSession);
  useEffect(() => {
    resumeChosenSessionRef.current = resumeChosenSession;
  });
  const [resumeSaveFailed, setResumeSaveFailed] = useState(false);
  const resumeTargetLayout = useCallback(() => {
    if (!initialResume || scope.disposed) return undefined;
    const { ref, request } = initialResume;
    if (
      ref.nodeId !== scope.nodeId ||
      ref.environmentId !== environmentId ||
      ref.tabId !== tabId ||
      request.platform !== platform
    )
      return undefined;
    const panes = paneLayouts.getState();
    const tab = panes.findPaneWithTab(tabId, environmentId)?.tabs.find((tab) => tab.id === tabId);
    if (tab?.type !== "agent-native" || tab.nativeAgentData?.platform !== platform)
      return undefined;
    return panes.environments.get(environmentId);
  }, [scope, environmentId, initialResume, paneLayouts, platform, tabId]);

  const finishInitialResume = useCallback(() => {
    if (!initialResume || !resumeTargetLayout()) return undefined;
    return runNativeAgentResumeRequest(initialResume.ref, initialResume.request, () =>
      resumeChosenSessionRef.current(initialResume.request.sessionId),
    );
  }, [initialResume, resumeTargetLayout]);

  useEffect(() => {
    if (
      !initialResume ||
      !observeNativeAgentResumeRequest(initialResume.ref, initialResume.request)
    )
      return;
    let mounted = true;
    const reportFailure = () => {
      if (mounted && resumeTargetLayout()) setResumeSaveFailed(true);
    };
    // The intent belongs to the tab, even if switching environments unmounts
    // the view while the save is pending. The layout check fences tab closure.
    void initialResume.request.ready
      .then(async (saved) => {
        if (!saved) {
          reportFailure();
          return;
        }
        const execution = finishInitialResume();
        if (!execution) return;
        await execution;
        if (mounted) setAwaitingResumeChoice(false);
      })
      .catch(reportFailure);
    return () => {
      mounted = false;
    };
  }, [finishInitialResume, initialResume, resumeTargetLayout, setAwaitingResumeChoice]);

  const retryResumeSave = async () => {
    if (!initialResume || !resumeTargetLayout()) return;
    setResumeSaveFailed(false);
    const saved = await retryNativeAgentResumeSave(
      initialResume.ref,
      initialResume.request,
      async () => {
        const layout = resumeTargetLayout();
        if (!layout) throw new Error("The resume tab was removed");
        await flushPaneLayoutNow(
          environmentId,
          createPersistedPaneLayoutInput(layout),
          undefined,
          undefined,
          scope,
        );
      },
    );
    if (saved) await finishInitialResume();
    else if (resumeTargetLayout()) setResumeSaveFailed(true);
  };

  return { resumeSaveFailed, retryResumeSave };
}
