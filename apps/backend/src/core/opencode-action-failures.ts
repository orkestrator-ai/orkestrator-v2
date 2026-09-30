import { openCodeRequestMarker } from "@orkestrator/protocol/opencode-message-id";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";

export const OPEN_CODE_ACTION_FAILURES_METADATA_KEY = "orkestrator.actionRetryFailures";
const MAX_ACTION_FAILURES = 16;

type ActionFailure = { requestId: string; message: string };

function failures(session: Record<string, unknown>): ActionFailure[] {
  const entries = asRecord(session.metadata)?.[OPEN_CODE_ACTION_FAILURES_METADATA_KEY];
  if (!Array.isArray(entries)) return [];
  return entries.slice(-MAX_ACTION_FAILURES).flatMap((entry) => {
    const record = asRecord(entry);
    const requestId = nonEmptyString(record?.requestId);
    const message = nonEmptyString(record?.message);
    return requestId && requestId.length <= 256 && message && message.length <= 2_000
      ? [{ requestId, message }]
      : [];
  });
}

export function metadataWithOpenCodeActionFailure(
  session: Record<string, unknown>,
  requestId: string,
  message: string,
): Record<string, unknown> {
  return {
    ...asRecord(session.metadata),
    [OPEN_CODE_ACTION_FAILURES_METADATA_KEY]: [
      ...failures(session).filter((entry) => entry.requestId !== requestId),
      { requestId, message: message.slice(0, 2_000) },
    ].slice(-MAX_ACTION_FAILURES),
  };
}

export function openCodeActionFailureForMessage(
  session: Record<string, unknown>,
  message: unknown,
): string | undefined {
  const info = asRecord(asRecord(message)?.info);
  if (nonEmptyString(asRecord(info?.error)?.name) !== "MessageAbortedError") return undefined;
  const parentId = nonEmptyString(info?.parentID);
  if (!parentId) return undefined;
  return failures(session).find(({ requestId }) =>
    parentId.endsWith(openCodeRequestMarker(requestId)),
  )?.message;
}

export function openCodeMessagesWithActionFailures(
  session: Record<string, unknown>,
  messages: readonly unknown[],
): unknown[] {
  return messages.map((message) => {
    const failure = openCodeActionFailureForMessage(session, message);
    if (!failure) return message;
    const record = asRecord(message)!;
    return {
      ...record,
      info: {
        ...asRecord(record.info),
        error: { name: "OpenCodeRetryActionError", data: { message: failure } },
      },
    };
  });
}
