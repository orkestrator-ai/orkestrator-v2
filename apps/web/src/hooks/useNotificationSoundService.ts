import { useEffect, useRef, useState } from "react";
import {
  COORDINATOR_WAKE_ATTENTION_EVENT,
  ENVIRONMENT_ATTENTION_EVENT,
  isCoordinatorWakeAttentionEvent,
  isEnvironmentAttentionEvent,
  isInputNeededAttentionReason,
  type EnvironmentAttentionEvent,
  type EnvironmentAttentionReason,
} from "@orkestrator/protocol/environment-attention";
import { normalizeNotificationSoundSettings } from "@orkestrator/protocol/notification-sounds";
import type { BackendId } from "@orkestrator/protocol/federation";
import { BoundedKeySet } from "@/lib/bounded-hydration";
import { clientStateCapabilities } from "@/lib/client-state-capabilities";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { configStore, useConfigStore } from "@/stores/configStore";
import { appCommandScope } from "@/lib/node-scope-slots";
import {
  coordinatorConversationTab,
  useActiveCoordinatorConversationStore,
} from "@/stores/activeCoordinatorConversationStore";
import { uiStore } from "@/stores/uiStore";
import { selectionOnScope } from "@/stores/windowSelectionStore";
import type { WindowScope } from "@/lib/node-scope/window-scope";
import { shownEnvironmentOn } from "@/lib/federation/window-attention";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { remoteAttentionTarget, useRemoteNodeAttention } from "./useRemoteNodeAttention";
import { useVisibleEnvironmentId } from "./useVisibleEnvironmentId";
import {
  playConfiguredNotificationSound,
  primeNotificationSounds,
  type NotificationSoundKind,
} from "@/lib/notification-sounds";
import { showQuestionDesktopNotification } from "@/lib/question-desktop-notification";

/** Attention ids remembered so a re-delivered event never sounds twice. */
export const ATTENTION_DEDUPE_LIMIT = 256;
/** Several environments finishing together are one cue. */
export const ATTENTION_COALESCE_MS = 500;

/**
 * This project (on `nodeId`) has its coordinator page on screen right now:
 * the window's selection is that project on that node, and the node's board
 * shows its coordinator.
 */
function coordinatorOnScreen(
  windowScope: WindowScope,
  nodeId: BackendId,
  projectId: string,
): boolean {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
  const scope = windowScope.get(nodeId);
  if (!scope || selectionOnScope(scope)?.projectId !== projectId) return false;
  const { projectBoardTab } = scope.store(uiStore).getState();
  const conversation = useActiveCoordinatorConversationStore.getState().active;
  return coordinatorConversationTab(conversation, { nodeId, projectId }, projectBoardTab) !== null;
}

interface LastCue {
  at: number;
  kind: NotificationSoundKind | null;
  playback?: Promise<boolean>;
}

/**
 * Reserves the cue slot. A question is never swallowed by another kind of cue
 * that just played; every other cue coalesces with whatever came first.
 */
function claimCue(last: { current: LastCue }, kind: NotificationSoundKind): boolean {
  const now = Date.now();
  const coalesced =
    now - last.current.at < ATTENTION_COALESCE_MS &&
    (kind !== "agent-question" || last.current.kind === "agent-question");
  if (coalesced) return false;
  last.current = { at: now, kind };
  return true;
}

