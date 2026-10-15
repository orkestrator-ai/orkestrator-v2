import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnState } from "../session-manager-prompt-turn.js";

/**
 * One branch of the prompt loop's dispatch, for the turn a frame was routed to.
 *
 * Runs on the runtime's single frame consumer: it must never wait on
 * rendering, and only a handler that has to finish a control round trip
 * before the next frame may return a promise.
 */
export type PromptMessageHandler = (turn: TurnState, message: SDKMessage) => void | Promise<void>;
