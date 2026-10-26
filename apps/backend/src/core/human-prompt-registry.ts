import type {
  HumanPrompt,
  HumanPromptEntry,
  HumanPromptSource,
} from "@orkestrator/protocol/human-prompts";

/**
 * Every shell prompt currently waiting on the user, across the backend.
 *
 * One place, fed by every detector (user `!` commands, agent tool output,
 * agent background tasks) and read by every surface (the tab's banner, the
 * coordinator's worker chip, the coordinator's wake). In memory on purpose: a
 * prompt belongs to a live process, and a restart ends the user commands and
 * re-observes agent output, so there is nothing to restore.
 *
 * Holds URLs and codes the user must see. Never log entries.
 */

export type HumanPromptChange =
  | { type: "set"; entry: HumanPromptEntry; previous?: HumanPromptEntry }
  | { type: "cleared"; entry: HumanPromptEntry };

const MAX_ENTRIES = 512;

export class HumanPromptRegistry {
  private readonly entries = new Map<string, HumanPromptEntry>();
  private readonly listeners = new Set<(change: HumanPromptChange) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  private static key(environmentId: string, id: string): string {
    return `${environmentId}\u0000${id}`;
  }

  subscribe(listener: (change: HumanPromptChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Record (or replace) the prompt one source is waiting on. Setting the same
   * prompt again is a no-op, so a redrawn prompt is announced once.
   */
  set(input: {
    id: string;
    environmentId: string;
    tabId: string;
    source: HumanPromptSource;
    prompt: HumanPrompt;
    userCommandId?: string;
    command?: string;
  }): HumanPromptEntry {
    const key = HumanPromptRegistry.key(input.environmentId, input.id);
    const previous = this.entries.get(key);
    if (previous && previous.prompt.key === input.prompt.key) return previous;
    const entry: HumanPromptEntry = {
      id: input.id,
      environmentId: input.environmentId,
      tabId: input.tabId,
      source: input.source,
      ...(input.userCommandId ? { userCommandId: input.userCommandId } : {}),
      ...(input.command ? { command: input.command.slice(0, 500) } : {}),
      prompt: input.prompt,
      since: previous?.since ?? new Date(this.now()).toISOString(),
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const dropped = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (dropped) this.notify({ type: "cleared", entry: dropped });
    }
    this.notify({ type: "set", entry, ...(previous ? { previous } : {}) });
    return entry;
  }

  /** The source exited or moved on. */
  clear(environmentId: string, id: string): void {
    const key = HumanPromptRegistry.key(environmentId, id);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.notify({ type: "cleared", entry });
  }

  /** Clear every entry of one tab that `keep` does not return true for. */
  clearTab(
    environmentId: string,
    tabId: string,
    keep: (entry: HumanPromptEntry) => boolean = () => false,
  ): void {
    for (const entry of Array.from(this.entries.values())) {
      if (entry.environmentId === environmentId && entry.tabId === tabId && !keep(entry)) {
        this.clear(environmentId, entry.id);
      }
    }
  }

  clearEnvironment(environmentId: string): void {
    for (const entry of Array.from(this.entries.values())) {
      if (entry.environmentId === environmentId) this.clear(environmentId, entry.id);
    }
  }

  list(filter: { environmentIds?: readonly string[]; tabId?: string } = {}): HumanPromptEntry[] {
    const environments = filter.environmentIds ? new Set(filter.environmentIds) : null;
    return Array.from(this.entries.values()).filter(
      (entry) =>
        (!environments || environments.has(entry.environmentId)) &&
        (!filter.tabId || entry.tabId === filter.tabId),
    );
  }

  /** Whether anything in this environment (any tab) is waiting on the user. */
  hasEnvironmentPrompt(environmentId: string): boolean {
    for (const entry of this.entries.values())
      if (entry.environmentId === environmentId) return true;
    return false;
  }

  private notify(change: HumanPromptChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        console.warn(
          "[human-prompts] Listener failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
