export const MAX_ACP_ERROR_BYTES = 2_000;

const GENERIC_ACP_ERROR = /^(?:internal error|acp request failed)$/i;
const GROK_USAGE_EXHAUSTED = /grok build usage balance (?:is )?exhausted/i;
const USAGE_EXHAUSTED = /(?:usage (?:balance|credits?)|credit balance) (?:is )?exhausted/i;
const PAYMENT_REQUIRED = /(?:status\s+)?402\b[^\n]*payment required|payment required[^\n]*\b402\b/i;

export const GROK_USAGE_EXHAUSTED_MESSAGE =
  "Grok Build usage balance is exhausted. Add usage credits, then retry this message.";
export const GROK_PAYMENT_REQUIRED_MESSAGE =
  "Grok Build could not continue because payment or usage credits are required. Check your Grok Build billing, then retry this message.";

type AcpProvider = "cursor" | "grok" | undefined;

function boundedErrorText(value: string): string | undefined {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return undefined;
  if (Buffer.byteLength(normalized) <= MAX_ACP_ERROR_BYTES) return normalized;
  const ellipsis = "…";
  return `${truncateErrorUtf8(
    normalized,
    MAX_ACP_ERROR_BYTES - Buffer.byteLength(ellipsis),
  )}${ellipsis}`;
}

function truncateErrorUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoded = Buffer.from(value);
  if (encoded.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function normalizedBillingError(
  text: string,
  status?: number,
  provider?: AcpProvider,
): string | undefined {
  const grok = provider === "grok" || /\bgrok build\b/i.test(text);
  const label = grok ? "Grok Build" : provider === "cursor" ? "Cursor Agent" : "The agent";
  if (GROK_USAGE_EXHAUSTED.test(text) || USAGE_EXHAUSTED.test(text)) {
    return grok
      ? GROK_USAGE_EXHAUSTED_MESSAGE
      : `${label} usage balance is exhausted. Add usage credits, then retry this message.`;
  }
  if (status === 402 || PAYMENT_REQUIRED.test(text)) {
    return grok
      ? GROK_PAYMENT_REQUIRED_MESSAGE
      : `${label} could not continue because payment or usage credits are required. Check its billing, then retry this message.`;
  }
  return undefined;
}

function embeddedJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth !== 0) continue;
      try {
        return JSON.parse(text.slice(start, index + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function numericStatus(value: Record<string, unknown>): number | undefined {
  for (const key of ["http_status", "status_code", "httpStatus", "statusCode"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)) return candidate;
  }
  return undefined;
}

function errorDetail(
  value: unknown,
  provider?: AcpProvider,
  depth = 0,
  allowPlainString = false,
): string | undefined {
  if (depth > 4 || value == null) return undefined;
  if (typeof value === "string") {
    const text = boundedErrorText(value);
    if (!text) return undefined;
    const billing = normalizedBillingError(text, undefined, provider);
    if (billing) return billing;
    const parsed = embeddedJson(value);
    if (parsed !== undefined) {
      const detail = errorDetail(parsed, provider, depth + 1);
      if (detail && !GENERIC_ACP_ERROR.test(detail)) return detail;
      return undefined;
    }
    // A string which looks like a serialized object but cannot be parsed is an
    // opaque provider payload, not a safe diagnostic. Never persist it whole.
    if (value.includes("{")) return undefined;
    return allowPlainString ? text : undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  const status = numericStatus(record);
  let generic: string | undefined;
  for (const key of ["message", "detail", "details", "reason", "error_description", "error"]) {
    const detail = errorDetail(record[key], provider, depth + 1, true);
    if (!detail) continue;
    const billing = normalizedBillingError(detail, status, provider);
    if (billing) return billing;
    if (!GENERIC_ACP_ERROR.test(detail)) return detail;
    generic ??= detail;
  }
  const dataDetail = errorDetail(record.data, provider, depth + 1);
  if (dataDetail) {
    const billing = normalizedBillingError(dataDetail, status, provider);
    if (billing) return billing;
    if (!GENERIC_ACP_ERROR.test(dataDetail)) return dataDetail;
    generic ??= dataDetail;
  }
  return status === 402 ? normalizedBillingError("", status, provider) : generic;
}

/**
 * Extract a bounded user-facing provider failure without serializing arbitrary
 * ACP error data. Grok puts the actionable HTTP error beside a large usage
 * object; only its named message is retained here.
 */
export function formatAcpProviderError(
  value: unknown,
  fallback: string,
  provider?: AcpProvider,
): string {
  return errorDetail(value, provider) ?? fallback;
}

/** Preserve JSON-RPC error data when the top-level message is only "Internal error". */
export function formatAcpRpcError(error: Record<string, unknown>, provider?: AcpProvider): string {
  const primary = errorDetail(error.message, provider, 0, true);
  const detail = errorDetail(error.data, provider);
  if (detail && normalizedBillingError(detail, undefined, provider)) return detail;
  if (detail && (!primary || GENERIC_ACP_ERROR.test(primary))) return detail;
  return primary ?? detail ?? "ACP request failed";
}
