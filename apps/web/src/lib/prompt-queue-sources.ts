import { getEnvironmentIdFromSessionKey } from "@/lib/utils";
import {
  claimPromptQueueHead,
  type PromptQueueSource,
  type QueuedItem,
} from "@/lib/prompt-queue-persistence";
import { useClaudeStore } from "@/stores/claudeStore";
import {
  getEnvironmentIdFromClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";

/**
 * Adapts each agent store to the shared prompt-queue mirror.
 *
 * All four agents already expose the same queue shape (an ordered list of
 * messages with stable ids, keyed by tab); they differ only in how their key
 * encodes the environment. Adapting rather than unifying keeps the mirror out
 * of the stores themselves, so the UI keeps reading its own store and stays
 * optimistic.
 */

type AnyQueueStore = {
  getState: () => {
    messageQueue: Map<string, { id: string }[]>;
  };
  setState: (partial: { messageQueue: Map<string, { id: string }[]> }) => void;
  subscribe: (listener: () => void) => () => void;
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
      // Skip identical applications so a hydrate cannot loop back through the
      // subscriber as a fresh change.
      if (existing && JSON.stringify(existing) === JSON.stringify(messages)) return;
      const next = new Map(current);
      next.set(sessionKey, messages);
      store.setState({ messageQueue: next });
    },
    subscribe: (listener) => store.subscribe(listener),
    environmentIdFor,
  };
}

/**
 * Every agent whose queue is mirrored. Claude native, Codex and OpenCode share
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
): Promise<TItem | null> {
  const source = getSharedSources().find((candidate) => candidate.agent === agent);
  if (!source) return null;
  return claimPromptQueueHead(
    source as unknown as PromptQueueSource<TItem>,
    sessionKey,
  );
}
