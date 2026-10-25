import { ERROR_MESSAGE_PREFIX } from "@/lib/chat/client-only-messages";
import type { NativeMessage } from "@/lib/chat/native-message-types";

const MODEL_REQUEST_FAILED = /^Model request failed(?: \(HTTP (\d{3})\))?:/;
const CREDENTIAL_WORDING = /\b(api[ -]?key|unauthori[sz]ed|authenticat\w*|credential\w*)\b/i;

/**
 * The provider whose credential a failed OpenCode model request was refused
 * for, or undefined when the row is anything else.
 *
 * Only the backend's inline error row qualifies: it carries the failed
 * message's `providerID/modelID`. Assistant prose never activates it.
 */
export function openCodeCredentialFailureProvider(
  message: Pick<NativeMessage, "id" | "content" | "modelId">,
): string | undefined {
  if (!message.id.startsWith(ERROR_MESSAGE_PREFIX)) return undefined;
  const content = message.content.trim();
  // 401 is a refused credential. A 403, a failure without a status, or
  // OpenCode's own `ProviderAuthError` (kept verbatim) only counts when it says
  // so; any other status (429, 5xx) is not a login problem.
  const status = MODEL_REQUEST_FAILED.exec(content)?.[1];
  if (status !== "401") {
    if (status !== undefined && status !== "403") return undefined;
    if (!CREDENTIAL_WORDING.test(content)) return undefined;
  }
  const slash = message.modelId?.indexOf("/") ?? -1;
  if (slash <= 0) return undefined;
  return message.modelId!.slice(0, slash);
}
