/**
 * Which title a native session shows, and when the backend chooses one.
 *
 * The projection asks on every read. The answer, in order:
 *
 * 1. a backend title the provider has not accepted yet (a failed push, or a
 *    provider with no title setter: Cursor and Grok). A failed push never
 *    loses the backend title;
 * 2. the provider's own title, unless it is a placeholder ("Agent Session",
 *    Claude's "Session 1a2b3c");
 * 3. a backend title the provider already holds;
 * 4. the first user message, cut short;
 * 5. the provider's placeholder, when there is nothing else.
 *
 * The backend chooses a title once per provider session, when the provider has
 * none of its own and the read reaches the start of the conversation: a model
 * title from {@link SessionTitleGenerator} for interactive and coordinator
 * sessions, the first-message fallback otherwise or when no generator could
 * run. It is stored on the session record, pushed to the provider through
 * `setSessionTitle`, and marked accepted once the push succeeds.
 */
import type { AgentInteractionOrigin } from "@orkestrator/protocol/agent-interactions";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import {
  nativeAgentSessionBackendTitle,
  type NativeAgentSessionBackendTitle,
  type PersistedNativeAgentSession,
} from "./models.js";
import type { SessionTitleGenerator } from "./session-title-service.js";
import { firstMessageSessionTitle, sessionTitleSourceText } from "./session-title-text.js";

/** Origins whose sessions get a model-written title; the rest keep the fallback. */
const GENERATED_TITLE_ORIGINS: ReadonlySet<AgentInteractionOrigin> = new Set([
  "interactive-native",
  "coordinator",
]);

/** How long a failed push waits before the next read may try again. */
export const SESSION_TITLE_PUSH_RETRY_MS = 5 * 60_000;
/** Sessions whose in-memory title state is kept; the oldest goes first. */
export const SESSION_TITLE_STATE_LIMIT = 1_024;

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > SESSION_TITLE_STATE_LIMIT) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** A title the provider sets on every session it creates, which names nothing. */
export function isPlaceholderSessionTitle(agent: BuildPipelineAgent, title: string): boolean {
  // "Agent Session" is the title the native agent service creates every
  // provider session with, and "Session 1a2b3c" is Claude's own; left in place
  // they stay the title in the resume list too.
  return title === "Agent Session" || (agent === "claude" && /^Session [a-f0-9]{6}$/i.test(title));
}

export interface SessionTitleStorage {
  recordNativeAgentSessionBackendTitle(
    key: string,
    title: NativeAgentSessionBackendTitle,
  ): Promise<boolean>;
}

export interface SessionTitleRead {
  sessionKey: string;
  session: Pick<PersistedNativeAgentSession, "providerSessionId" | "backendTitle" | "origin">;
  agent: BuildPipelineAgent;
  /** The provider's own title, as its snapshot reported it. */
  providerTitle?: string;
  /** The first user message this read holds, shown when nothing better exists. */
  firstUserMessage?: string;
  /**
   * The read starts at the beginning of the conversation. Only then is
   * `firstUserMessage` the conversation's first, so only then is a title
   * chosen from it; a window that starts mid-conversation names the wrong
   * thing.
   */
  reachesStart: boolean;
  /** Transient reads (a closed tab's preview) never choose or push a title. */
  transient: boolean;
  setProviderTitle?: (providerSessionId: string, title: string) => Promise<unknown>;
}

export interface NativeAgentSessionTitlesOptions {
  storage: SessionTitleStorage;
  generator?: SessionTitleGenerator;
  /** Called once a chosen title is stored, so cached reads can show it. */
  onTitleChosen?: (sessionKey: string, title: string) => void;
  now?: () => number;
}

export class NativeAgentSessionTitles {
  /** Sessions whose title is being chosen, keyed by session and provider session. */
  private readonly choosing = new Map<string, Promise<void>>();
  /** Titles chosen in this process whose record write may not have landed yet. */
  private readonly chosen = new Map<string, NativeAgentSessionBackendTitle>();
  /** The last push attempt per session, so a failing provider is not asked every read. */
  private readonly pushAttempts = new Map<string, { title: string; at: number }>();
  private readonly now: () => number;

