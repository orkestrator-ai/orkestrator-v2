import {
  registerProtectedRichCache,
  type RichConversationScope,
} from "@/lib/chat/rich-content-reset";
import { create } from "zustand";
import type { BackendId } from "@orkestrator/protocol/federation";
import { artifactErrorInfo } from "@/lib/chat/artifact-requests";
import type { ArtifactLiveSessionResponse } from "@orkestrator/protocol/transcript-artifact-commands";
import {
  FRAME_CHANNEL_POLICY,
  FRONTEND_RENDER_POLICY,
} from "@orkestrator/protocol/rich-content-policy";
import { clampArtifactFrameHeight } from "@orkestrator/protocol/artifact-frame-channel";
import { backendApiForScope } from "@/lib/backend/client";
import {
  closeTranscriptArtifactLiveSession,
  createTranscriptArtifactsApi,
  openTranscriptArtifactLiveSession,
} from "@/lib/backend/transcript-artifacts";
import type { ByteBudget } from "@/lib/node-scope/byte-budget";
import type { NodeScope } from "@/lib/node-scope/node-scope";

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
 * The host is window-owned (one per renderer, like the document it shows),
 * but everything it holds names its node (plan item 3008): a target carries
 * the `nodeId` of the node scope that asked for it, the live session is
 * opened and closed on that scope's client, anchors and ended notes are keyed
 * by `(nodeId, occurrenceKey)`, and a saved preview it keeps reserves its
 * bytes from the window's `artifacts` budget under that node. Disposing the
 * scope releases all of it.
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
  /** The node scope whose transcript holds the occurrence; set by `request`. */
  nodeId: BackendId;
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

/** What a producer asks for; `request` adds the asking scope's `nodeId`. */
export type LiveArtifactRequest = Omit<LiveArtifactTarget, "nodeId">;

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
  nodeId: BackendId;
  occurrenceKey: string;
  environmentId: string;
  reason: string;
}

export interface ArtifactLiveHostState {
  active: LiveHostSession | null;
  pendingSwitch: LiveArtifactTarget | null;
  /** The most recent view disposed by a scope change, with its reason. */
  ended: LiveHostEnded | null;
  /** Inline anchors keyed by `liveAnchorKey(nodeId, occurrenceKey)`. */
  anchors: ReadonlyMap<string, HTMLElement>;
  /** `owner` is the node scope whose transcript asks; the session runs on its node. */
  request: (
    owner: NodeScope,
    target: LiveArtifactRequest,
  ) => "started" | "switch-pending" | "already-active";
  confirmSwitch: () => void;
  cancelSwitch: () => void;
  stop: () => void;
  /** Dispose the active view because its scope is no longer valid. */
  invalidate: (reason: string) => void;
  /** Forget a recorded disposal reason (the user acknowledged it). */
  clearEnded: (nodeId: BackendId, occurrenceKey: string) => void;
  reset: () => void;
  setPlacement: (placement: LivePlacement) => void;
  report: (
    hostId: string,
    patch: Partial<Pick<LiveHostSession, "phase" | "message" | "linkRequest">> & {
      height?: number;
    },
  ) => void;
  /** `owner` is the placeholder's node scope; disposing it drops the anchor. */
  registerAnchor: (owner: NodeScope, occurrenceKey: string, element: HTMLElement) => () => void;
  /** Drops everything of `nodeId`: its node scope was disposed. */
  releaseNode: (nodeId: BackendId) => void;
  /** Tests only. */
  resetForTests: () => void;
}

export const DEFAULT_LIVE_FRAME_HEIGHT = 480;
/** One host per window; enforced structurally by the single `active` slot. */
export const LIVE_HOSTS_PER_WINDOW = FRONTEND_RENDER_POLICY.liveExecutableHostsPerWindow;

/** Bounded prefix of this host's reservations in the window `artifacts` budget. */
export const LIVE_HOST_BUDGET_NAME = "artifact-live-host";

export function liveAnchorKey(nodeId: BackendId, occurrenceKey: string): string {
  return `${nodeId}\u0000${occurrenceKey}`;
}

