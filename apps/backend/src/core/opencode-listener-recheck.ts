/**
 * The socket check again, after a failed or unexpected answer
 * (#2091; docs/architecture/agent-approvals.md).
 *
 * The backend checks the listener on a container's OpenCode port when it
 * reads the password (`readContainerBridgeToken`), then keeps sending it for
 * as long as it holds the connection. A process that replaced the server
 * after that check receives every request until the next read. A replacement
 * shows itself first as a refused connection (the server was stopped), an
 * answer the password does not open (401/403: a server with a password of its
 * own) or a reply that is not OpenCode's. On any of those this wrapper asks
 * root which socket now listens, and once the answer is `replaced` it sends
 * nothing more: every later request through it fails without leaving the
 * backend, so the password goes to no other listener, until the provider is
 * rebuilt from a fresh start.
 *
 * A window remains by design: the requests before the first failure, and a
 * replacement that answers like OpenCode. It is the same plan as the bridges'
 * (docs/architecture/agent-approvals.md, "A replaced bridge is refused").
 */
import { createLogger } from "@orkestrator/protocol/logger";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import type { OpenCodeListenerJudgement } from "./opencode-listener-identity.js";

const log = createLogger("docker");

/** What a re-check answers: a judgement, or undefined when root could not be asked. */
export type OpenCodeListenerRecheck = () => Promise<OpenCodeListenerJudgement | undefined>;

export const OPENCODE_LISTENER_REPLACED_MESSAGE =
  "OpenCode's server in this container was replaced by another process; the backend stopped sending it requests. Restart the environment's OpenCode server.";

/** The refusal every request gets once the listener was found replaced. */
function listenerReplaced(): ProviderUnavailableError {
  return new ProviderUnavailableError(OPENCODE_LISTENER_REPLACED_MESSAGE);
}

/**
 * Whether `response` is an answer the backend's own server would not give: the
 * password it was started with always opens it. A 404 or 5xx is ordinary
 * server behaviour and is left to the caller.
 */
export function unexpectedOpenCodeResponse(response: Response): boolean {
  return response.status === 401 || response.status === 403;
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

export interface OpenCodeListenerRecheckFetch {
  fetch: typeof fetch;
  /** Whether the latest re-check found the listener replaced. */
  readonly replaced: boolean;
}

/** While replaced, the listener is asked again at most this often before refusing. */
export const OPENCODE_LISTENER_RECHECK_INTERVAL_MS = 5_000;

/**
 * Wrap `inner` so that a refused connection or an unexpected answer re-checks
 * the listener (one check at a time; failures in flight share it), and a
 * `replaced` judgement stops every later request before it is sent. While
 * replaced, a request first asks again (at most every
 * {@link OPENCODE_LISTENER_RECHECK_INTERVAL_MS}): once a fresh start has
 * recorded its own socket, requests flow again (with this connection's
 * password, which the new server does not accept).
 */
export function openCodeListenerRecheckFetch(
  inner: typeof fetch,
  recheck: OpenCodeListenerRecheck,
  provider: "opencode" | "opencode2",
  now: () => number = Date.now,
): OpenCodeListenerRecheckFetch {
  let replaced = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let checking: Promise<void> | undefined;
  const check = (): Promise<void> => {
    checking ??= recheck()
      .then(
        (judgement) => {
          // Absence is not replacement evidence and cannot clear a prior refusal.
          if (judgement === undefined || judgement === "stopped") return;
          const wasReplaced = replaced;
          replaced = judgement === "replaced";
          if (replaced && !wasReplaced) {
            log.warn("opencode.listener-replaced", { provider, stage: "request" });
          }
        },
        () => undefined,
      )
      .finally(() => {
        checkedAt = now();
        checking = undefined;
      });
    return checking;
  };
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (replaced) {
      if (now() - checkedAt >= OPENCODE_LISTENER_RECHECK_INTERVAL_MS) await check();
      if (replaced) throw listenerReplaced();
    }
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (error) {
      if (!isAbort(error)) {
        await check();
        if (replaced) throw listenerReplaced();
      }
      throw error;
    }
    if (unexpectedOpenCodeResponse(response)) {
      await check();
      if (replaced) {
        await response.body?.cancel().catch(() => undefined);
        throw listenerReplaced();
      }
    }
    return response;
  }) as typeof fetch;
  if ("preconnect" in inner) {
    (wrapped as { preconnect?: unknown }).preconnect = (
      inner as { preconnect?: unknown }
    ).preconnect;
  }
  return {
    fetch: wrapped,
    get replaced() {
      return replaced;
    },
  };
}
