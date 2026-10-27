import {
  registerProtectedRichCache,
  type RichConversationScope,
} from "@/lib/chat/rich-content-reset";
import { create } from "zustand";
import { artifactErrorInfo } from "@/lib/chat/artifact-requests";
import type { ArtifactLiveSessionResponse } from "@orkestrator/protocol/transcript-artifact-commands";
import {
  FRAME_CHANNEL_POLICY,
  FRONTEND_RENDER_POLICY,
} from "@orkestrator/protocol/rich-content-policy";
import { clampArtifactFrameHeight } from "@orkestrator/protocol/artifact-frame-channel";
import {
  closeTranscriptArtifactLiveSession,
  openTranscriptArtifactLiveSession,
} from "@/lib/backend/transcript-artifacts";

/**
 * The single live interactive-artifact host of this application window.
 *
 * Owned outside the virtualized transcript: rows only render a placeholder
 * and register it as the inline anchor; the host component mounted once at
 * the app root positions one persistent document over it (or in a panel or
 * full screen) without reparenting or reloading it. At most one session is
 * active (`FRONTEND_RENDER_POLICY.liveExecutableHostsPerWindow`); starting
 * another artifact asks for an explicit switch.
 *
 * Stopping ends only this view instance: the backend live-session capability
 * is released, while publications, history and agent work are untouched.
 *
 * `invalidate` disposes the view because its scope is gone (the
 * conversation's environment was deleted, the active environment or backend
 * changed, the session was replaced). It records why in `ended`, so the
 * transcript card shows its saved preview with that reason instead of a
 * document that silently vanished.
 */

export type LivePlacement = "inline" | "panel" | "fullscreen";

export type LivePhase =
  "opening" | "loading" | "ready" | "crashed" | "unresponsive" | "navigation-blocked" | "error";

export interface LiveArtifactTarget {
  /** `richArtifactOccurrenceKey` of the transcript occurrence. */
  occurrenceKey: string;
  publicationId: string;
  artifactId: string;
  revision: number;
  title: string;
  scope: {
    backendId: string;
    environmentId: string;
    logicalSessionKey: string;
    generation: string;
  };
  /** Saved receipt capture shown when the live document is unavailable. */
  previewDataUrl?: string;
  /** Initial frame height before the document reports its own. */
  initialHeight?: number;
}

export interface LiveLinkRequest {
  href: string;
  hostname: string;
  label: string;
}

export interface LiveHostSession {
  hostId: string;
  target: LiveArtifactTarget;
  phase: LivePhase;
  session: ArtifactLiveSessionResponse | null;
  placement: LivePlacement;
  frameHeight: number;
  linkRequest: LiveLinkRequest | null;
  message: string | null;
  /** 1 for the first run of this occurrence; increments on Reset. */
  sessionNumber: number;
}

export interface LiveHostEnded {
  occurrenceKey: string;
  environmentId: string;
  reason: string;
}

interface ArtifactLiveHostState {
  active: LiveHostSession | null;
  pendingSwitch: LiveArtifactTarget | null;
  /** The most recent view disposed by a scope change, with its reason. */
  ended: LiveHostEnded | null;
  anchors: ReadonlyMap<string, HTMLElement>;
  request: (target: LiveArtifactTarget) => "started" | "switch-pending" | "already-active";
  confirmSwitch: () => void;
  cancelSwitch: () => void;
  stop: () => void;
  /** Dispose the active view because its scope is no longer valid. */
  invalidate: (reason: string) => void;
  /** Forget a recorded disposal reason (the user acknowledged it). */
  clearEnded: (occurrenceKey: string) => void;
  reset: () => void;
  setPlacement: (placement: LivePlacement) => void;
  report: (
    hostId: string,
    patch: Partial<Pick<LiveHostSession, "phase" | "message" | "linkRequest">> & {
      height?: number;
    },
  ) => void;
  registerAnchor: (occurrenceKey: string, element: HTMLElement) => () => void;
  /** Tests only. */
  resetForTests: () => void;
}

