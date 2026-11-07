import {
  applyPromptQueueSnapshot,
  retryPromptQueueDispatch,
  promptQueueKey,
  type PromptQueueSource,
  type QueuedItem,
} from "@/lib/prompt-queue-persistence";
import { backendForScope } from "@/lib/backend/scope-backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import {
  claudeTmuxStore,
  getEnvironmentIdFromClaudeTmuxStateKey,
  type TmuxQueuedMessage,
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

/**
 * Every agent whose queue is projected into a renderer store, for one node
 * (plan item 4007): its own `claudeTmuxStore`, so a leaf's tmux tab sees the
 * leaf's queues. Made once per scope, dropped with it.
 */
const scopeSources = defineScopedSlot("prompt-queue-sources", (scope): PromptQueueSource[] => {
  const tmux = scope.store(claudeTmuxStore);
  return [
    createSource(
      "claude-tmux",
      {
        getState: () => tmux.getState(),
        setState: (partial) =>
          tmux.setState(partial as { messageQueue: Map<string, TmuxQueuedMessage[]> }),
      },
      getEnvironmentIdFromClaudeTmuxStateKey,
    ),
  ];
});

/** `scope`'s queue sources; the app's command scope when omitted (3003's convention). */
export function createPromptQueueSources(
  scope: NodeScope = appCommandScope(),
): PromptQueueSource[] {
  return [...scopeSources(scope)];
}

export async function retryAgentPromptQueueDispatch(
  agent: string,
  sessionKey: string,
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const source = sourceFor(agent, scope);
  if (!source) return;
  await retryPromptQueueDispatch(source, sessionKey, (queueKey) =>
    backendForScope(scope).retryPromptQueueDispatch(queueKey),
  );
}

function sourceFor<TItem extends QueuedItem>(
  agent: string,
  scope: NodeScope,
): PromptQueueSource<TItem> | null {
  return (scopeSources(scope).find((candidate) => candidate.agent === agent) ??
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
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const source = sourceFor<TItem>(agent, scope);
  if (!source) throw new Error(`Unknown prompt queue agent: ${agent}`);
  const identity = queueIdentity(source, sessionKey);
  const queue = await backendForScope(scope).enqueuePromptQueueMessage<TItem>(
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
  scope: NodeScope = appCommandScope(),
): Promise<TItem | null> {
  const source = sourceFor<TItem>(agent, scope);
  if (!source) throw new Error(`Unknown prompt queue agent: ${agent}`);
  const identity = queueIdentity(source, sessionKey);
  const result = await backendForScope(scope).removePromptQueueMessage<TItem>(
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
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const source = sourceFor(agent, scope);
  if (!source) throw new Error(`Unknown prompt queue agent: ${agent}`);
  const identity = queueIdentity(source, sessionKey);
  const queue = await backendForScope(scope).movePromptQueueMessage<QueuedItem>(
    identity.queueKey,
    identity.environmentId,
    messageId,
    direction,
  );
  if (queue) applyPromptQueueSnapshot(source, queue);
}
