import type { NativeMessage } from "@/lib/chat/native-message-types";
import { isClientOnlyNativeMessage } from "@/lib/chat/client-only-messages";
import * as backend from "@/lib/backend";
import {
  AGENT_HANDOFF_PROVIDER_LABELS,
  AGENT_HANDOFF_VERSION,
  createAgentHandoffSnapshot as createProtocolAgentHandoffSnapshot,
  isAgentHandoffBootstrapMessage as protocolIsAgentHandoffBootstrapMessage,
  parseAgentHandoffSnapshot as parseProtocolAgentHandoffSnapshot,
  stripAgentHandoffCarriers as stripProtocolAgentHandoffCarriers,
  type AgentHandoffProvider,
  type AgentHandoffSnapshot as ProtocolAgentHandoffSnapshot,
  type CreateAgentHandoffOptions,
} from "@orkestrator/protocol/agent-handoff";
import type { PersistedAgentHandoff } from "@/types";

/*
 * The renderer side of "Continue in…".
 *
 * The backend builds every handoff from the source session's full transcript
 * (`create_agent_handoff`), prepends it to the destination's first prompt at
 * dispatch, and prunes it once no tab references it. What stays here is
 * presentation: loading and caching the snapshot, rendering the imported
 * history, and hiding the carrier the destination's first message contains.
 * The frame, budget and validation live in `@orkestrator/protocol/agent-handoff`.
 */

export {
  AGENT_HANDOFF_PROMPT_BUDGET,
  AGENT_HANDOFF_SNAPSHOT_BUDGET,
  AGENT_HANDOFF_VERSION,
  prependAgentHandoffHistory,
} from "@orkestrator/protocol/agent-handoff";

export type AgentProvider = AgentHandoffProvider;
export const AGENT_PROVIDER_LABELS = AGENT_HANDOFF_PROVIDER_LABELS;
export type AgentHandoffSnapshot = ProtocolAgentHandoffSnapshot<NativeMessage>;

/**
 * Builds a snapshot from messages already in hand. Production handoffs are
 * built by the backend; this stays for fixtures and tests.
 */
export function createAgentHandoffSnapshot(
  options: CreateAgentHandoffOptions<NativeMessage>,
): AgentHandoffSnapshot {
  return createProtocolAgentHandoffSnapshot(options);
}

/**
 * Validates a persisted snapshot and rebuilds its carrier from the validated
 * fields. Rows are checked against the handoff's structural message shape,
 * which every neutral native message satisfies.
 */
export function parseAgentHandoffSnapshot(value: unknown): AgentHandoffSnapshot | null {
  return parseProtocolAgentHandoffSnapshot(value) as AgentHandoffSnapshot | null;
}

export function isAgentHandoffBootstrapMessage(
  message: Pick<NativeMessage, "content" | "parts">,
  handoffId: string,
): boolean {
  return protocolIsAgentHandoffBootstrapMessage(message, handoffId);
}

/**
 * Removes every bootstrap carrier this tab is known to have dispatched.
 *
 * Local error, system and optimistic rows may precede the provider's first
 * message, which is the only one a carrier can be stripped from.
 * `handoffIds` includes ids whose snapshot has already been deleted: after a
 * resume, the imported transcript is gone but the prompt that carried it is
 * still the destination session's first message.
 */
export function stripAgentHandoffCarriers(
  handoffIds: readonly string[],
  providerMessages: NativeMessage[],
): NativeMessage[] {
  return stripProtocolAgentHandoffCarriers(handoffIds, providerMessages, isClientOnlyNativeMessage);
}

function prefixImportedMessage(handoffId: string, message: NativeMessage): NativeMessage {
  return {
    ...message,
    id: `handoff:${handoffId}:source:${message.id}`,
    turnId: undefined,
  };
}

/**
 * The imported transcript and its boundary, derived from the snapshot alone.
 *
 * Separated from the merge so callers can memoize on `handoff` identity: these
 * objects are re-created for every imported message, and recomputing them on
 * each streaming tick re-renders the entire imported history.
 */
export function buildAgentHandoffImportedMessages(handoff: AgentHandoffSnapshot): NativeMessage[] {
  const sourceLabel = AGENT_PROVIDER_LABELS[handoff.sourceProvider];
  const destinationLabel = AGENT_PROVIDER_LABELS[handoff.destinationProvider];
  const boundaryText =
    `Continued in ${destinationLabel} from ${sourceLabel}` +
    ` · ${handoff.stats.messageCount} messages` +
    ` · ${handoff.stats.toolCallCount} tool calls`;
  return [
    ...handoff.messages.map((message) => prefixImportedMessage(handoff.id, message)),
    {
      id: `handoff:${handoff.id}:boundary`,
      role: "system",
      content: boundaryText,
      parts: [{ type: "text", content: boundaryText }],
      createdAt: handoff.createdAt,
    },
  ];
}

