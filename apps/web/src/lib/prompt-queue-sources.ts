import { getEnvironmentIdFromSessionKey } from "@/lib/utils";
import {
  applyPromptQueueSnapshot,
  claimPromptQueueHead,
  promptQueueKey,
  type ClaimedPrompt,
  type PromptQueueSource,
  type QueuedItem,
} from "@/lib/prompt-queue-persistence";
import {
  awaitComposeDraftWrites,
  composeDraftKey,
  recordComposeDraftRevision,
} from "@/lib/compose-draft-persistence";
import {
  composerOccupiedError,
  isComposeDraftOccupiedBackendError,
} from "@/lib/prompt-queue-errors";
import * as backend from "@/lib/backend";
import { useClaudeStore } from "@/stores/claudeStore";
import {
  getEnvironmentIdFromClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";

/**
 * Adapts each agent store to backend-owned prompt-queue snapshots.
 *
 * All four agents already expose the same queue shape (an ordered list of
 * messages with stable ids, keyed by tab); they differ only in how their key
 * encodes the environment. The stores are renderer projections only; mutation
 * helpers below always call the backend before installing a new snapshot.
 */

type AnyQueueStore = {
  getState: () => {
    messageQueue: Map<string, { id: string }[]>;
  };
  setState: (partial: { messageQueue: Map<string, { id: string }[]> }) => void;
};

function createSource(
  agent: string,
  store: AnyQueueStore,
  environmentIdFor: (sessionKey: string) => string | null,
): PromptQueueSource {
  return {
    agent,
    getQueues: () => store.getState().messageQueue,
    setQueue: (sessionKey, messages) => {
      const current = store.getState().messageQueue;
      const existing = current.get(sessionKey);
      // Skip identical applications so hydration causes no redundant render.
      if (existing && JSON.stringify(existing) === JSON.stringify(messages)) return;
      const next = new Map(current);
      next.set(sessionKey, messages);
      store.setState({ messageQueue: next });
    },
    environmentIdFor,
  };
}

/**
 * Every agent whose queue is projected. Claude native, Codex and OpenCode share
 * the `env-{id}:{tab}` key; tmux uses its own scoped form.
 */
let sharedSources: PromptQueueSource[] | null = null;

function getSharedSources(): PromptQueueSource[] {
  if (sharedSources) return sharedSources;
  sharedSources = [
    createSource(
      "claude",
      useClaudeStore as unknown as AnyQueueStore,
      getEnvironmentIdFromSessionKey,
    ),
    createSource(
      "codex",
      useCodexStore as unknown as AnyQueueStore,
      getEnvironmentIdFromSessionKey,
    ),
    createSource(
      "opencode",
      useOpenCodeStore as unknown as AnyQueueStore,
      getEnvironmentIdFromSessionKey,
    ),
    createSource(
      "claude-tmux",
      useClaudeTmuxStore as unknown as AnyQueueStore,
      getEnvironmentIdFromClaudeTmuxStateKey,
    ),
  ];
  return sharedSources;
}

export function createPromptQueueSources(): PromptQueueSource[] {
  return [...getSharedSources()];
}

/**
 * Claims one queued prompt for an agent tab. Agent components use this instead
 * of synchronously removing from their renderer store, so no prompt leaves the
 * process until the backend has granted this client ownership.
 */
export async function claimAgentPromptQueueHead<TItem extends QueuedItem>(
  agent: string,
  sessionKey: string,
): Promise<ClaimedPrompt<TItem> | null> {
  const source = getSharedSources().find((candidate) => candidate.agent === agent);
  if (!source) return null;
  return claimPromptQueueHead(
    source as unknown as PromptQueueSource<TItem>,
    sessionKey,
  );
}

function sourceFor<TItem extends QueuedItem>(
  agent: string,
): PromptQueueSource<TItem> | null {
  return (getSharedSources().find((candidate) => candidate.agent === agent)
    ?? null) as PromptQueueSource<TItem> | null;
}

function queueIdentity<TItem extends QueuedItem>(
  source: PromptQueueSource<TItem>,
  sessionKey: string,
): { queueKey: string; environmentId: string } {
  const environmentId = source.environmentIdFor(sessionKey);
  if (!environmentId) {
    throw new Error("Prompt queue session is not scoped to an environment");
  }
  return {
    queueKey: promptQueueKey(source.agent, sessionKey),
    environmentId,
  };
}

export async function enqueueAgentPrompt<TItem extends QueuedItem>(
  agent: string,
  sessionKey: string,
  message: TItem,
): Promise<void> {
  const source = sourceFor<TItem>(agent);
  if (!source) throw new Error(`Unknown prompt queue agent: ${agent}`);
  const identity = queueIdentity(source, sessionKey);
  const queue = await backend.enqueuePromptQueueMessage<TItem>(
    identity.queueKey,
    identity.environmentId,
    message,
  );
  applyPromptQueueSnapshot(source, queue);
}

export async function requeueAgentPrompt<TItem extends QueuedItem>(
  agent: string,
  sessionKey: string,
  message: TItem,
): Promise<void> {
  const source = sourceFor<TItem>(agent);
  if (!source) throw new Error(`Unknown prompt queue agent: ${agent}`);
  const identity = queueIdentity(source, sessionKey);
  const queue = await backend.requeuePromptQueueMessage<TItem>(
    identity.queueKey,
    identity.environmentId,
    message,
  );
  applyPromptQueueSnapshot(source, queue);
}

async function settleAgentPromptClaim<TItem extends QueuedItem>(
  agent: string,
  sessionKey: string,
  claimToken: string,
  settle: (
    queueKey: string,
    environmentId: string,
    claimToken: string,
  ) => Promise<import("@/types").PersistedPromptQueue<TItem> | null>,
): Promise<void> {
  const source = sourceFor<TItem>(agent);
  if (!source) throw new Error(`Unknown prompt queue agent: ${agent}`);
  const identity = queueIdentity(source, sessionKey);
  const queue = await settle(identity.queueKey, identity.environmentId, claimToken);
  if (queue) {
    applyPromptQueueSnapshot(source, queue);
  } else {
    source.setQueue(sessionKey, []);
  }
}

export async function acknowledgeAgentPromptClaim<TItem extends QueuedItem>(
  agent: string,
  sessionKey: string,
  claimToken: string,
): Promise<void> {
  await settleAgentPromptClaim<TItem>(
    agent,
    sessionKey,
    claimToken,
    backend.acknowledgePromptQueueClaim,
  );
}

export async function rejectAgentPromptClaim<TItem extends QueuedItem>(
  agent: string,
  sessionKey: string,
  claimToken: string,
): Promise<void> {
  await settleAgentPromptClaim<TItem>(
    agent,
    sessionKey,
    claimToken,
    backend.rejectPromptQueueClaim,
  );
}

export async function removeAgentPrompt<TItem extends QueuedItem>(
  agent: string,
  sessionKey: string,
  messageId: string,
): Promise<TItem | null> {
  const source = sourceFor<TItem>(agent);
  if (!source) throw new Error(`Unknown prompt queue agent: ${agent}`);
  const identity = queueIdentity(source, sessionKey);
  const result = await backend.removePromptQueueMessage<TItem>(
    identity.queueKey,
    identity.environmentId,
    messageId,
  );
  if (result.queue) {
    applyPromptQueueSnapshot(source, result.queue);
  } else {
    source.setQueue(sessionKey, []);
  }
  return result.removed;
}

export async function transferAgentPromptToComposeDraft<
  TItem extends QueuedItem,
>(
  agent: "claude" | "codex" | "opencode",
  sessionKey: string,
  messageId: string,
): Promise<TItem | null> {
  const source = sourceFor<TItem>(agent);
  if (!source) throw new Error(`Unknown prompt queue agent: ${agent}`);
  const identity = queueIdentity(source, sessionKey);
  const draftKey = composeDraftKey(agent, identity.environmentId, sessionKey);

  // The composer persists its own draft on a debounce. Transferring before those
  // writes settle makes the backend judge the draft slot against a stale record:
  // an unfinished save looks like an occupied composer, and an unfinished delete
  // looks like an empty one.
  await awaitComposeDraftWrites(draftKey);

  let result: Awaited<
    ReturnType<typeof backend.transferPromptQueueMessageToComposeDraft<TItem>>
  >;
  try {
    result = await backend.transferPromptQueueMessageToComposeDraft<TItem>(
      identity.queueKey,
      identity.environmentId,
      messageId,
      draftKey,
      "environment",
      identity.environmentId,
    );
  } catch (error) {
    // The backend never overwrites a draft it did not create. That is a state
    // the user can clear themselves, so it must not surface as an opaque
    // "could not confirm" failure.
    if (isComposeDraftOccupiedBackendError(error)) {
      throw composerOccupiedError({ cause: error });
    }
    throw error;
  }
  if (result.queue) {
    applyPromptQueueSnapshot(source, result.queue);
  } else {
    source.setQueue(sessionKey, []);
  }
  if (result.draft && typeof result.draft.revision === "number") {
    recordComposeDraftRevision(draftKey, result.draft.revision);
  }
  return result.removed;
}

export async function moveAgentPrompt(
  agent: string,
  sessionKey: string,
  messageId: string,
  direction: "up" | "down",
): Promise<void> {
  const source = sourceFor(agent);
  if (!source) throw new Error(`Unknown prompt queue agent: ${agent}`);
  const identity = queueIdentity(source, sessionKey);
  const queue = await backend.movePromptQueueMessage<QueuedItem>(
    identity.queueKey,
    identity.environmentId,
    messageId,
    direction,
  );
  if (queue) applyPromptQueueSnapshot(source, queue);
}
