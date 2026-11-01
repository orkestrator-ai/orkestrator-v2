/**
 * Building and retiring "Continue in…" handoffs.
 *
 * The renderer used to build a handoff from whatever window of messages it had
 * loaded and decide which stored ones were still needed from its own copy of
 * the layout. Both belong to the backend, which holds the whole transcript, the
 * change measurements and the authoritative layout. The snapshot format and
 * carrier live in `@orkestrator/protocol/agent-handoff`; delivery at first
 * dispatch is in `native-agent-handoffs.ts`.
 */
import {
  AGENT_HANDOFF_CHANGE_SUMMARY_CHARACTERS,
  AGENT_HANDOFF_MAX_CHANGE_SUMMARIES,
  AGENT_HANDOFF_VERSION,
  collectAgentHandoffToolCallIds,
  composeAgentHandoffTransferMessages,
  createAgentHandoffSnapshot,
  isAgentHandoffProvider,
  parseAgentHandoffSnapshot,
  sanitizeAgentHandoffMessage,
  type AgentHandoffMessage,
  type AgentHandoffProvider,
} from "@orkestrator/protocol/agent-handoff";
import type { ChangeTrackingService } from "./change-tracking/index.js";
import type { CommandContext } from "./commands-context.js";
import type { PersistedAgentHandoff, PersistedPaneLayout } from "./models.js";
import {
  AGENT_HANDOFF_PRUNE_GRACE_MS,
  paneLayoutAgentHandoffIds,
} from "./storage-shared-pane-layout.js";
import type { StorageService } from "./storage.js";

/** What this backend does with handoffs on its own; a renderer does the rest. */
export const AGENT_HANDOFF_CAPABILITIES = {
  create: true,
  delivery: true,
  pruning: true,
} as const;

export interface CreateAgentHandoffInput {
  handoffId: string;
  environmentId: string;
  sourceAgent: AgentHandoffProvider;
  logicalSessionKey: string;
  sourceSessionId: string;
  destinationProvider: AgentHandoffProvider;
  priorHandoffId?: string;
  sourceTitle?: string;
  sourceModel?: string;
}

/** Provider-reported rows that are local notices rather than conversation. */
function isLocalOnlyRow(message: AgentHandoffMessage): boolean {
  return message.id.startsWith("error-") || message.id.startsWith("system-");
}

const CHANGE_SUMMARY_BATCH = 200;

/**
 * Backend-serialized change text per tool call id. Every number in it comes
 * from the selected measurements, with scope, provenance and quality; a call
 * without a measurement is simply absent and the carrier says "not measured".
 * The newest calls best describe the state being handed off.
 */
export function agentHandoffChangeSummaries(
  tracking: ChangeTrackingService,
  scope: { environmentId: string; provider: string; conversationId: string },
  messages: readonly AgentHandoffMessage[],
): Record<string, string> {
  const callIds = collectAgentHandoffToolCallIds(messages).slice(
    -AGENT_HANDOFF_MAX_CHANGE_SUMMARIES,
  );
  const summaries: Record<string, string> = {};
  for (let index = 0; index < callIds.length; index += CHANGE_SUMMARY_BATCH) {
    const slice = callIds.slice(index, index + CHANGE_SUMMARY_BATCH);
    const { presentations, projections } = tracking.getToolPresentations({
      ...scope,
      callIds: slice,
    });
    for (const callId of slice) {
      const presentation = presentations[callId];
      if (!presentation) continue;
      // Payload, effect and observation stay separate measurements; the
      // serializer labels each. Primary first, as a transcript row shows them.
      const ordered = [...presentation.changes].sort(
        (a, b) => Number(b.prominence === "primary") - Number(a.prominence === "primary"),
      );
      const ids = [
        ...new Set(
          ordered.flatMap((change) => projections[change.resourceKey]?.measurementId ?? []),
        ),
      ];
      if (ids.length === 0) continue;
      const { text } = tracking.handoff.serialize(ids, AGENT_HANDOFF_CHANGE_SUMMARY_CHARACTERS);
      if (text.trim()) summaries[callId] = text;
    }
  }
  return summaries;
}

/**
 * Builds a handoff from the source session's full transcript and stores it.
 *
 * Idempotent on `handoffId`: handoffs are immutable, so a retry whose first
 * attempt committed gets that record instead of a second snapshot of a
 * conversation that has since moved.
 */
