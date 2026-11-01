/**
 * A loopback HTTP proxy in front of a scenario backend that loses the
 * response to the first submission of each named public action. The client
 * sees a non-JSON 504 (`transport-uncertain`) either way; every other request
 * passes through unchanged.
 *
 * - `answer`: the submission reaches the backend and is admitted; its answer
 *   is lost on the way back, as a proxy timing out on a slow response does.
 * - `admission`: the 504 comes at once and the submission is held until the
 *   client's first lookup by request key has been answered (`not-found`),
 *   then delivered. This is an admission slower than the client's request
 *   timeout (flake 0440): the client must keep looking until it appears.
 */

export type LossMode = "answer" | "admission";

export interface LossyProxy {
  url: string;
  /** Submissions of each action that reached the proxy. */
  submissions(action: string): number;
  /** Responses the proxy withheld, by action. */
  dropped(action: string): number;
  /** `run.get` lookups by request key for each action. */
  lookups(action: string): number;
  stop(): Promise<void>;
}

interface Invoke {
  action?: string;
  /** For `run.get` by request key: the action looked up. */
  lookupOf?: string;
}

export async function startLossyProxy(options: {
  upstream: string;
  /** Lose the first submission's answer for each of these actions. */
  lose: Readonly<Record<string, LossMode>>;
  fetchImpl?: typeof fetch;
}): Promise<LossyProxy> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const upstream = new URL(options.upstream);
  const submitted = new Map<string, number>();
  const dropped = new Map<string, number>();
  const lookedUp = new Map<string, number>();
  const held = new Map<string, () => void>();
  const pending = new Set<Promise<unknown>>();
  const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const incoming = new URL(request.url);
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      const invoke = parseInvoke(body);
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      const forward = () =>
        fetchImpl(new URL(incoming.pathname + incoming.search, upstream), {
          method: request.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          redirect: "manual",
        });
      const action = invoke.action;
      if (action) count(submitted, action);
      const mode = action ? options.lose[action] : undefined;
      if (action && mode && !dropped.has(action)) {
        dropped.set(action, 1);
        if (mode === "admission") {
          held.set(action, () => {
            const delivery = forward()
              .then((answer) => answer.arrayBuffer())
              .catch(() => undefined);
            pending.add(delivery);
            void delivery.finally(() => pending.delete(delivery));
          });
        } else {
          // The backend has answered (the operation is admitted); lose that answer.
          await (await forward()).arrayBuffer().catch(() => undefined);
        }
        return new Response("upstream timeout", { status: 504 });
      }
      const answer = await forward();
      const bytes = await answer.arrayBuffer();
      if (invoke.lookupOf) {
        count(lookedUp, invoke.lookupOf);
        // This lookup was answered before the held submission was delivered.
        const release = held.get(invoke.lookupOf);
        held.delete(invoke.lookupOf);
        release?.();
      }
      // `fetch` has already decoded the body, so its encoding and length no longer apply.
      const forwarded = new Headers(answer.headers);
      forwarded.delete("content-encoding");
      forwarded.delete("content-length");
      return new Response(bytes, {
        status: answer.status,
        statusText: answer.statusText,
        headers: forwarded,
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    submissions: (action) => submitted.get(action) ?? 0,
    dropped: (action) => dropped.get(action) ?? 0,
    lookups: (action) => lookedUp.get(action) ?? 0,
    async stop() {
      await Promise.allSettled([...pending]);
      await server.stop(true);
    },
  };
}

/** The public action a gateway invoke carries, or the action a key lookup looks up. */
function parseInvoke(body: string | undefined): Invoke {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as {
      args?: { action?: unknown; input?: { requestId?: unknown; action?: unknown } };
    };
    const action = typeof parsed.args?.action === "string" ? parsed.args.action : undefined;
    const input = parsed.args?.input;
    if (action === "run.get" && typeof input?.requestId === "string") {
      return typeof input.action === "string" ? { lookupOf: input.action } : {};
    }
    return action ? { action } : {};
  } catch {
    return {};
  }
}