export function mergeAgentHandoffDisplayMessages(
  handoff: AgentHandoffSnapshot | null,
  providerMessages: NativeMessage[],
): NativeMessage[] {
  if (!handoff) return providerMessages;
  return [
    ...buildAgentHandoffImportedMessages(handoff),
    ...stripAgentHandoffCarriers([handoff.id], providerMessages),
  ];
}

const handoffCache = new Map<string, AgentHandoffSnapshot | null>();
const handoffLoads = new Map<string, Promise<AgentHandoffSnapshot | null>>();
const handoffLoadEpochs = new Map<string, number>();
let handoffCacheGeneration = 0;

export function rememberAgentHandoff(handoff: AgentHandoffSnapshot): void {
  handoffCache.set(handoff.id, handoff);
}

/**
 * Evicts one handoff without allowing an older in-flight read to repopulate it.
 * A later explicit load starts a fresh backend request.
 */
export function forgetAgentHandoff(handoffId: string): void {
  handoffCache.delete(handoffId);
  handoffLoads.delete(handoffId);
  handoffLoadEpochs.set(handoffId, (handoffLoadEpochs.get(handoffId) ?? 0) + 1);
}

export function resetAgentHandoffCache(): void {
  handoffCacheGeneration += 1;
  handoffCache.clear();
  handoffLoads.clear();
  handoffLoadEpochs.clear();
}

/** The snapshot inside a stored record, or null when the record is not this handoff's. */
function snapshotFromRecord(
  handoffId: string,
  record: PersistedAgentHandoff | null | undefined,
): AgentHandoffSnapshot | null {
  const candidate =
    record && record.id === handoffId && record.version === AGENT_HANDOFF_VERSION
      ? parseAgentHandoffSnapshot(record.snapshot)
      : null;
  return candidate &&
    candidate.id === handoffId &&
    candidate.environmentId === record?.environmentId
    ? candidate
    : null;
}

export async function loadAgentHandoff(handoffId: string): Promise<AgentHandoffSnapshot | null> {
  if (handoffCache.has(handoffId)) return handoffCache.get(handoffId) ?? null;
  const existing = handoffLoads.get(handoffId);
  if (existing) return existing;
  const generation = handoffCacheGeneration;
  const epoch = handoffLoadEpochs.get(handoffId) ?? 0;
  const request = backend.getAgentHandoff(handoffId).then((record) => {
    const parsed = snapshotFromRecord(handoffId, record);
    if (
      generation === handoffCacheGeneration &&
      epoch === (handoffLoadEpochs.get(handoffId) ?? 0)
    ) {
      handoffCache.set(handoffId, parsed);
      return parsed;
    }
    // The handoff was forgotten or the whole cache was reset while this read
    // was in flight. Suppress the obsolete value for both cache and caller.
    return null;
  });
  let pending: Promise<AgentHandoffSnapshot | null>;
  pending = request.finally(() => {
    if (handoffLoads.get(handoffId) === pending) {
      handoffLoads.delete(handoffId);
    }
  });
  handoffLoads.set(handoffId, pending);
  return pending;
}

/**
 * Asks the backend to build and store a handoff from the source session's
 * full transcript, then caches the committed snapshot.
 *
 * Handoffs are immutable server-side: a retry with the same id returns the
 * committed record. A record that is not the one asked for is refused rather
 * than cached, so memory and disk cannot silently disagree. A backend that
 * predates the command cannot build one, and says why rather than failing with
 * a bare command name.
 */
export async function createAgentHandoff(
  input: backend.CreateAgentHandoffInput,
): Promise<AgentHandoffSnapshot> {
  const record = await backend.createAgentHandoff(input).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unknown backend command")) {
      throw new Error(
        "Continuing in another agent needs a newer Orkestrator backend. Update this machine and try again.",
      );
    }
    throw error;
  });
  const snapshot = snapshotFromRecord(input.handoffId, record);
  if (
    !snapshot ||
    record.environmentId !== input.environmentId ||
    snapshot.destinationProvider !== input.destinationProvider
  ) {
    throw new Error("The conversation transfer was not stored as written");
  }
  rememberAgentHandoff(snapshot);
  return snapshot;
}