export async function createAgentHandoff(
  context: Pick<CommandContext, "storage" | "nativeAgents" | "runtime">,
  input: CreateAgentHandoffInput,
): Promise<PersistedAgentHandoff> {
  const { storage, nativeAgents } = context;
  if (!nativeAgents) throw new Error("Native agent service is unavailable");
  if (input.sourceAgent === input.destinationProvider) {
    throw new Error("A conversation cannot be continued in the agent already running it");
  }
  const existing = await storage.getAgentHandoff(input.handoffId);
  if (existing) {
    if (existing.environmentId !== input.environmentId) {
      throw new Error("Agent handoff belongs to another environment");
    }
    return existing;
  }
  const prior = input.priorHandoffId ? await storage.getAgentHandoff(input.priorHandoffId) : null;
  if (input.priorHandoffId && !prior) {
    throw new Error("The previous conversation transfer could not be loaded");
  }
  const priorSnapshot = prior ? parseAgentHandoffSnapshot(prior.snapshot) : null;
  if (prior && !priorSnapshot) {
    throw new Error("The previous conversation transfer could not be loaded");
  }
  if (
    priorSnapshot &&
    (prior?.environmentId !== input.environmentId ||
      priorSnapshot.environmentId !== input.environmentId ||
      priorSnapshot.destinationProvider !== input.sourceAgent)
  ) {
    throw new Error("The previous conversation transfer does not belong to this session");
  }
  const transcript = await nativeAgents.handoffs.readSourceTranscript({
    environmentId: input.environmentId,
    agent: input.sourceAgent,
    logicalSessionKey: input.logicalSessionKey,
    expectedProviderSessionId: input.sourceSessionId,
  });
  const now = new Date().toISOString();
  const providerMessages = transcript.messages.flatMap((row) => {
    const message = sanitizeAgentHandoffMessage(row, now);
    return message ? [message] : [];
  });
  const messages = composeAgentHandoffTransferMessages(
    priorSnapshot,
    providerMessages,
    isLocalOnlyRow,
  );
  if (messages.length === 0) throw new Error("This conversation has no history to transfer");

  let changeSummaries: Record<string, string> = {};
  const tracking = context.runtime.changeTracking;
  if (tracking) {
    try {
      changeSummaries = agentHandoffChangeSummaries(
        tracking,
        {
          environmentId: input.environmentId,
          provider: input.sourceAgent,
          conversationId: input.sourceSessionId,
        },
        messages,
      );
    } catch (error) {
      // A measurement failure costs the numbers, not the transfer: unmeasured
      // calls say so in the carrier.
      console.warn(
        "[agent-handoffs] Reading change summaries failed:",
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }
  const snapshot = createAgentHandoffSnapshot({
    id: input.handoffId,
    environmentId: input.environmentId,
    sourceProvider: input.sourceAgent,
    destinationProvider: input.destinationProvider,
    sourceSessionId: input.sourceSessionId,
    ...(input.sourceTitle ? { sourceTitle: input.sourceTitle } : {}),
    ...(input.sourceModel ? { sourceModel: input.sourceModel } : {}),
    messages,
    changeSummaries,
    now,
  });
  return storage.saveAgentHandoff(input.handoffId, input.environmentId, AGENT_HANDOFF_VERSION, {
    ...snapshot,
  });
}

/** Parses the renderer's request; platforms are checked against the shared table. */
export function parseCreateAgentHandoffInput(
  args: Record<string, unknown>,
): CreateAgentHandoffInput {
  const text = (value: unknown, name: string, max = 4_096): string => {
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      throw new Error(`Expected ${name} to be a non-empty string`);
    }
    return value;
  };
  const optional = (value: unknown, name: string): string | undefined =>
    value === undefined || value === null || value === "" ? undefined : text(value, name);
  const { sourceAgent, destinationProvider } = args;
  if (!isAgentHandoffProvider(sourceAgent) || !isAgentHandoffProvider(destinationProvider)) {
    throw new Error("Agent handoff provider is invalid");
  }
  const priorHandoffId = optional(args.priorHandoffId, "priorHandoffId");
  const sourceTitle = optional(args.sourceTitle, "sourceTitle");
  const sourceModel = optional(args.sourceModel, "sourceModel");
  return {
    handoffId: text(args.handoffId, "handoffId", 512),
    environmentId: text(args.environmentId, "environmentId"),
    sourceAgent,
    logicalSessionKey: text(args.logicalSessionKey, "logicalSessionKey"),
    sourceSessionId: text(args.sourceSessionId, "sourceSessionId"),
    destinationProvider,
    ...(priorHandoffId ? { priorHandoffId } : {}),
    ...(sourceTitle ? { sourceTitle } : {}),
    ...(sourceModel ? { sourceModel } : {}),
  };
}

const lastSweepAt = new WeakMap<object, number>();

/**
 * Reclaims every stored handoff no layout references, past its grace window.
 *
 * The prune that follows a layout write only runs when that write dropped a
 * reference, so it cannot reach a handoff still inside its grace window, one
 * whose destination tab was never saved (a client lost between the two), or a
 * reference a crash left behind. The caller runs every minute, but the store
 * holds whole transcripts and nothing can come due faster than the grace window,
 * so it does the work at most that often.
 */
export async function sweepAgentHandoffs(
  storage: Pick<StorageService, "agentHandoffs">,
  layouts: Readonly<Record<string, Pick<PersistedPaneLayout, "root">>>,
  now = Date.now(),
): Promise<number> {
  const lastSweep = lastSweepAt.get(storage.agentHandoffs);
  if (lastSweep !== undefined && now - lastSweep < AGENT_HANDOFF_PRUNE_GRACE_MS) return 0;
  lastSweepAt.set(storage.agentHandoffs, now);
  let removed = 0;
  for (const environmentId of await storage.agentHandoffs.agentHandoffEnvironmentIds()) {
    const referenced = paneLayoutAgentHandoffIds(layouts[environmentId]?.root);
    const removedIds = await storage.agentHandoffs.pruneAgentHandoffs(
      environmentId,
      [...referenced],
      { graceMs: AGENT_HANDOFF_PRUNE_GRACE_MS, now },
    );
    removed += removedIds.length;
  }
  return removed;
}
