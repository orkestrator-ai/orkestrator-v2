import {
  CLIENT_STATE_CAPABILITIES_COMMAND,
  NO_CLIENT_STATE_CAPABILITIES,
  type ClientStateCapabilities,
} from "@orkestrator/protocol/client-state";
import { isUnknownViewCommandError } from "@orkestrator/protocol/view-sync";
import { getClientStateCapabilities } from "@/lib/backend/client-state";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";

/** How long an "unsupported" answer is trusted before the backend is asked again. */
const UNSUPPORTED_RECHECK_MS = 30_000;

let cached: { generation: number; value: ClientStateCapabilities; checkedAt: number } | null = null;
let generation = 0;
let request: { generation: number; promise: Promise<ClientStateCapabilities> } | null = null;
let listening = false;

function listenForReconnects(): void {
  if (listening) return;
  listening = true;
  // A reconnect may reach a different (older or newer) backend.
  void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
    generation += 1;
  }).catch(() => {
    listening = false;
  });
}

/**
 * Which formerly browser-local state the connected backend owns
 * (`@orkestrator/protocol/client-state`). An older backend answers
 * "unknown command", which turns every capability off. Any other failure
 * rejects: it says nothing about this backend, so callers decide nothing from
 * it and ask again on their next call.
 */
export async function clientStateCapabilities(): Promise<ClientStateCapabilities> {
  listenForReconnects();
  const current = generation;
  if (
    cached &&
    cached.generation === current &&
    (Object.values(cached.value).some(Boolean) ||
      Date.now() - cached.checkedAt < UNSUPPORTED_RECHECK_MS)
  ) {
    return cached.value;
  }
  if (request?.generation === current) return request.promise;
  const promise = getClientStateCapabilities().then(
    (value) => {
      if (current === generation) cached = { generation: current, value, checkedAt: Date.now() };
      return value;
    },
    (error: unknown) => {
      if (isUnknownViewCommandError(error, CLIENT_STATE_CAPABILITIES_COMMAND)) {
        const value = { ...NO_CLIENT_STATE_CAPABILITIES };
        if (current === generation) cached = { generation: current, value, checkedAt: Date.now() };
        return value;
      }
      throw error;
    },
  );
  const entry = { generation: current, promise };
  request = entry;
  try {
    return await promise;
  } finally {
    if (request === entry) request = null;
  }
}

export function resetClientStateCapabilitiesForTests(value?: ClientStateCapabilities): void {
  generation += 1;
  request = null;
  cached = value ? { generation, value, checkedAt: Date.now() } : null;
}
