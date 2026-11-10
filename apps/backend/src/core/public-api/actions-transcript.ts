import { createHash } from "node:crypto";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import type {
  PublicTranscriptMessage,
  PublicTranscriptPage,
  PublicTranscriptPart,
  PublicTranscriptUnchanged,
} from "@orkestrator/protocol/public-api-resources";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  onlyActionKeys,
  optionalInteger,
  optionalString,
  sessionTarget,
} from "./input.js";
import { resolveSession } from "./sessions.js";
import type { PublicActionContext, PublicActionHandler, ReadActionHandler } from "./types.js";

/**
 * Bounded, ordered transcript pages for one explicit session.
 *
 * The newest page comes from the backend's live transcript window; older
 * pages walk the provider history with the backend's own opaque cursors.
 * Pages are oldest-first, bounded by count and bytes, and say when they were
 * truncated. Tool inputs and outputs are never inlined. A cursor that no
 * longer lines up with the transcript is `cursor-expired`, never silently
 * re-anchored. Transcript reads are explicit content access: they are never
 * made by status polling or `run wait`.
 *
 * A newest-page read may carry the `token` of the page the caller already
 * holds (`knownToken`). When the same newest page still has that token the answer
 * is `unchanged` with no messages, so a follower polling every two seconds
 * downloads a page only when something moved. The window is still read fresh
 * (`forceSnapshot`): the token is only compared, never trusted as a cache key.
 */

const LIVE_WINDOW = { messages: 100, targetBytes: 512 * 1024 };

type WindowCursor = { v: 1; m: "w"; before: string; epoch: string };
type HistoryCursor = { v: 1; m: "h"; cursor: string; epoch: string };

function encodeCursor(cursor: WindowCursor | HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): WindowCursor | HistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      parsed.v === 1 &&
      parsed.m === "w" &&
      typeof parsed.before === "string" &&
      typeof parsed.epoch === "string"
    ) {
      return parsed as WindowCursor;
    }
    if (
      parsed.v === 1 &&
      parsed.m === "h" &&
      typeof parsed.cursor === "string" &&
      typeof parsed.epoch === "string"
    ) {
      return parsed as HistoryCursor;
    }
  } catch {
    // Falls through to the invalid-input error below.
  }
  throw invalid("before is not a transcript cursor");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function publicTranscriptMessage(raw: unknown): PublicTranscriptMessage | null {
  const message = record(raw);
  if (!message || typeof message.id !== "string") return null;
  const content = typeof message.content === "string" ? message.content : "";
  const text = content.slice(0, PUBLIC_API_LIMITS.transcriptTextMaxChars);
  const parts: PublicTranscriptPart[] = (Array.isArray(message.parts) ? message.parts : [])
    .slice(0, 100)
    .flatMap((rawPart) => {
      const part = record(rawPart);
      if (!part || typeof part.type !== "string") return [];
      const toolName =
        typeof part.toolName === "string"
          ? part.toolName
          : typeof part.name === "string"
            ? part.name
            : undefined;
      const isTool = /tool|command|file|diff|patch/i.test(part.type);
      return [
        {
          type: part.type.slice(0, 64),
          ...(toolName ? { toolName: toolName.slice(0, 200) } : {}),
          ...(typeof part.status === "string" ? { status: part.status.slice(0, 64) } : {}),
          ...(typeof part.title === "string" ? { title: part.title.slice(0, 200) } : {}),
          ...(isTool ? { detailOmitted: true } : {}),
        },
      ];
    });
  return {
    id: message.id,
    role: typeof message.role === "string" ? message.role : "unknown",
    createdAt: typeof message.createdAt === "string" ? message.createdAt : null,
    text,
    textTruncated: content.length > text.length,
    parts,
  };
}

/** Newest-last messages trimmed to the page's count and byte budget. */
function fitPage(
  messages: PublicTranscriptMessage[],
  limit: number,
): { kept: PublicTranscriptMessage[]; truncated: boolean } {
  const tail = messages.slice(-limit);
  const kept: PublicTranscriptMessage[] = [];
  let bytes = 0;
  for (const message of [...tail].reverse()) {
    const size = Buffer.byteLength(JSON.stringify(message));
    if (kept.length > 0 && bytes + size > PUBLIC_API_LIMITS.transcriptMaxBytes) {
      return { kept: kept.reverse(), truncated: true };
    }
    kept.push(message);
    bytes += size;
  }
  return { kept: kept.reverse(), truncated: false };
}

