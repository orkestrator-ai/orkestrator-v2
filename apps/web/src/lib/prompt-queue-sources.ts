import {
  applyPromptQueueSnapshot,
  retryPromptQueueDispatch,
  promptQueueKey,
  type PromptQueueSource,
  type QueuedItem,
} from "@/lib/prompt-queue-persistence";
import * as backend from "@/lib/backend";
import {
  getEnvironmentIdFromClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";

/**
 * Adapts renderer agent stores to backend-owned prompt-queue snapshots.
 *
 * Only Claude Tmux keeps a renderer queue projection. Native agents (Claude,
 * Codex, OpenCode and the rest) are queued and drained by the backend and
 * render their queue from the native-agent projection, so they have no source
 * here. The store is a projection only; mutation helpers below always call the
 * backend before installing a new snapshot.
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

/** Every agent whose queue is projected into a renderer store. */
let sharedSources: PromptQueueSource[] | null = null;

function getSharedSources(): PromptQueueSource[] {
  if (sharedSources) return sharedSources;
  sharedSources = [
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

export async function retryAgentPromptQueueDispatch(
  agent: string,
  sessionKey: string,
): Promise<void> {
  const source = getSharedSources().find((candidate) => candidate.agent === agent);
  if (!source) return;
  await retryPromptQueueDispatch(source, sessionKey);
}

function sourceFor<TItem extends QueuedItem>(agent: string): PromptQueueSource<TItem> | null {
  return (getSharedSources().find((candidate) => candidate.agent === agent) ??
    null) as PromptQueueSource<TItem> | null;
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
