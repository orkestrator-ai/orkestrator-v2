import {
  DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
  NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
} from "@orkestrator/protocol/native-agent";
import {
  boundToolOutputError,
  sliceToolOutput,
  type NativeAgentToolOutputRead,
  type ToolOutputReadRequest,
} from "@orkestrator/protocol/native-agent-tool-output";
import type { NativeAgentProjectionInput } from "./service-shared.js";
import { nativeAgentSessionStorageKey } from "./service-shared.js";
import type { NativeAgentProjectionContext } from "./projection-context.js";

/** Nested part fields a tool call can sit in (`projectionPart` recurses into the same). */
const NESTED_PART_FIELDS = ["parts", "childTools", "subagentActions"] as const;
/** Bounds of one search through a cached view. */
const MAX_PART_DEPTH = 8;
const MAX_VISITED_PARTS = 50_000;

/** What the session's cached live view says about one tool call. Content-free. */
export type ToolOutputSource =
  /** The live view does not hold the call (it left the window, or never was). */
  | { located: false }
  | {
      located: true;
      /** The projection's reference for the call's output, error and diff. */
      detailRef?: string;
      toolState?: string;
      /** Output still inline on the part (a part with no detail reference). */
      inlineOutput?: string;
      inlineError?: string;
      complete: boolean;
    };

interface FoundPart {
  detailRef?: string;
  toolState?: string;
  toolOutput?: string;
  toolError?: string;
  settled: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The newest tool part with `toolUseId` in `messages`, searched newest row
 * first with bounded depth and breadth.
 */
export function findToolPart(
  messages: readonly unknown[],
  toolUseId: string,
  messageId?: string,
): FoundPart | undefined {
  let visited = 0;
  const visit = (raw: unknown, depth: number): FoundPart | undefined => {
    if (visited >= MAX_VISITED_PARTS || depth > MAX_PART_DEPTH) return undefined;
    visited += 1;
    const part = asRecord(raw);
    if (!part) return undefined;
    if (part.type === "tool-invocation" && part.toolUseId === toolUseId) {
      const toolState = typeof part.toolState === "string" ? part.toolState : undefined;
      return {
        ...(typeof part.detailRef === "string" ? { detailRef: part.detailRef } : {}),
        ...(toolState ? { toolState } : {}),
        ...(typeof part.toolOutput === "string" ? { toolOutput: part.toolOutput } : {}),
        ...(typeof part.toolError === "string" ? { toolError: part.toolError } : {}),
        settled:
          toolState === "success" ||
          toolState === "failure" ||
          part.toolLeftRunning === true ||
          part.toolDenied !== undefined,
      };
    }
    for (const field of NESTED_PART_FIELDS) {
      const children = part[field];
      if (!Array.isArray(children)) continue;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const found = visit(children[index], depth + 1);
        if (found) return found;
      }
    }
    if (part.task !== undefined) return visit(part.task, depth + 1);
    return undefined;
  };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (messageId !== undefined && message?.id !== messageId) continue;
    const parts = message?.parts;
    if (!Array.isArray(parts)) continue;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const found = visit(parts[partIndex], 1);
      if (found) return found;
    }
    if (visited >= MAX_VISITED_PARTS) break;
  }
  return undefined;
}

/**
 * Bounded reads of one tool call's output (`get_native_agent_tool_output`)
 * and the content-free source the `tool-output` push topic compares.
 *
 * Neither reads a provider to find the call: it is looked up in the session's
 * cached live view, which the `native-session` observer keeps current while
 * the topic holds the session. The body comes through the detail reference
 * the view gives the call (`getProjectionToolDetails`), so the reads share
 * the detail cache and its provider read with an expanded row.
 */
export class NativeAgentToolOutputReads {
  constructor(private readonly context: NativeAgentProjectionContext) {}

  /**
   * Pure in-memory lookup. `null` when no live view of the session is cached
   * (nothing has read it yet).
   */
  toolOutputSource(
    input: Pick<NativeAgentProjectionInput, "environmentId" | "agent" | "logicalSessionKey">,
    toolUseId: string,
    messageId?: string,
  ): ToolOutputSource | null {
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const prefix = `${sessionKey}\0progressive-v1\0transcript:`;
    let cachedAny = false;
    let found: FoundPart | undefined;
    // Least recently used first: the newest window that holds the call wins.
    for (const [key, entry] of this.context.transcript.progressiveTranscriptCache) {
      if (!key.startsWith(prefix)) continue;
      cachedAny = true;
      const value = entry.value;
      const match =
        findToolPart(value.revisedMessages ?? [], toolUseId, messageId) ??
        findToolPart(value.messages, toolUseId, messageId);
      if (match) found = match;
    }
    if (!cachedAny) return null;
    if (!found) return { located: false };
    return {
      located: true,
      ...(found.detailRef ? { detailRef: found.detailRef } : {}),
      ...(found.toolState ? { toolState: found.toolState } : {}),
      ...(found.toolOutput !== undefined ? { inlineOutput: found.toolOutput } : {}),
      ...(found.toolError !== undefined ? { inlineError: found.toolError } : {}),
      complete: found.settled,
    };
  }

  async readToolOutput(
    input: NativeAgentProjectionInput & {
      toolUseId: string;
      messageId?: string;
      detailRef?: string;
    } & ToolOutputReadRequest,
  ): Promise<NativeAgentToolOutputRead> {
    this.context.host.assertProjectionInput(input);
    const session = {
      environmentId: input.environmentId,
      agent: input.agent,
      logicalSessionKey: input.logicalSessionKey,
    };
    // Older clients may still request by call ID only. Their existing detail
    // fallback can display the row without risking a match in another row.
    if (input.messageId === undefined) return { status: "expired" };
    let source = this.toolOutputSource(session, input.toolUseId, input.messageId);
    if (source === null) {
      // Nothing has read this session's live view yet: read it once, the way
      // a mounting view would, so the call can be found.
      await this.context.transcript
        .getTranscriptUpdate({
          ...session,
          viewVersion: NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
          liveWindow: { ...DEFAULT_NATIVE_AGENT_LIVE_WINDOW },
        })
        .catch(() => undefined);
      source = this.toolOutputSource(session, input.toolUseId, input.messageId);
    }
    const request: ToolOutputReadRequest = {
      mode: input.mode,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
      limit: input.limit,
    };
    if (source?.located && source.detailRef === undefined) {
      return {
        status: "ok",
        complete: source.complete,
        ...sliceToolOutput(source.inlineOutput ?? "", request),
        ...(source.inlineError ? { toolError: boundToolOutputError(source.inlineError) } : {}),
      };
    }
    // A call outside the live view is read through the reference its row
    // holds. A readable historical body does not establish completion.
    if (!source?.located && request.mode === "range") return { status: "pending" };
    const detailRef = source?.located ? source.detailRef : input.detailRef;
    if (!detailRef) return { status: "pending" };
    const complete = source?.located === true && source.complete;
    let details;
    try {
      const range = await this.context.toolDetails.readRemoteOutput(
        { ...session, detailRef },
        request,
      );
      if (range?.status === "ok") return { ...range, complete };
      if (range !== undefined) return { status: complete ? "expired" : "pending" };
      details = await this.context.toolDetails.getProjectionToolDetails({ ...session, detailRef });
    } catch {
      return { status: complete ? "expired" : "pending" };
    }
    return {
      status: "ok",
      complete,
      ...sliceToolOutput(details.toolOutput ?? "", request),
      ...(details.toolError ? { toolError: boundToolOutputError(details.toolError) } : {}),
    };
  }
}
