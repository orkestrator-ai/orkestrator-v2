import {
  HttpError,
  RPC_TIMEOUT_MS,
  isObject,
  provider,
  workingDirectory,
  type BridgeMessage,
  type SessionState,
} from "./acp-context.js";
import { sessionForkMethods } from "./acp-provider-config.js";
import { adoptAcpSession, ensureSessionProcess } from "./acp-session.js";

/** One prompt the agent can fork at: `_x.ai/rewind/points`, oldest first. */
export interface ForkPromptPoint {
  promptIndex: number;
  preview: string;
}

/** A compact action sends this text; it takes no prompt index of its own. */
const COMPACT_PROMPT = "/compact";

function normalizedPrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A preview is the prompt's start, possibly cut short with an ellipsis. */
function previewMatches(prompt: string, preview: string): boolean {
  const start = normalizedPrompt(preview).replace(/(?:…|\.\.\.)$/, "");
  return start.length > 0 && normalizedPrompt(prompt).startsWith(start);
}

/**
 * The prompt whose whole turn ends a fork that keeps everything up to `messageId`.
 *
 * Grok's fork keeps complete turns up to and including `targetPromptIndex`, and
 * quietly clamps an index past the end to a copy of everything, so a wrong index
 * yields a fork that looks right and holds the wrong conversation. Hence nothing
 * here counts rows: the transcript's prompts are aligned with Grok's own list
 * from the newest backwards (older rows may have been trimmed), and any row that
 * does not line up refuses the fork.
 *
 * A compaction squashes history in place: a fork at a point before one still
 * holds what came after it, as a summary. That is refused too. A compaction the
 * agent ran on its own leaves no row, so it cannot be seen here.
 */
export function forkPromptIndex(
  messages: readonly BridgeMessage[],
  messageId: string,
  points: readonly ForkPromptPoint[],
): number {
  const target = messages.findIndex((message) => message.id === messageId);
  if (target < 0) throw new HttpError(422, "That message is not in this session's transcript");
  let point = points.length - 1;
  let answer: number | undefined;
  for (let row = messages.length - 1; row >= 0; row -= 1) {
    const message = messages[row]!;
    if (message.role !== "user") continue;
    const text = message.content;
    const candidate = point >= 0 ? points[point] : undefined;
    if (candidate && previewMatches(text, candidate.preview)) {
      point -= 1;
      if (row <= target) {
        answer = candidate.promptIndex;
        break;
      }
      continue;
    }
    if (normalizedPrompt(text) === COMPACT_PROMPT && row > target) {
      throw new HttpError(422, "This session cannot be forked at a point before its compaction");
    }
    // A command the agent ran locally takes no prompt index either.
    if (normalizedPrompt(text).startsWith("/")) continue;
    throw new HttpError(422, "This session cannot be forked at that message");
  }
  if (answer === undefined) throw new HttpError(422, "That message has no prompt to fork at");
  return answer;
}

function parseForkPromptPoints(result: unknown): ForkPromptPoint[] {
  const listed = isObject(result) ? result.rewind_points : undefined;
  if (!Array.isArray(listed)) throw new Error("malformed prompt list");
  return listed.map((candidate) => {
    if (
      !isObject(candidate) ||
      !Number.isSafeInteger(candidate.prompt_index) ||
      typeof candidate.prompt_preview !== "string"
    ) {
      throw new Error("malformed prompt point");
    }
    return {
      promptIndex: candidate.prompt_index as number,
      preview: candidate.prompt_preview,
    };
  });
}

/**
 * Fork a session into a new bridge session.
 *
 * The source keeps its history and its child. The fork is a conversation of its
 * own, so it takes the source's policy but never its per-tab MCP credential: the
 * tab that adopts it sends its own with its first prompt. A read-only session is
 * refused rather than forked into one the review boundary does not cover.
 */
export async function forkAcpSession(
  state: SessionState,
  upToMessageId: string | undefined,
  signal: AbortSignal,
): Promise<SessionState> {
  const methods = sessionForkMethods(provider);
  if (!methods) throw new HttpError(422, `${provider} does not support session forks`);
  if (state.readOnly) throw new HttpError(409, "A read-only session cannot be forked");
  if (state.status === "running" || state.dispatching) {
    throw new HttpError(409, "Session is already running");
  }
  if (!state.acpSessionId) throw new HttpError(409, "This session has nothing to fork yet");

  state.dispatching = true;
  let newSessionId: unknown;
  try {
    const child = await ensureSessionProcess(state, signal);
    let targetPromptIndex: number | undefined;
    if (upToMessageId !== undefined) {
      const points = parseForkPromptPoints(
        await child.request(
          methods.promptPoints,
          { sessionId: state.acpSessionId },
          RPC_TIMEOUT_MS,
          signal,
        ),
      );
      targetPromptIndex = forkPromptIndex(state.messages, upToMessageId, points);
    }
    const forked = await child.request(
      methods.fork,
      {
        sourceSessionId: state.acpSessionId,
        sourceCwd: workingDirectory,
        newCwd: workingDirectory,
        ...(targetPromptIndex === undefined ? {} : { targetPromptIndex }),
      },
      RPC_TIMEOUT_MS,
      signal,
    );
    newSessionId = isObject(forked) ? forked.newSessionId : undefined;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Fixed text: the agent's own error can name paths on this machine.
    throw new HttpError(502, `${provider} could not fork this session`);
  } finally {
    state.dispatching = false;
  }
  if (typeof newSessionId !== "string" || !newSessionId) {
    throw new HttpError(502, `${provider} returned a malformed fork`);
  }
  return adoptAcpSession(newSessionId, signal, undefined, state.policy);
}
