import type { ClientStateCapabilities } from "@orkestrator/protocol/client-state";
import { backendApiForScope } from "@/lib/backend/client";
import { createClientStateApi, getClientStateCapabilities } from "@/lib/backend/client-state";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot, listenInScope } from "@/lib/node-scope-slots";

/** How long an "unsupported" answer is trusted before the backend is asked again. */
const UNSUPPORTED_RECHECK_MS = 30_000;

/** One node's answer, held on its scope (plan item 3016). */
interface ClientStateCapabilityCache {
  cached: { generation: number; value: ClientStateCapabilities; checkedAt: number } | null;
  generation: number;
  request: { generation: number; promise: Promise<ClientStateCapabilities> } | null;
  listening: boolean;
  /** Bumps `generation` on every reconnect of this node's event stream. */
  listenForReconnects(): void;
}

const capabilityCache = defineScopedSlot<ClientStateCapabilityCache>(
  "client-state-capabilities",
  (scope) => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    scope.onDispose("client-state-capabilities", () => {
      disposed = true;
      unlisten?.();
    });
    const state: ClientStateCapabilityCache = {
      cached: null,
      generation: 0,
      request: null,
      listening: false,
      listenForReconnects: () => {
        if (state.listening || disposed) return;
        state.listening = true;
        // A reconnect may reach a different (older or newer) backend.
        listenInScope(scope, NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
          state.generation += 1;
        }).then(
          (stop) => {
            if (disposed) stop();
            else unlisten = stop;
          },
          () => {
            state.listening = false;
          },
        );
      },
    };
    return state;
  },
);

/**
 * Which formerly browser-local state `scope`'s backend owns (default: the
 * command node; `@orkestrator/protocol/client-state`). Folded into the
 * `config` domain, which answers without asking the node (the command that
 * asked an older backend retired with the one-time support floor
 * v2.39.1-beta, to-do 8304 (retired)). Each node scope caches its own answer, which a
 * test can set (`resetClientStateCapabilitiesForTests`).
 */
export async function clientStateCapabilities(scope?: NodeScope): Promise<ClientStateCapabilities> {
  const target = scope ?? appCommandScope();
  const state = capabilityCache(target);
  state.listenForReconnects();
  const current = state.generation;
  const cached = state.cached;
  if (
    cached &&
    cached.generation === current &&
    (Object.values(cached.value).some(Boolean) ||
      Date.now() - cached.checkedAt < UNSUPPORTED_RECHECK_MS)
  ) {
    return cached.value;
  }
  if (state.request?.generation === current) return state.request.promise;
  const api = backendApiForScope(target, createClientStateApi, { getClientStateCapabilities });
  const promise = api.getClientStateCapabilities().then((value) => {
    if (current === state.generation) {
      state.cached = { generation: current, value, checkedAt: Date.now() };
    }
    return value;
  });
  const entry = { generation: current, promise };
  state.request = entry;
  try {
    return await promise;
  } finally {
    if (state.request === entry) state.request = null;
  }
}

export function resetClientStateCapabilitiesForTests(
  value?: ClientStateCapabilities,
  scope?: NodeScope,
): void {
  const state = capabilityCache(scope);
  state.generation += 1;
  state.request = null;
  state.cached = value ? { generation: state.generation, value, checkedAt: Date.now() } : null;
}
