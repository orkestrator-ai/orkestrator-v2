/**
 * The read side of an OpenCode 2.x provider: transcript windows and pages,
 * session state, the interactive snapshot, usage and interaction cards
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 4).
 *
 * `OpenCode2Provider` owns one of these and delegates to it, so the
 * provider's dispatch and steer logic and this read side stay apart. The
 * provider's event monitor feeds {@link OpenCode2SessionReads.observe} and
 * the lost-event signals; every answer here is still read from the server.
 */
import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";
import { createLogger } from "@orkestrator/protocol/logger";
import {
  ProviderUnavailableError,
  type ProviderSessionRegistration,
  type ProviderStatus,
  type ProviderTranscriptPage,
  type ProviderTranscriptSnapshot,
} from "../agent-provider-contract.js";
import { asRecord, nonEmptyString } from "../agent-provider-runtime.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import type { OpenCode2Event } from "./events.js";
import { OpenCode2InteractionAdapter } from "./interactions.js";
import {
  hydrateOpenCode2Subagents,
  openCode2SessionState,
  type OpenCode2SessionState,
} from "./session-state.js";
import { normalizeOpenCode2Transcript } from "./transcript.js";
import {
  OPENCODE2_TRANSCRIPT_READ_LIMIT,
  OpenCode2TranscriptState,
  openCode2TranscriptPage,
  openCode2HistoryCursor,
  openCode2TranscriptSnapshot,
  type OpenCode2TranscriptReadOptions,
} from "./transcript-snapshot.js";
import { openCode2RevertMarker } from "./revert.js";
import type { OpenCode2Message } from "./types.js";
import { openCode2ContextUsage } from "./usage.js";

const log = createLogger("native-agent.opencode2");
/** Distinct unknown row kinds reported per provider, so a newer server is noticed once. */
const MAX_REPORTED_UNKNOWN = 32;

/** The session an event is about: its durable aggregate, or the `sessionID` its data names. */
export function openCode2EventSessionId(event: OpenCode2Event): string | undefined {
  return event.durable?.aggregateID ?? nonEmptyString(asRecord(event.data)?.sessionID) ?? undefined;
}

export class OpenCode2SessionReads {
  readonly interactions: OpenCode2InteractionAdapter;
  readonly transcript: OpenCode2TranscriptState;
  private readonly unknown = new Set<string>();

  constructor(
    private readonly client: OpenCode2Client,
    live: () => boolean,
  ) {
    this.interactions = new OpenCode2InteractionAdapter(client, client.directory);
    this.transcript = new OpenCode2TranscriptState(live);
  }

  register(sessionId: string, registration?: ProviderSessionRegistration): void {
    this.interactions.register(sessionId, registration);
  }

  forget(sessionId: string): void {
    this.transcript.forget(sessionId);
  }

  observe(sessionId: string, event: OpenCode2Event): void {
    this.transcript.observe(sessionId, event);
  }

  transcriptSnapshot(
    sessionId: string,
    options: OpenCode2TranscriptReadOptions,
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> {
    return openCode2TranscriptSnapshot(this.client, this.transcript, sessionId, options, (type) =>
      this.recordUnknown(type),
    );
  }

  transcriptPage(
    sessionId: string,
    options: { cursor: string; limit: number; targetBytes: number },
  ): Promise<ProviderTranscriptPage> {
    return openCode2TranscriptPage(this.client, this.transcript, sessionId, options, (type) =>
      this.recordUnknown(type),
    );
  }

  sessionState(sessionId: string, status: ProviderStatus): Promise<OpenCode2SessionState> {
    return openCode2SessionState(this.client, sessionId, status);
  }

  /** State plus the newest rows (normalized, sub-agents hydrated), for `interactiveSnapshot`. */
  async interactive(
    sessionId: string,
    status: ProviderStatus,
  ): Promise<
    OpenCode2SessionState & { messages: Record<string, unknown>[]; messagesComplete: boolean }
  > {
    const rows = await this.newestRows(sessionId, OPENCODE2_TRANSCRIPT_READ_LIMIT + 1);
    const complete = rows.length <= OPENCODE2_TRANSCRIPT_READ_LIMIT;
    const window = rows.slice(-OPENCODE2_TRANSCRIPT_READ_LIMIT);
    const state = await openCode2SessionState(this.client, sessionId, status, window);
    const messages = await hydrateOpenCode2Subagents(
      this.client,
      normalizeOpenCode2Transcript(window, (type) => this.recordUnknown(type)),
    );
    return { ...state, messages, messagesComplete: complete };
  }

  /** Lifetime usage from the session, plus the newest response's context occupancy. */
  async usage(sessionId: string): Promise<NativeAgentContextUsage | undefined> {
    try {
      const [session, page] = await Promise.all([
        this.client.getSession(sessionId),
        this.client.listMessages(sessionId, { limit: 1, order: "desc", type: "assistant" }),
      ]);
      return openCode2ContextUsage(session, page.messages);
    } catch (error) {
      if (error instanceof OpenCode2RequestError && error.status === 404) return undefined;
      throw new ProviderUnavailableError("OpenCode 2 usage is unavailable", { cause: error });
    }
  }

  /** Oldest first. */
  private async newestRows(sessionId: string, limit: number): Promise<OpenCode2Message[]> {
    try {
      const session = await this.client.getSession(sessionId);
      const revert = openCode2RevertMarker(session);
      this.transcript.syncRevert(sessionId, revert?.messageId);
      const page = await this.client.listMessages(sessionId, {
        limit,
        order: "desc",
        ...(revert ? { cursor: openCode2HistoryCursor(revert.messageId) } : {}),
      });
      return [...page.messages].reverse();
    } catch (error) {
      if (error instanceof OpenCode2RequestError && error.status === 404) return [];
      throw new ProviderUnavailableError("OpenCode 2 transcript is unavailable", { cause: error });
    }
  }

  private recordUnknown(type: string): void {
    if (this.unknown.has(type) || this.unknown.size >= MAX_REPORTED_UNKNOWN) return;
    this.unknown.add(type);
    // The kind name only: content-free.
    log.info("transcript.unknown-row", { kind: type.slice(0, 64) });
  }
}