export const DEFAULT_LIVE_FRAME_HEIGHT = 480;
/** One host per window; enforced structurally by the single `active` slot. */
export const LIVE_HOSTS_PER_WINDOW = FRONTEND_RENDER_POLICY.liveExecutableHostsPerWindow;

let hostCounter = 0;

function nextHostId(): string {
  hostCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `live-${Date.now().toString(36)}-${hostCounter}-${random}`;
}

function releaseSession(session: ArtifactLiveSessionResponse | null): void {
  if (!session) return;
  void closeTranscriptArtifactLiveSession({ generation: session.generation }).catch(() => {
    // Best effort: the capability also expires on its own.
  });
}

export const useArtifactLiveHostStore = create<ArtifactLiveHostState>((set, get) => {
  const start = (target: LiveArtifactTarget, sessionNumber: number) => {
    const hostId = nextHostId();
    set({
      active: {
        hostId,
        target,
        phase: "opening",
        session: null,
        placement: get().active?.placement ?? "inline",
        frameHeight: clampArtifactFrameHeight(target.initialHeight ?? DEFAULT_LIVE_FRAME_HEIGHT),
        linkRequest: null,
        message: null,
        sessionNumber,
      },
      pendingSwitch: null,
      ended: get().ended?.occurrenceKey === target.occurrenceKey ? null : get().ended,
    });
    openTranscriptArtifactLiveSession({
      environmentId: target.scope.environmentId,
      logicalSessionKey: target.scope.logicalSessionKey,
      publicationId: target.publicationId,
    })
      .then((session) => {
        const current = get().active;
        if (
          !current ||
          current.hostId !== hostId ||
          session.artifactId !== target.artifactId ||
          session.revision !== target.revision
        ) {
          // A late or mismatched session: never attach it to another view.
          releaseSession(session);
          if (current?.hostId === hostId) {
            set({
              active: {
                ...current,
                phase: "error",
                message: "The live session did not match this artifact revision.",
              },
            });
          }
          return;
        }
        set({ active: { ...current, session, phase: "loading" } });
      })
      .catch((error: unknown) => {
        const current = get().active;
        if (!current || current.hostId !== hostId) return;
        const info = artifactErrorInfo(error);
        const message =
          info.message && info.message !== "The request failed"
            ? info.message
            : "The interactive view could not be started.";
        set({ active: { ...current, phase: "error", message } });
      });
  };

  return {
    active: null,
    pendingSwitch: null,
    ended: null,
    anchors: new Map(),
    request: (target) => {
      const active = get().active;
      if (
        active &&
        active.target.occurrenceKey === target.occurrenceKey &&
        active.target.scope.generation === target.scope.generation
      ) {
        return "already-active";
      }
      if (active) {
        set({ pendingSwitch: target });
        return "switch-pending";
      }
      start(target, 1);
      return "started";
    },
    confirmSwitch: () => {
      const { pendingSwitch, active } = get();
      if (!pendingSwitch) return;
      releaseSession(active?.session ?? null);
      set({ active: null });
      start(pendingSwitch, 1);
    },
    cancelSwitch: () => set({ pendingSwitch: null }),
    stop: () => {
      const active = get().active;
      releaseSession(active?.session ?? null);
      set({ active: null, pendingSwitch: null });
    },
    invalidate: (reason) => {
      const active = get().active;
      if (!active) return;
      releaseSession(active.session);
      set({
        active: null,
        pendingSwitch: null,
        ended: {
          occurrenceKey: active.target.occurrenceKey,
          environmentId: active.target.scope.environmentId,
          reason,
        },
      });
    },
    clearEnded: (occurrenceKey) => {
      if (get().ended?.occurrenceKey === occurrenceKey) set({ ended: null });
    },
    reset: () => {
      const active = get().active;
      if (!active) return;
      releaseSession(active.session);
      start(active.target, active.sessionNumber + 1);
    },
    setPlacement: (placement) => {
      const active = get().active;
      if (!active || active.placement === placement) return;
      set({ active: { ...active, placement } });
    },
    report: (hostId, patch) => {
      const active = get().active;
      if (!active || active.hostId !== hostId) return;
      const { height, ...rest } = patch;
      set({
        active: {
          ...active,
          ...rest,
          ...(height !== undefined ? { frameHeight: clampArtifactFrameHeight(height) } : {}),
        },
      });
    },
    registerAnchor: (occurrenceKey, element) => {
      const next = new Map(get().anchors);
      next.set(occurrenceKey, element);
      set({ anchors: next });
      return () => {
        if (get().anchors.get(occurrenceKey) !== element) return;
        const remaining = new Map(get().anchors);
        remaining.delete(occurrenceKey);
        set({ anchors: remaining });
      };
    },
    resetForTests: () => {
      set({ active: null, pendingSwitch: null, ended: null, anchors: new Map() });
    },
  };
});