/** Whether `entry` (a target or an ended note) is `occurrenceKey` on `nodeId`. */
export function isLiveOccurrence(
  entry: { nodeId: BackendId; occurrenceKey: string } | null | undefined,
  nodeId: BackendId,
  occurrenceKey: string,
): boolean {
  return !!entry && entry.nodeId === nodeId && entry.occurrenceKey === occurrenceKey;
}

let hostCounter = 0;

function nextHostId(): string {
  hostCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `live-${Date.now().toString(36)}-${hostCounter}-${random}`;
}

/**
 * The node scope each node's live work runs on, set by `request` and dropped
 * when that scope is disposed. The host is window-owned, so this map is too.
 */
const owners = new Map<BackendId, NodeScope>();
const boundOwners = new WeakSet<NodeScope>();

/** The node scope a target of `nodeId` runs on, while it is open. */
export function artifactLiveHostOwner(nodeId: BackendId): NodeScope | null {
  return owners.get(nodeId) ?? null;
}

function liveApi(owner: NodeScope) {
  return backendApiForScope(owner, createTranscriptArtifactsApi, {
    openTranscriptArtifactLiveSession,
    closeTranscriptArtifactLiveSession,
  });
}

function releaseSession(session: ArtifactLiveSessionResponse | null, nodeId: BackendId): void {
  if (!session) return;
  const owner = owners.get(nodeId);
  // A node whose scope is gone took its connection with it; the capability expires on its own.
  if (!owner) return;
  void liveApi(owner)
    .closeTranscriptArtifactLiveSession({ generation: session.generation })
    .catch(() => {
      // Best effort: the capability also expires on its own.
    });
}

interface PreviewHold {
  budget: ByteBudget;
  nodeId: BackendId;
  key: string;
}

/** The budget reservation behind each held target's saved preview. */
const previewHolds = new WeakMap<LiveArtifactTarget, PreviewHold>();
let previewHoldCounter = 0;

function withoutPreview(target: LiveArtifactTarget): LiveArtifactTarget {
  const { previewDataUrl: _dropped, ...rest } = target;
  return rest;
}

function releasePreview(target: LiveArtifactTarget | null | undefined): void {
  if (!target) return;
  const hold = previewHolds.get(target);
  if (!hold) return;
  previewHolds.delete(target);
  hold.budget.release(hold.nodeId, hold.key);
}

