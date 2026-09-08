import type {
  NativeAgentComposerState,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import type { ProviderRuntimeHealth } from "./agent-provider-contract.js";
import {
  INTERACTIVE_RUNTIME_METADATA_RETRY_MS,
  INTERACTIVE_RUNTIME_METADATA_TTL_MS,
  MAX_TRACKED_INTERACTION_SESSIONS,
  setBoundedMapEntry,
} from "./agent-provider-runtime.js";

export interface HttpBridgeRuntimeMetadata {
  expiresAt: number;
  executionProfiles?: NativeAgentComposerState["executionProfiles"];
  runtime?: NativeAgentRuntimeSummary;
  runtimeHealthAuthoritative?: boolean;
}

export function refreshHttpBridgeRuntimeMetadata(options: {
  sessionId: string;
  metadata: Map<string, HttpBridgeRuntimeMetadata>;
  refreshes: Map<string, Promise<void>>;
  generation: number;
  currentGeneration: () => number;
  read: () => Promise<ProviderRuntimeHealth>;
}): Promise<void> {
  const pending = options.refreshes.get(options.sessionId);
  if (pending) return pending;
  const retained = options.metadata.get(options.sessionId);
  const operation = (async () => {
    try {
      const { summary: runtime, authoritative } = await options.read();
      if (options.generation !== options.currentGeneration()) return;
      if (authoritative === false) {
        if (retained && options.metadata.get(options.sessionId) === retained) {
          retained.expiresAt = Date.now() + INTERACTIVE_RUNTIME_METADATA_RETRY_MS;
          retained.runtimeHealthAuthoritative = false;
        }
        return;
      }
      setBoundedMapEntry(
        options.metadata,
        options.sessionId,
        {
          expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
          ...(retained?.executionProfiles && {
            executionProfiles: retained.executionProfiles,
          }),
          runtime: {
            ...retained?.runtime,
            ...runtime,
            // An authoritative empty list retires cached recovered conditions.
            notices: runtime.notices ?? [],
          },
          runtimeHealthAuthoritative: true,
        },
        MAX_TRACKED_INTERACTION_SESSIONS,
      );
    } catch {
      if (
        options.generation === options.currentGeneration() &&
        retained &&
        options.metadata.get(options.sessionId) === retained
      ) {
        retained.expiresAt = Date.now() + INTERACTIVE_RUNTIME_METADATA_RETRY_MS;
        retained.runtimeHealthAuthoritative = false;
      }
    }
  })();
  options.refreshes.set(options.sessionId, operation);
  return operation.finally(() => {
    if (options.refreshes.get(options.sessionId) === operation) {
      options.refreshes.delete(options.sessionId);
    }
  });
}
