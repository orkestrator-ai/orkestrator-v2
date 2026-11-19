import { validateHeaderName, validateHeaderValue } from "node:http";
import {
  CREDENTIAL_FORBIDDEN_HEADERS,
  CREDENTIAL_HTTP_METHODS,
  CREDENTIAL_LIMITS,
  CREDENTIAL_TIMING,
  CredentialError,
  credentialHeaderNameProblem,
  normalizeCredentialHost,
  normalizeCredentialHosts,
  type CredentialHttpMethod,
  type CredentialHttpPolicy,
} from "@orkestrator/protocol/agent-credentials";
import {
  sendPinnedHttps,
  type CredentialFetch,
  type CredentialHttpResponse,
} from "./public-https.js";
import { redactCredentialText, type RedactionValue } from "./redaction.js";

/**
 * The trusted HTTP operation: Orkestrator sends one HTTPS request with the
 * credential attached and returns a filtered answer. The agent chooses the
 * method, path, query, body and ordinary headers; the grant (which a person
 * approved) fixes the hosts and how the credential is presented. The value
 * never enters agent-controlled execution.
 *
 * - `https` only, to a host the grant lists exactly (port included), with no
 *   user info in the URL.
 * - Redirects are not followed: a 3xx comes back as an answer with its
 *   `location`, so a credential is never carried to a host nobody approved.
 * - The agent cannot set `Authorization`, `Cookie`, `Host` or hop-by-hop
 *   headers, nor the credential's own header.
 * - The answer carries status, a few safe headers and a bounded body, each
 *   filtered for the value. Other response headers (`set-cookie`, tokens a
 *   service hands back) are dropped.
 */

export interface CredentialHttpInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface PreparedHttpRequest {
  method: CredentialHttpMethod;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  /** `METHOD host/path` (no query: it may carry parameters worth keeping private). */
  summary: string;
}

export interface CredentialHttpAnswer {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyTruncated: boolean;
}

const RETURNED_HEADERS = [
  "content-type",
  "content-length",
  "location",
  "etag",
  "last-modified",
  "retry-after",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-request-id",
];

/** The canonical headers shared by idempotency and dispatch. */
export function normalizeCredentialRequestHeaders(
  input: CredentialHttpInput["headers"],
): Record<string, string> {
  const headers: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(input ?? {})) {
    const lower = name.toLowerCase();
    if (
      CREDENTIAL_FORBIDDEN_HEADERS.has(lower) ||
      Object.hasOwn(headers, lower) ||
      !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u.test(name) ||
      typeof value !== "string" ||
      value.length > 4_096 ||
      // Visible ASCII and spaces only: anything else either splits the header
      // or makes fetch throw before sending, which would read as "unknown".
      !/^[\x20-\x7e\t]*$/u.test(value)
    ) {
      throw new CredentialError("INVALID_INPUT", `Header ${name} cannot be set on this request.`);
    }
    headers[lower] = value;
  }
  if (Object.keys(headers).length > 32) {
    throw new CredentialError("INVALID_INPUT", "At most 32 headers can be set.");
  }
  return headers;
}

/** Validates the agent's request against the grant; throws `CredentialError`. */
export function prepareCredentialHttpRequest(
  input: CredentialHttpInput,
  policy: CredentialHttpPolicy,
  headers = normalizeCredentialRequestHeaders(input.headers),
): PreparedHttpRequest {
  const method = input.method.toUpperCase() as CredentialHttpMethod;
  if (!(CREDENTIAL_HTTP_METHODS as readonly string[]).includes(method)) {
    throw new CredentialError("INVALID_INPUT", `Method ${input.method} is not supported.`);
  }
  const policyMethods = policy.methods ?? CREDENTIAL_HTTP_METHODS;
  if (!policyMethods.includes(method)) {
    throw new CredentialError("POLICY_DENIED", `This grant does not allow ${method} requests.`);
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new CredentialError("INVALID_INPUT", "The URL is not valid.");
  }
  if (url.protocol !== "https:") {
    throw new CredentialError("POLICY_DENIED", "Credentialed requests use https only.");
  }
  if (url.username || url.password) {
    throw new CredentialError("INVALID_INPUT", "The URL must not contain user information.");
  }
  const host = normalizeCredentialHost(url.host);
  if (!host || !normalizeCredentialHosts(policy.hosts)?.includes(host)) {
    throw new CredentialError(
      "SCOPE_MISMATCH",
      `This grant does not allow requests to ${url.host}; it allows ${policy.hosts.join(", ") || "no hosts"}.`,
    );
  }
  url.host = host;
  url.hash = "";
  if (policy.auth.scheme === "header") {
    const problem = credentialHeaderNameProblem(policy.auth.header);
    if (problem) throw new CredentialError("INVALID_INPUT", problem);
    if (Object.hasOwn(headers, policy.auth.header.toLowerCase())) {
      throw new CredentialError("INVALID_INPUT", "The request cannot set the credential header.");
    }
  }
  if (input.body !== undefined) {
    if (method === "GET" || method === "HEAD") {
      throw new CredentialError("INVALID_INPUT", `${method} requests do not take a body.`);
    }
    if (Buffer.byteLength(input.body, "utf8") > CREDENTIAL_LIMITS.httpRequestBodyMaxBytes) {
      throw new CredentialError("INVALID_INPUT", "The request body is larger than 256 KiB.");
    }
  }
  return {
    method,
    url,
    headers,
    ...(input.body !== undefined ? { body: input.body } : {}),
    summary: `${method} ${host}${url.pathname}`,
  };
}