export const LIVE_FRAME_HEIGHT_BOUNDS = {
  min: FRAME_CHANNEL_POLICY.minInlineHeight,
  max: FRAME_CHANNEL_POLICY.maxInlineHeight,
};

export const LIVE_HOST_INVALIDATION_REASONS = {
  environmentDeleted: "The conversation's environment was deleted.",
  environmentChanged: "You switched to another environment.",
  backendChanged: "The backend connection changed.",
  sessionReplaced: "The conversation's session was replaced.",
} as const;

interface EnvironmentScopeSnapshot {
  environmentIds: ReadonlySet<string>;
  deletingIds: ReadonlySet<string>;
  selectedEnvironmentId: string | null;
  selectedEnvironmentIds: readonly string[];
}

/**
 * Decide whether the active live view's scope survived an environment/UI
 * change. Pure; exported for tests. Returns the invalidation reason or null.
 */
export function liveHostScopeInvalidation(
  environmentId: string,
  previous: EnvironmentScopeSnapshot,
  next: EnvironmentScopeSnapshot,
): string | null {
  if (
    next.deletingIds.has(environmentId) ||
    (previous.environmentIds.has(environmentId) && !next.environmentIds.has(environmentId))
  ) {
    return LIVE_HOST_INVALIDATION_REASONS.environmentDeleted;
  }
  if (
    next.selectedEnvironmentId !== previous.selectedEnvironmentId &&
    next.selectedEnvironmentId !== null &&
    next.selectedEnvironmentId !== environmentId &&
    !next.selectedEnvironmentIds.includes(environmentId)
  ) {
    return LIVE_HOST_INVALIDATION_REASONS.environmentChanged;
  }
  return null;
}

// The store owns capabilities and preview bytes even when the transcript is unmounted.
function clearProtectedHost(
  matches: (target: LiveArtifactTarget) => boolean,
  reason?: string,
): void {
  const state = useArtifactLiveHostStore.getState();
  if (state.active && matches(state.active.target)) {
    if (reason) state.invalidate(reason);
    else state.stop();
    useArtifactLiveHostStore.setState({ ...(reason ? {} : { ended: null }), anchors: new Map() });
  } else if (state.pendingSwitch && matches(state.pendingSwitch)) {
    state.cancelSwitch();
  }
}
registerProtectedRichCache("artifact-live-host", {
  clearAll: (reason) => {
    clearProtectedHost(
      () => true,
      reason === "backend-identity" ? LIVE_HOST_INVALIDATION_REASONS.backendChanged : undefined,
    );
    useArtifactLiveHostStore.setState({
      anchors: new Map(),
      ...(reason === "backend-identity" ? {} : { ended: null }),
    });
  },
  clearEnvironment: (id) =>
    clearProtectedHost(
      (target) => target.scope.environmentId === id,
      LIVE_HOST_INVALIDATION_REASONS.environmentDeleted,
    ),
  clearConversation: (scope: RichConversationScope) =>
    clearProtectedHost(
      (target) =>
        target.scope.backendId === scope.backendId &&
        target.scope.environmentId === scope.environmentId &&
        target.scope.logicalSessionKey === scope.logicalSessionKey,
    ),
});
