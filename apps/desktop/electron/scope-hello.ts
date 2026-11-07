import {
  BACKEND_HELLO_PATH,
  parseBackendHello,
  type BackendHello,
} from "@orkestrator/protocol/backend-profile";

/**
 * Reads a node's hello on a workspace connection's own base (plan item 2011),
 * so a relayed node (`<command origin>/__orkestrator/nodes/<id>`) answers its
 * own hello rather than the command node's: the path is appended to the base,
 * never resolved against its origin as `checkBackendRoute` does.
 *
 * Answers the hello, or `null` when the node answered without one (a backend
 * that predates it: a 404, or a 200 that is not a hello). Throws when it
 * cannot tell (unreachable, timed out, refused, a server error), so a
 * transient failure is never read as a pre-contract node.
 */
export async function readNodeHelloAt(
  baseUrl: string,
  token: string,
  options: { timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<BackendHello | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${BACKEND_HELLO_PATH}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`The node hello failed with HTTP ${response.status}.`);
    }
    const text = await response.text();
    if (text.length > MAX_HELLO_BYTES) return null;
    try {
      return parseBackendHello(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timer);
  }
}

const MAX_HELLO_BYTES = 64 * 1024;