  constructor(private readonly options: NativeAgentSessionTitlesOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The title to show for this read; may start choosing or pushing one. */
  resolve(read: SessionTitleRead): string | undefined {
    const providerSessionId = read.session.providerSessionId;
    const stateKey = `${read.sessionKey}\0${providerSessionId}`;
    const stored = nativeAgentSessionBackendTitle(read.session);
    const pending = this.chosen.get(stateKey);
    const backend =
      pending && (!stored || stored.source === "fallback" || pending.source === stored.source)
        ? {
            ...pending,
            ...(stored?.title === pending.title && stored.pushed ? { pushed: true } : {}),
          }
        : stored;
    const reported = read.providerTitle?.trim();
    const providerTitle =
      reported && !isPlaceholderSessionTitle(read.agent, reported) ? reported : undefined;

    if (backend && !backend.pushed && providerTitle === backend.title) {
      // The provider holds it now, whoever put it there.
      this.recordAccepted(read.sessionKey, stateKey, backend);
    } else if (backend && !backend.pushed && !read.transient) {
      this.push(read, stateKey, backend);
    }
    if (backend && !backend.pushed) return backend.title;
    if (providerTitle) return providerTitle;
    if (backend) return backend.title;

    const fallback = read.firstUserMessage
      ? firstMessageSessionTitle(read.firstUserMessage)
      : undefined;
    if (fallback && read.reachesStart && !read.transient) this.choose(read, stateKey, fallback);
    // A placeholder is still better than no title at all.
    return fallback ?? (reported || undefined);
  }

  /** Forget a session's in-memory state (tab closed, session replaced). */
  forget(sessionKey: string): void {
    const prefix = `${sessionKey}\0`;
    for (const key of Array.from(this.chosen.keys())) {
      if (key.startsWith(prefix)) this.chosen.delete(key);
    }
    this.pushAttempts.delete(sessionKey);
  }

  /** Title choices still in flight, for shutdown to settle. */
  pending(): Promise<void>[] {
    return Array.from(this.choosing.values());
  }

  private choose(read: SessionTitleRead, stateKey: string, fallback: string): void {
    if (this.choosing.has(stateKey) || this.chosen.has(stateKey)) return;
    const providerSessionId = read.session.providerSessionId;
    const source = sessionTitleSourceText(read.firstUserMessage ?? "");
    const generator =
      this.options.generator && GENERATED_TITLE_ORIGINS.has(read.session.origin)
        ? this.options.generator
        : undefined;
    const work = (async () => {
      const generated = generator
        ? await generator.generate({ agent: read.agent, source }).catch(() => null)
        : null;
      const title: NativeAgentSessionBackendTitle = generated
        ? { providerSessionId, title: generated.title, source: "generated" }
        : { providerSessionId, title: fallback, source: "fallback" };
      setBounded(this.chosen, stateKey, title);
      await this.store(read.sessionKey, title);
      this.options.onTitleChosen?.(read.sessionKey, title.title);
      this.push(read, stateKey, title);
    })()
      .catch(() => undefined)
      .finally(() => {
        this.choosing.delete(stateKey);
      });
    this.choosing.set(stateKey, work);
  }

  private push(
    read: SessionTitleRead,
    stateKey: string,
    title: NativeAgentSessionBackendTitle,
  ): void {
    const setProviderTitle = read.setProviderTitle;
    if (!setProviderTitle) return;
    const previous = this.pushAttempts.get(read.sessionKey);
    if (previous?.title === title.title && this.now() - previous.at < SESSION_TITLE_PUSH_RETRY_MS) {
      return;
    }
    setBounded(this.pushAttempts, read.sessionKey, { title: title.title, at: this.now() });
    void Promise.resolve()
      .then(() => setProviderTitle(title.providerSessionId, title.title))
      .then(() => this.recordAccepted(read.sessionKey, stateKey, title))
      .catch(() => undefined);
  }

  private recordAccepted(
    sessionKey: string,
    stateKey: string,
    title: NativeAgentSessionBackendTitle,
  ): void {
    const accepted = { ...title, pushed: true };
    setBounded(this.chosen, stateKey, accepted);
    void this.store(sessionKey, accepted);
  }

  /** Best effort: the in-memory choice still shows if the write fails. */
  private store(sessionKey: string, title: NativeAgentSessionBackendTitle): Promise<boolean> {
    return Promise.resolve()
      .then(() => this.options.storage.recordNativeAgentSessionBackendTitle(sessionKey, title))
      .catch(() => false);
  }
}