export const useArtifactLiveHostStore = create<ArtifactLiveHostState>((set, get) => {
  /**
   * Reserves the target's saved preview from the window `artifacts` budget
   * under its node. A refused reservation drops the preview (the live view
   * still runs); an eviction drops it later. The shown node is never evicted.
   */
  const holdPreview = (owner: NodeScope, target: LiveArtifactTarget): LiveArtifactTarget => {
    const preview = target.previewDataUrl;
    if (!preview) return target;
    previewHoldCounter += 1;
    const key = `${LIVE_HOST_BUDGET_NAME}\u0000${previewHoldCounter}`;
    const budget = owner.budgets.artifacts;
    const result = budget.reserve(owner.nodeId, key, preview.length, {
      onEvict: () => {
        if (previewHolds.get(target)?.key !== key) return;
        previewHolds.delete(target);
        const stripped = withoutPreview(target);
        const { active, pendingSwitch } = get();
        if (active?.target === target) set({ active: { ...active, target: stripped } });
        if (pendingSwitch === target) set({ pendingSwitch: stripped });
      },
    });
    if (!result.granted) return withoutPreview(target);
    previewHolds.set(target, { budget, nodeId: owner.nodeId, key });
    return target;
  };

  const bindOwner = (owner: NodeScope) => {
    // A disposed scope is never an owner: its target then fails as "no longer connected".
    if (owner.disposed) return;
    owners.set(owner.nodeId, owner);
    if (boundOwners.has(owner)) return;
    boundOwners.add(owner);
    owner.onDispose(LIVE_HOST_BUDGET_NAME, () => {
      get().releaseNode(owner.nodeId);
      if (owners.get(owner.nodeId) === owner) owners.delete(owner.nodeId);
    });
  };

  const start = (target: LiveArtifactTarget, sessionNumber: number) => {
    const hostId = nextHostId();
    const ended = get().ended;
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
      ended: isLiveOccurrence(ended, target.nodeId, target.occurrenceKey) ? null : ended,
    });
    const owner = owners.get(target.nodeId);
    if (!owner) {
      const current = get().active;
      if (current?.hostId === hostId) {
        set({
          active: { ...current, phase: "error", message: "This machine is no longer connected." },
        });
      }
      return;
    }
    liveApi(owner)
      .openTranscriptArtifactLiveSession({
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
          releaseSession(session, target.nodeId);
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

  /** Releases the active view's session and preview, and a pending target's preview. */
  const releaseActive = (active: LiveHostSession | null) => {
    if (!active) return;
    releaseSession(active.session, active.target.nodeId);
    releasePreview(active.target);
  };

  return {
    active: null,
    pendingSwitch: null,
    ended: null,
    anchors: new Map(),
    request: (owner, input) => {
      bindOwner(owner);
      const target: LiveArtifactTarget = { ...input, nodeId: owner.nodeId };
      const active = get().active;
      if (
        active &&
        isLiveOccurrence(active.target, target.nodeId, target.occurrenceKey) &&
        active.target.scope.generation === target.scope.generation
      ) {
        return "already-active";
      }
      if (active) {
        const previous = get().pendingSwitch;
        const pending = holdPreview(owner, target);
        releasePreview(previous);
        set({ pendingSwitch: pending });
        return "switch-pending";
      }
      start(holdPreview(owner, target), 1);
      return "started";
    },
    confirmSwitch: () => {
      const { pendingSwitch, active } = get();
      if (!pendingSwitch) return;
      releaseActive(active);
      set({ active: null });
      start(pendingSwitch, 1);
    },
    cancelSwitch: () => {
      releasePreview(get().pendingSwitch);
      set({ pendingSwitch: null });
    },
    stop: () => {
      const { active, pendingSwitch } = get();
      releaseActive(active);
      releasePreview(pendingSwitch);
      set({ active: null, pendingSwitch: null });
    },
    invalidate: (reason) => {
      const { active, pendingSwitch } = get();
      if (!active) return;
      releaseActive(active);
      releasePreview(pendingSwitch);
      set({
        active: null,
        pendingSwitch: null,
        ended: {
          nodeId: active.target.nodeId,
          occurrenceKey: active.target.occurrenceKey,
          environmentId: active.target.scope.environmentId,
          reason,
        },
      });
    },
    clearEnded: (nodeId, occurrenceKey) => {
      if (isLiveOccurrence(get().ended, nodeId, occurrenceKey)) set({ ended: null });
    },
    reset: () => {
      const active = get().active;
      if (!active) return;
      releaseSession(active.session, active.target.nodeId);
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
    registerAnchor: (owner, occurrenceKey, element) => {
      bindOwner(owner);
      const key = liveAnchorKey(owner.nodeId, occurrenceKey);
      const next = new Map(get().anchors);
      next.set(key, element);
      set({ anchors: next });
      return () => {
        if (get().anchors.get(key) !== element) return;
        const remaining = new Map(get().anchors);
        remaining.delete(key);
        set({ anchors: remaining });
      };
    },
    releaseNode: (nodeId) => {
      const { active, pendingSwitch, ended, anchors } = get();
      const next: Partial<ArtifactLiveHostState> = {};
      if (active?.target.nodeId === nodeId) {
        releaseActive(active);
        next.active = null;
      }
      if (pendingSwitch?.nodeId === nodeId || next.active === null) {
        releasePreview(pendingSwitch);
        next.pendingSwitch = null;
      }
      if (ended?.nodeId === nodeId) next.ended = null;
      const prefix = liveAnchorKey(nodeId, "");
      if (Array.from(anchors.keys()).some((key) => key.startsWith(prefix))) {
        next.anchors = new Map(Array.from(anchors).filter(([key]) => !key.startsWith(prefix)));
      }
      if (Object.keys(next).length > 0) set(next);
    },
    resetForTests: () => {
      const { active, pendingSwitch } = get();
      releasePreview(active?.target);
      releasePreview(pendingSwitch);
      owners.clear();
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
  clearBackend: (backendId, reason) =>
    clearProtectedHost(
      (target) => target.scope.backendId === backendId || target.nodeId === backendId,
      reason === "backend-identity" ? LIVE_HOST_INVALIDATION_REASONS.backendChanged : undefined,
    ),
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