/** Attaches the credential as the grant says. */
export function credentialHeaders(
  policy: CredentialHttpPolicy,
  value: string,
): Record<string, string> {
  switch (policy.auth.scheme) {
    case "bearer":
      return { authorization: `Bearer ${value}` };
    case "header":
      return { [policy.auth.header.toLowerCase()]: value };
    case "basic":
      return {
        authorization: `Basic ${Buffer.from(`${policy.auth.username}:${value}`, "utf8").toString("base64")}`,
      };
  }
}

export function materializeCredentialHeaders(
  prepared: PreparedHttpRequest,
  policy: CredentialHttpPolicy,
  value: string,
): Record<string, string> {
  const headers = { ...prepared.headers, ...credentialHeaders(policy, value) };
  try {
    for (const [name, content] of Object.entries(headers)) {
      validateHeaderName(name);
      validateHeaderValue(name, content);
    }
  } catch {
    throw new CredentialError(
      "INVALID_INPUT",
      "The credential cannot be represented in the approved HTTP header.",
    );
  }
  return headers;
}

export type CredentialHttpOutcome =
  | { kind: "answered"; answer: CredentialHttpAnswer }
  /** The request certainly did not reach the service (DNS, refused, TLS setup). */
  | { kind: "not-sent"; reason: string }
  /** It may have reached the service: a timeout or a connection lost mid-request. */
  | { kind: "unknown"; reason: string };

const NOT_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

function failureCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "unknown";
}

async function readBounded(
  response: CredentialHttpResponse,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const buffer = Buffer.allocUnsafe(maxBytes);
  let size = 0;
  let truncated = false;
  // Breaking the iterator cancels the response stream (including a node socket).
  for await (const value of response.body) {
    const room = maxBytes - size;
    const count = Math.min(room, value.byteLength);
    buffer.set(value.subarray(0, count), size);
    size += count;
    if (value.byteLength > room) {
      truncated = true;
      break;
    }
  }
  return {
    text: new TextDecoder().decode(buffer.subarray(0, size), { stream: truncated }),
    truncated,
  };
}

/** Bytes beyond the body limit to read so a value at the cut is filtered whole. */
function filterMargin(redaction: readonly RedactionValue[]): number {
  let longest = 0;
  for (const entry of redaction) {
    const bytes =
      Buffer.byteLength(entry.value, "utf8") + Buffer.byteLength(entry.basicUser ?? "", "utf8");
    // Percent-encoding triples a byte; base64 adds a third; plus slack.
    longest = Math.max(longest, bytes * 3 + 16);
  }
  return longest;
}

/** Cuts filtered text to the body limit. */
function boundedBody(text: string, truncated: boolean): { body: string; bodyTruncated: boolean } {
  const limit = CREDENTIAL_LIMITS.httpResponseBodyMaxBytes;
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= limit) return { body: text, bodyTruncated: truncated };
  return {
    body: new TextDecoder().decode(buffer.subarray(0, limit), { stream: true }),
    bodyTruncated: true,
  };
}

/** Sends the request. Never throws: every failure is an outcome. */
export async function sendCredentialHttpRequest(
  prepared: PreparedHttpRequest,
  materializedHeaders: Record<string, string>,
  redaction: readonly RedactionValue[],
  options: { fetch?: CredentialFetch; address: string; signal: AbortSignal; timeoutMs?: number },
): Promise<CredentialHttpOutcome> {
  if (options.signal.aborted) {
    return { kind: "not-sent", reason: "No authorized destination." };
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? CREDENTIAL_TIMING.httpTimeoutMs,
  );
  const onAbort = () => controller.abort();
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  let response: CredentialHttpResponse;
  try {
    const init = {
      method: prepared.method,
      headers: materializedHeaders,
      ...(prepared.body !== undefined ? { body: prepared.body } : {}),
      signal: controller.signal,
    };
    response = options.fetch
      ? await options.fetch(prepared.url, { ...init, redirect: "manual" })
      : await sendPinnedHttps(prepared.url, options.address, init);
  } catch (error) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    const code = failureCode(error);
    if (NOT_SENT_CODES.has(code)) return { kind: "not-sent", reason: code };
    return {
      kind: "unknown",
      reason: options.signal.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : code,
    };
  }
  try {
    const body = await readBounded(
      response,
      // Read past the limit by the longest encoded form of the value, so
      // a value cut by the limit is still whole when it is filtered;
      // the text is cut to the limit only after filtering.
      CREDENTIAL_LIMITS.httpResponseBodyMaxBytes + filterMargin(redaction),
    );
    const headers: Record<string, string> = {};
    for (const name of RETURNED_HEADERS) {
      const header = response.headers.get(name);
      if (header !== null) headers[name] = redactCredentialText(header, redaction).slice(0, 2_048);
    }
    return {
      kind: "answered",
      answer: {
        status: response.status,
        statusText: redactCredentialText(response.statusText, redaction).slice(0, 200),
        headers,
        ...boundedBody(redactCredentialText(body.text, redaction, !body.truncated), body.truncated),
      },
    };
  } catch {
    // The status arrived, so the service saw the request; only the body was lost.
    return {
      kind: "answered",
      answer: {
        status: response.status,
        statusText: "",
        headers: {},
        body: "",
        bodyTruncated: true,
      },
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