/** The user is looking at this window right now, not just has it open. */
function windowFocused(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** The window's sound settings: those of the node it is connected to. */
function soundSettings() {
  return normalizeNotificationSoundSettings(
    appCommandScope().store(configStore).getState().config.global.notificationSounds,
  );
}

/**
 * Alerts that an agent is blocked on the user: the "agent question" cue and a
 * desktop notification, each behind its own setting. Unlike the "agent
 * stopped" cue this ignores which environment is selected unless the window
 * also has focus: a question left unanswered in a background window is the
 * one event the user asked never to miss.
 */
function alertInputNeeded(
  input: { environmentId: string; projectId: string; reason: EnvironmentAttentionReason },
  visibleEnvironmentId: string | null,
  lastCue: { current: LastCue },
  remote?: ReturnType<typeof remoteAttentionTarget>,
): void {
  if (input.environmentId === visibleEnvironmentId && windowFocused()) return;
  const settings = soundSettings();
  let playback = Promise.resolve(false);
  if (settings.agentQuestion) {
    if (claimCue(lastCue, "agent-question")) {
      lastCue.current.playback = playConfiguredNotificationSound("agent-question").catch(
        () => false,
      );
    }
    playback = lastCue.current.playback ?? playback;
  }
  if (settings.questionDesktopNotification) {
    void playback.then((played) => {
      showQuestionDesktopNotification({ ...input, silent: played, ...(remote ? { remote } : {}) });
    });
  }
}

/**
 * Attention from another node, under the same settings and coalescing as
 * this window's own node. Only the node the window shows can have its
 * environment on screen; that environment stays quiet as the window's own
 * selected one does.
 */
function alertRemoteAttention(
  windowScope: WindowScope,
  nodeId: string,
  { environmentId, projectId, reason }: EnvironmentAttentionEvent,
  lastCue: { current: LastCue },
): void {
  const onScreen = shownEnvironmentOn(windowScope, nodeId);
  if (isInputNeededAttentionReason(reason)) {
    alertInputNeeded(
      { environmentId, projectId, reason },
      onScreen,
      lastCue,
      remoteAttentionTarget(nodeId, projectId, environmentId),
    );
    return;
  }
  if (environmentId === onScreen) return;
  if (!soundSettings().agentStopped) return;
  if (!claimCue(lastCue, "agent-stopped")) return;
  void playConfiguredNotificationSound("agent-stopped");
}

/**
 * Plays the "agent stopped" cue from the backend's `environment-attention`
 * events (one per badge edge, with an id), and primes Web Audio on the first
 * user gesture. An environment already on screen stays quiet: that is this
 * client's own presentation decision, as is the cue being a sound at all.
 *
 * On/off stays in the shared config rather than per device: it says which
 * events deserve an alert, and a device that should be silent (a phone, a
 * muted desktop) already has its own mute. Moving it per device would bring
 * back browser-local state with no synced default for a new client.
 *
 * A backend that predates the event keeps the previous inference from the
 * environment snapshot's `hasUnreadWork` edge. Existing unread work at startup
 * is baselined rather than replayed, on either path; an event missed while
 * disconnected is not replayed either, because a late sound is not state.
 *
 * Plays the "coordinator report" cue from `coordinator-wake-attention` on the
 * same terms: once per wake, quiet while that coordinator's page is on screen in
 * a visible window. A backend that predates the event simply never sends it.
 *
 * An attention event whose reason means the agent needs input (a question, an
 * approval, a plan) gets the "agent question" cue and a desktop notification
 * instead; see {@link alertInputNeeded}.
 *
 * The window also alerts for every other node, through the window's
 * attention service ({@link useRemoteNodeAttention}, plan item 5001). While
 * another node is shown in the central region, none of this node's
 * environments is on screen.
 */
export function useNotificationSoundService(): void {
  const environments = useEnvironmentStore((state) => state.environments);
  const selectedEnvironmentId = useVisibleEnvironmentId();
  const agentStoppedSoundEnabled = useConfigStore(
    (state) =>
      normalizeNotificationSoundSettings(state.config.global.notificationSounds).agentStopped,
  );
  const prMergedSoundEnabled = useConfigStore(
    (state) => normalizeNotificationSoundSettings(state.config.global.notificationSounds).prMerged,
  );
  const coordinatorReportSoundEnabled = useConfigStore(
    (state) =>
      normalizeNotificationSoundSettings(state.config.global.notificationSounds).coordinatorReport,
  );
  const agentQuestionSoundEnabled = useConfigStore(
    (state) =>
      normalizeNotificationSoundSettings(state.config.global.notificationSounds).agentQuestion,
  );
  // Shared, so a worker's stop and the wake it causes in one moment are one cue.
  const lastCueRef = useRef<LastCue>({
    at: Number.NEGATIVE_INFINITY,
    kind: null,
  });
  const previousUnreadRef = useRef<Map<string, boolean> | null>(null);
  // Wake events arrive on the window's own stream, so they are its command node's.
  const { windowScope } = useScopesWithCommandFallback();
  const commandNodeId = windowScope.commandScope().nodeId;
  const commandNodeIdRef = useRef(commandNodeId);
  const windowScopeRef = useRef(windowScope);
  useEffect(() => {
    commandNodeIdRef.current = commandNodeId;
    windowScopeRef.current = windowScope;
  }, [commandNodeId, windowScope]);
  // Another node shown in the central region hides this node's selection.
  const otherNodeShown = useRemoteWorkspaceStore((state) => state.active !== null);
  const visibleEnvironmentId = otherNodeShown ? null : selectedEnvironmentId;
  const visibleEnvironmentRef = useRef(visibleEnvironmentId);
  useEffect(() => {
    visibleEnvironmentRef.current = visibleEnvironmentId;
  }, [visibleEnvironmentId]);
  const [eventDriven, setEventDriven] = useState(false);
  useRemoteNodeAttention((nodeId, event) =>
    alertRemoteAttention(windowScopeRef.current, nodeId, event, lastCueRef),
  );

  useEffect(() => {
    let disposed = false;
    const probe = () => {
      void clientStateCapabilities()
        .then((capabilities) => {
          if (!disposed) setEventDriven(capabilities.environmentAttention);
        })
        // Nothing learned: stays on the current path until the next reconnect.
        .catch(() => undefined);
    };
    // First, so the capability cache hears a reconnect before this re-probes.
    probe();
    let stopReconnects: UnlistenFn | null = null;
    void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, probe)
      .then((stop) => {
        if (disposed) stop();
        else stopReconnects = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stopReconnects?.();
    };
  }, []);

  useEffect(() => {
    if (!eventDriven) return;
    let disposed = false;
    let stop: UnlistenFn | null = null;
    const seen = new BoundedKeySet(ATTENTION_DEDUPE_LIMIT);
    void listen<unknown>(ENVIRONMENT_ATTENTION_EVENT, (event) => {
      // The payload crosses a process boundary; validate rather than trust.
      if (!isEnvironmentAttentionEvent(event.payload)) return;
      const { attentionId, environmentId, projectId, reason } = event.payload;
      if (!seen.add(attentionId)) return;
      if (isInputNeededAttentionReason(reason)) {
        alertInputNeeded(
          { environmentId, projectId, reason },
          visibleEnvironmentRef.current,
          lastCueRef,
        );
        return;
      }
      if (environmentId === visibleEnvironmentRef.current) return;
      if (!soundSettings().agentStopped) return;
      if (!claimCue(lastCueRef, "agent-stopped")) return;
      void playConfiguredNotificationSound("agent-stopped");
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, [eventDriven]);

  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | null = null;
    const seen = new BoundedKeySet(ATTENTION_DEDUPE_LIMIT);
    void listen<unknown>(COORDINATOR_WAKE_ATTENTION_EVENT, (event) => {
      if (!isCoordinatorWakeAttentionEvent(event.payload)) return;
      const { attentionId, projectId } = event.payload;
      if (
        !seen.add(attentionId) ||
        coordinatorOnScreen(windowScopeRef.current, commandNodeIdRef.current, projectId)
      )
        return;
      if (!soundSettings().coordinatorReport) return;
      if (!claimCue(lastCueRef, "coordinator-report")) return;
      void playConfiguredNotificationSound("coordinator-report");
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    const nextUnread = new Map(
      environments.map((environment) => [environment.id, environment.hasUnreadWork === true]),
    );
    const previousUnread = previousUnreadRef.current;
    previousUnreadRef.current = nextUnread;
    if (!previousUnread || eventDriven) return;

    let stoppedCue = false;
    for (const environment of environments) {
      const environmentId = environment.id;
      // A newly discovered environment belongs to snapshot hydration, not a
      // renderer-observed edge. The selected environment can optimistically
      // clear this bit before an authoritative snapshot restores it, so its
      // raw badge edge is not a semantic background completion.
      if (
        environmentId === selectedEnvironmentId ||
        nextUnread.get(environmentId) !== true ||
        previousUnread.get(environmentId) !== false
      )
        continue;
      const reason = environment.unreadReason;
      if (isInputNeededAttentionReason(reason)) {
        alertInputNeeded(
          { environmentId, projectId: environment.projectId, reason },
          selectedEnvironmentId,
          lastCueRef,
        );
      } else if (!stoppedCue) {
        stoppedCue = true;
        void playConfiguredNotificationSound("agent-stopped");
      }
    }
  }, [environments, eventDriven, selectedEnvironmentId]);

  useEffect(() => {
    if (
      !agentStoppedSoundEnabled &&
      !prMergedSoundEnabled &&
      !coordinatorReportSoundEnabled &&
      !agentQuestionSoundEnabled
    )
      return;
    let priming = false;
    let disposed = false;
    const prime = () => {
      if (priming) return;
      priming = true;
      void primeNotificationSounds().then((ready) => {
        priming = false;
        if (!ready || disposed) return;
        window.removeEventListener("pointerdown", prime);
        window.removeEventListener("keydown", prime);
      });
    };
    window.addEventListener("pointerdown", prime);
    window.addEventListener("keydown", prime);
    return () => {
      disposed = true;
      window.removeEventListener("pointerdown", prime);
      window.removeEventListener("keydown", prime);
    };
  }, [
    agentStoppedSoundEnabled,
    prMergedSoundEnabled,
    coordinatorReportSoundEnabled,
    agentQuestionSoundEnabled,
  ]);
}
