import type { AgentMailMessage } from "@orkestrator/protocol/agent-mail";

/**
 * Bounded state behind the agent mail store's keyed reads
 * (`AgentMailStore.mailbox`, `environmentMailboxes`, `messageStatus`): the
 * rows those reads parsed, and where each message was last seen. Both are
 * caches. A parsed row is reused only while its serialized value is unchanged,
 * and a location is only a hint that the reader verifies against the row it
 * names, so neither can make a read return anything the committed store does
 * not hold.
 */

/** Parsed rows kept for keyed reads, besides the whole read model's. */
export const AGENT_MAIL_KEYED_ROW_CACHE_MAX_ROWS = 512;
/** Serialized length (UTF-16 code units) of the rows kept for keyed reads. */
export const AGENT_MAIL_KEYED_ROW_CACHE_MAX_LENGTH = 8 * 1024 * 1024;
/**
 * Message locations kept, oldest seen evicted first. The store can retain
 * more messages than this (2,000 mailboxes of 200); a message whose location
 * was evicted is found by the whole-store read instead.
 */
export const AGENT_MAIL_MESSAGE_LOCATION_MAX = 50_000;

export type AgentMailRowCollection = "mailboxes" | "idempotency" | "counterparts";

/** A parsed row and the serialized value it came from. */
export type ParsedMailRow = { value: string; parsed: unknown };

/**
 * Where a message id was last seen: a mailbox row's key, or the idempotency
 * row whose bounce it is.
 */
export type AgentMailMessageLocation = { collection: "mailboxes" | "idempotency"; key: string };

export function mailRowId(collection: string, key: string): string {
  return `${collection}\u0000${key}`;
}

export class AgentMailKeyedRows {
  /** In least-recently-used order: the first entry is evicted first. */
  private readonly rows = new Map<string, ParsedMailRow>();
  private length = 0;
  private readonly locations = new Map<string, AgentMailMessageLocation>();

  /** The parsed row cached for `id`, when its serialized value is `value`. */
  cached(id: string, value: string): unknown {
    const row = this.rows.get(id);
    if (!row || row.value !== value) return undefined;
    this.rows.delete(id);
    this.rows.set(id, row);
    return row.parsed;
  }

  remember(id: string, row: ParsedMailRow): void {
    const previous = this.rows.get(id);
    if (previous) {
      this.rows.delete(id);
      this.length -= previous.value.length;
    }
    // A row larger than the whole budget is parsed per read rather than kept.
    if (row.value.length > AGENT_MAIL_KEYED_ROW_CACHE_MAX_LENGTH) return;
    this.rows.set(id, row);
    this.length += row.value.length;
    for (const [oldest, kept] of this.rows) {
      if (
        this.rows.size <= AGENT_MAIL_KEYED_ROW_CACHE_MAX_ROWS &&
        this.length <= AGENT_MAIL_KEYED_ROW_CACHE_MAX_LENGTH
      ) {
        break;
      }
      this.rows.delete(oldest);
      this.length -= kept.value.length;
    }
  }

  locate(messageId: string): AgentMailMessageLocation | undefined {
    return this.locations.get(messageId);
  }

  /** Records where the messages a parsed (or about to be written) row holds live. */
  index(collection: AgentMailRowCollection, key: string, parsed: unknown): void {
    if (!parsed || typeof parsed !== "object") return;
    if (collection === "mailboxes") {
      const messages = (parsed as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) return;
      const location = { collection, key } as const;
      for (const message of messages as Array<Partial<AgentMailMessage> | null>) {
        if (typeof message?.id === "string") this.indexLocation(message.id, location);
      }
    } else if (collection === "idempotency") {
      const bounce = (parsed as { bounce?: Partial<AgentMailMessage> }).bounce;
      if (typeof bounce?.id === "string") this.indexLocation(bounce.id, { collection, key });
    }
  }

  private indexLocation(messageId: string, location: AgentMailMessageLocation): void {
    const known = this.locations.get(messageId);
    if (known?.collection === location.collection && known.key === location.key) return;
    this.rememberLocation(messageId, location);
  }

  /** Counts, for tests and diagnostics. */
  sizes(): { rows: number; length: number; locations: number } {
    return { rows: this.rows.size, length: this.length, locations: this.locations.size };
  }

  /** Records a verified match and refreshes its eviction order. */
  rememberLocation(messageId: string, location: AgentMailMessageLocation): void {
    this.locations.delete(messageId);
    this.locations.set(messageId, location);
    if (this.locations.size > AGENT_MAIL_MESSAGE_LOCATION_MAX) {
      const oldest = this.locations.keys().next().value;
      if (oldest !== undefined) this.locations.delete(oldest);
    }
  }
}
