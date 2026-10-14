import type { NativeMessage, NativeMessagePart } from "./chat/native-message-types";

/*
 * Renderer-side shape of a normalized OpenCode transcript message. Only the
 * pipeline transcript normalizer in `opencode-messages.ts` still produces it.
 */
export type OpenCodeMessagePart = NativeMessagePart;
export type OpenCodeMessage = NativeMessage & {
  /** Whether the SDK marked this assistant message as failed. Raw error data is intentionally not retained. */
  hasError?: boolean;
  /**
   * The error's discriminator (`MessageAbortedError`, …) when the SDK reported
   * one. Kept alongside {@link hasError} so an intentional interrupt can be
   * told apart from a real failure; the error payload itself is still dropped.
   */
  errorName?: string;
  /**
   * Provider finish reason reported by OpenCode's final `step-finish` part.
   *
   * OpenCode currently treats an unrecognized provider finish reason as
   * terminal even when the assistant produced reasoning but no final text.
   * Recovery for that incomplete outcome is backend-owned (the native agent
   * service inspects the authoritative transcript on the turn-end edge and
   * dispatches one continuation); the reason is kept here as display metadata.
   */
  finishReason?: string;
  providerUsage?: {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens?: number;
    modelId: string;
    agent?: string;
    durationMs?: number;
  };
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
