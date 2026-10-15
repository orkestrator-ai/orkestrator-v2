import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMessageBase, SessionState } from "../../types/index.js";
import type { TurnState } from "../session-manager-prompt-turn.js";

/**
 * What a message handler sees of the turn a frame was routed to.
 *
 * The closures are the ones `sendPrompt` still owns; they are read here
 * rather than rebuilt, so a handler behaves exactly as the branch it replaced.
 */
export interface PromptMessageContext {
  readonly session: SessionState;
  readonly sessionId: string;
  readonly turn: TurnState;
  readonly reclaimReleasedTurnForAssistant: (message: SdkMessageBase) => void;
  readonly publishStreamUsage: (message: unknown) => void;
}

/**
 * One branch of the prompt loop's dispatch.
 *
 * Runs on the runtime's single frame consumer: it must never wait on
 * rendering, and only a handler that has to finish a control round trip
 * before the next frame may return a promise.
 */
export type PromptMessageHandler = (
  context: PromptMessageContext,
  message: SDKMessage,
) => void | Promise<void>;