const sessionTranscript: ReadActionHandler<{
  sessionId: string;
  environmentId: string;
  tabId: string;
  limit: number;
  before?: string;
  knownToken?: string;
}> = {
  kind: "read",
  action: "session.transcript",
  parse(input) {
    onlyActionKeys(input, "session.transcript");
    const target = sessionTarget(input);
    const limit =
      optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.transcriptMaxMessages) ??
      PUBLIC_API_LIMITS.transcriptDefaultMessages;
    const before = optionalString(input, "before", 2048);
    const knownToken = optionalString(input, "knownToken", 256);
    // An older page has no token to compare; only the newest page changes.
    if (before && knownToken) throw invalid("knownToken reads the newest page; drop before");
    return {
      ...target,
      limit,
      ...(before ? { before } : {}),
      ...(knownToken ? { knownToken } : {}),
    };
  },
  async run(input, context) {
    // Validate the cursor before any expensive read.
    const cursor = input.before ? decodeCursor(input.before) : null;
    const session = await resolveSession(context, input);
    const triple = {
      environmentId: session.environment.id,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
    };
    if (!session.record) {
      const empty: PublicTranscriptPage = {
        sessionId: session.sessionId,
        order: "oldest-first",
        messages: [],
        complete: true,
        truncated: false,
        token: null,
        historyEpoch: null,
        freshness: "empty",
      };
      return { result: empty };
    }
    if (cursor?.m === "h") {
      const page = await context
        .invoke<{
          messages?: unknown[];
          historyEpoch?: string;
          nextCursor?: string;
          complete?: boolean;
          truncated?: boolean;
        }>("get_native_agent_message_page", {
          ...triple,
          syncVersion: 1,
          before: cursor.cursor,
          limit: input.limit,
          targetBytes: PUBLIC_API_LIMITS.transcriptMaxBytes,
        })
        .catch(() => {
          throw new PublicActionError(
            "cursor-expired",
            "The history cursor is no longer valid; read the newest page again",
          );
        });
      if (page.historyEpoch && page.historyEpoch !== cursor.epoch) {
        throw new PublicActionError(
          "cursor-expired",
          "The transcript history changed; read the newest page again",
        );
      }
      const messages = (page.messages ?? [])
        .map(publicTranscriptMessage)
        .filter((m): m is PublicTranscriptMessage => m !== null);
      const fitted = fitPage(messages, input.limit);
      const result: PublicTranscriptPage = {
        sessionId: session.sessionId,
        order: "oldest-first",
        messages: fitted.kept,
        ...(page.nextCursor && !page.complete
          ? {
              olderCursor: encodeCursor({
                v: 1,
                m: "h",
                cursor: page.nextCursor,
                epoch: cursor.epoch,
              }),
            }
          : {}),
        complete: page.complete === true,
        truncated: fitted.truncated || page.truncated === true,
        ...(fitted.truncated ? { truncation: { reason: "bytes" } } : {}),
        token: null,
        historyEpoch: cursor.epoch,
        freshness: "current",
      };
      return { result };
    }
    const update = await context.invoke<{
      status: string;
      token?: string;
      value?: {
        messages: unknown[];
        freshness: PublicTranscriptPage["freshness"];
        historyCursor?: string;
        historyEpoch: string;
        historyComplete: boolean;
        messageWindow?: {
          truncated?: boolean;
          truncationReason?: string;
          omittedMessages?: number;
        };
      };
      retryable?: boolean;
    }>("get_native_agent_transcript_update", {
      ...triple,
      viewVersion: 1,
      liveWindow: LIVE_WINDOW,
      forceSnapshot: true,
    });
    if (update.status === "missing")
      throw new PublicActionError("not-found", "The session's conversation no longer exists");
    if (update.status !== "snapshot" || !update.value) {
      // Unavailable is not an empty transcript.
      throw new PublicActionError("connection-failed", "The transcript is unavailable right now", {
        retryable: update.retryable !== false,
      });
    }
    // The provider token identifies the whole live window. Bind it to this
    // session and effective page limit so a smaller page cannot validate a
    // wider one. Older pages never issue a newest-page token.
    const token =
      !cursor && update.token !== undefined
        ? `pt1:${createHash("sha256")
            .update(JSON.stringify([session.sessionId, input.limit, update.token]))
            .digest("base64url")}`
        : null;
    if (token !== null && input.knownToken === token) {
      const unchanged: PublicTranscriptUnchanged = {
        sessionId: session.sessionId,
        status: "unchanged",
        token,
      };
      return { result: unchanged };
    }
    const view = update.value;
    let messages = view.messages
      .map(publicTranscriptMessage)
      .filter((m): m is PublicTranscriptMessage => m !== null);
    if (cursor?.m === "w") {
      if (cursor.epoch !== view.historyEpoch) {
        throw new PublicActionError(
          "cursor-expired",
          "The transcript history changed; read the newest page again",
        );
      }
      const position = messages.findIndex((message) => message.id === cursor.before);
      if (position < 0) {
        throw new PublicActionError(
          "cursor-expired",
          "The transcript has advanced past this cursor; read the newest page again",
        );
      }
      messages = messages.slice(0, position);
    }
    const fitted = fitPage(messages, input.limit);
    const olderInWindow = messages.length > fitted.kept.length;
    const first = fitted.kept[0];
    const olderCursor =
      olderInWindow && first
        ? encodeCursor({ v: 1, m: "w", before: first.id, epoch: view.historyEpoch })
        : !view.historyComplete && view.historyCursor
          ? encodeCursor({ v: 1, m: "h", cursor: view.historyCursor, epoch: view.historyEpoch })
          : undefined;
    const windowTruncated = view.messageWindow?.truncated === true;
    const result: PublicTranscriptPage = {
      sessionId: session.sessionId,
      order: "oldest-first",
      messages: fitted.kept,
      ...(olderCursor ? { olderCursor } : {}),
      // No cursor is not proof of the start: a restarted bridge's first
      // preview can hold no rows and no cursor for a conversation that has
      // history. Only the view's own `historyComplete` proves it.
      complete: !olderCursor && view.historyComplete === true,
      truncated: fitted.truncated || windowTruncated,
      ...(fitted.truncated
        ? { truncation: { reason: "bytes" } }
        : windowTruncated
          ? {
              truncation: {
                reason: view.messageWindow?.truncationReason ?? "window",
                ...(view.messageWindow?.omittedMessages !== undefined
                  ? { omittedMessages: view.messageWindow.omittedMessages }
                  : {}),
              },
            }
          : {}),
      token,
      historyEpoch: view.historyEpoch,
      freshness: view.freshness,
    };
    return { result };
  },
};

export const TRANSCRIPT_HANDLERS: PublicActionHandler[] = [sessionTranscript];

/** Fail closed when the prompt cannot be established from provider history. */
export async function assertRewindPrompt(
  context: PublicActionContext,
  sessionId: string,
  messageId: string,
): Promise<void> {
  let before: string | undefined;
  const cursors = new Set<string>();
  // Bound work even for a malicious or non-advancing history source.
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const input = sessionTranscript.parse({
      sessionId,
      limit: PUBLIC_API_LIMITS.transcriptMaxMessages,
      ...(before ? { before } : {}),
    });
    const { result } = await sessionTranscript.run(input, context);
    const page = result as PublicTranscriptPage;
    if (page.freshness !== "current") {
      throw new PublicActionError(
        "connection-failed",
        "A current provider transcript is required to rewind",
      );
    }
    const message = page.messages.find((row) => row.id === messageId);
    if (message) {
      if (message.role === "user") return;
      break;
    }
    if (!page.olderCursor || cursors.has(page.olderCursor)) break;
    before = page.olderCursor;
    cursors.add(before);
  }
  throw new PublicActionError(
    "invalid-input",
    "Rewind requires a persisted prompt (user message) ID from this session",
  );
}
