import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  boundedOpenCodeMessageHistory,
  findOpenCodeMessageId,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  openCodeRequestMarker,
} from "@orkestrator/protocol/opencode-message-id";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { assertSdkResponse, asRecord } from "./agent-provider-runtime.js";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { parseOpenCodeStructuredText } from "./opencode-messages.js";

export async function readOpenCodeStructuredOutput<T>(
  client: OpencodeClient,
  sessionId: string,
  requestId: string,
  requestOptions: { signal: AbortSignal },
): Promise<StructuredOutputResult<T> | null> {
  openCodeRequestMarker(requestId);
  let response;
  try {
    response = await client.session.messages(
      { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
      requestOptions,
    );
    assertSdkResponse(response, "OpenCode structured-output read");
  } catch (error) {
    throw new ProviderUnavailableError("OpenCode structured output is unavailable", {
      cause: error,
    });
  }
  if (!Array.isArray(response.data)) return null;
  let entries: readonly unknown[];
  try {
    entries = boundedOpenCodeMessageHistory(response.data);
  } catch (error) {
    throw new ProviderUnavailableError("OpenCode structured output history is invalid", {
      cause: error,
    });
  }
  const providerMessageId = findOpenCodeMessageId(entries, requestId);
  if (!providerMessageId) return null;
  const assistant = [...entries].reverse().find((entry) => {
    const candidate = asRecord(entry);
    const info = asRecord(candidate?.info);
    return info?.role === "assistant" && info.parentID === providerMessageId;
  });
  if (!assistant) return null;
  const assistantRecord = assistant as {
    info: Record<string, unknown>;
    parts?: unknown;
  };
  const info = assistantRecord.info as {
    error?: unknown;
    structured?: unknown;
    time?: { completed?: unknown };
  };
  if (!info.time?.completed) return null;
  if (info.error) {
    return {
      ok: false,
      provider: "opencode",
      requestId,
      error: {
        code: "provider_error",
        message: "OpenCode did not produce a structured result",
        provider: "opencode",
        retryable: true,
      },
    };
  }
  let value: unknown;
  try {
    value =
      info.structured === undefined
        ? parseOpenCodeStructuredText(assistantRecord.parts)
        : info.structured;
  } catch {
    return {
      ok: false,
      provider: "opencode",
      requestId,
      error: {
        code: "malformed_output",
        message: "OpenCode did not produce a valid JSON result",
        provider: "opencode",
        retryable: true,
      },
    };
  }
  return { ok: true, provider: "opencode", requestId, value: value as T };
}
