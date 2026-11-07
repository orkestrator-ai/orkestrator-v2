/**
 * The native-agent sync protocol a node's backend speaks
 * (`get_native_agent_sync_capabilities`), cached per node scope (plan item
 * 3016). It used to be module state in `useNativeAgentSession.ts`, one answer
 * for the whole page; now each node scope holds its own, so a second live
 * node is never read with the first one's protocol. A caller that names no
 * scope gets the command node's, which is where every session read goes until
 * plan item 3009 scopes them.
 */

import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { NATIVE_AGENT_LIVE_UPDATE_VERSION } from "@orkestrator/protocol/native-agent";
import { NATIVE_AGENT_OBSERVATION_EVENT_VERSION } from "@orkestrator/protocol/native-agent-observation";
import { NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } from "@orkestrator/protocol/native-agent-transcript-patch";
import { getNativeAgentSyncCapabilities } from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
// The factory from its own module: suites replace the barrel with partial mocks.
import { createWorkflowsApi } from "@/lib/backend/workflows";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";

/** How long an "unsupported" answer is trusted before the backend is asked again. */
const UNSUPPORTED_RECHECK_MS = 30_000;

interface SyncCapability {
  supported: boolean;
  progressive: boolean;
  /** The backend announces stamped, session-scoped activity invalidations. */
  observationEvents?: boolean;
  /** The backend can answer transcript deltas with part-level patches. */
  transcriptPatches?: boolean;
  /** The backend answers transcript and state in one request. */
  liveUpdate?: boolean;
  checkedAt: number;
  generation: number;
}

interface SyncCapabilityState {
  value: SyncCapability | null;
  generation: number;
  invalidationQueued: boolean;
  request: { generation: number; promise: Promise<boolean> } | null;
}

const syncCapabilityState = defineScopedSlot<SyncCapabilityState>(
  "native-agent-sync-capabilities",
  () => ({ value: null, generation: 0, invalidationQueued: false, request: null }),
);

/** The answer for the current backend generation, or null. */
function current(scope?: NodeScope): SyncCapability | null {
  const state = syncCapabilityState(scope);
  return state.value?.generation === state.generation ? state.value : null;
}

/** Whether the node's backend speaks projection sync v1 (asks it once per generation). */
export async function nativeAgentSyncSupported(scope?: NodeScope): Promise<boolean> {
  const target = scope ?? appCommandScope();
  const state = syncCapabilityState(target);
  const generation = state.generation;
  const cached = state.value;
  if (
    cached &&
    cached.generation === generation &&
    (cached.supported || Date.now() - cached.checkedAt < UNSUPPORTED_RECHECK_MS)
  ) {
    return cached.supported;
  }
  if (state.request?.generation === generation) return state.request.promise;
  const promise = (async () => {
    try {
      const capabilities = await backendApiForScope(target, createWorkflowsApi, {
        getNativeAgentSyncCapabilities,
      }).getNativeAgentSyncCapabilities();
      const supported = capabilities.projectionSyncVersions?.includes(1) === true;
      if (generation === state.generation) {
        state.value = {
          supported,
          progressive: capabilities.progressiveViewVersions?.includes(1) === true,
          observationEvents:
            capabilities.observationEventVersions?.includes(
              NATIVE_AGENT_OBSERVATION_EVENT_VERSION,
            ) === true,
          transcriptPatches:
            capabilities.transcriptPatchVersions?.includes(
              NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION,
            ) === true,
          liveUpdate:
            capabilities.liveUpdateVersions?.includes(NATIVE_AGENT_LIVE_UPDATE_VERSION) === true,
          checkedAt: Date.now(),
          generation,
        };
      }
      return supported;
    } catch (error) {
      if (
        incompatibility(error, "get_native_agent_sync_capabilities")?.code === "unknown-command"
      ) {
        if (generation === state.generation) {
          state.value = { supported: false, progressive: false, checkedAt: Date.now(), generation };
        }
        return false;
      }
      throw error;
    }
  })();
  const request = { generation, promise };
  state.request = request;
  try {
    return await promise;
  } finally {
    if (state.request === request) state.request = null;
  }
}

export async function nativeAgentProgressiveSupported(scope?: NodeScope): Promise<boolean> {
  const target = scope ?? appCommandScope();
  await nativeAgentSyncSupported(target);
  return Boolean(current(target)?.progressive);
}

/**
 * Whether the node's backend announces stamped, session-scoped activity
 * invalidations (step 07). Synchronous and conservative: false until the
 * capability read for the current backend generation has answered.
 */
export function nativeObservationEventsSupported(scope?: NodeScope): boolean {
  return Boolean(current(scope)?.observationEvents);
}

/** Synchronous and conservative: false until this backend generation answered. */
export function nativeTranscriptPatchesSupported(scope?: NodeScope): boolean {
  return Boolean(current(scope)?.transcriptPatches);
}

/** Synchronous and conservative: false until this backend generation answered. */
export function nativeLiveUpdateSupported(scope?: NodeScope): boolean {
  return Boolean(current(scope)?.liveUpdate);
}

/** The backend turned out not to answer `get_native_agent_live_update`. */
export function disableNativeLiveUpdate(scope?: NodeScope): void {
  const value = syncCapabilityState(scope).value;
  if (value) value.liveUpdate = false;
}

/**
 * The node's backend may have been replaced (a reconnect or resync
 * announcement): ask it again. Every mounted session hears the same
 * announcement, so callbacks delivered in one turn count as one
 * backend-generation change and can still share the replacement's request.
 */
export function invalidateNativeAgentSyncCapability(scope?: NodeScope): void {
  const state = syncCapabilityState(scope);
  if (state.invalidationQueued) return;
  state.invalidationQueued = true;
  state.generation += 1;
  state.value = null;
  queueMicrotask(() => {
    state.invalidationQueued = false;
  });
}
