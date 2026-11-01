/**
 * A loopback HTTP proxy in front of a scenario backend that loses the
 * response to the first submission of each named public action after the
 * backend has answered it, as a proxy timing out on a slow admission does.
 * The client sees a non-JSON 504 (`transport-uncertain`); the backend has
 * admitted the operation. Every other request passes through unchanged.
 */

export interface LossyProxy {
  url: string;
  /** Submissions of each action that reached the backend through the proxy. */
  submissions(action: string): number;
  /** Responses the proxy withheld, by action. */
  dropped(action: string): number;
  stop(): Promise<void>;
}

export async function startLossyProxy(options: {
  upstream: string;
  /** Lose the backend's answer to the first submission of each of these actions. */
  dropFirst: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<LossyProxy> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const upstream = new URL(options.upstream);
  const submitted = new Map<string, number>();
  const dropped = new Map<string, number>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const incoming = new URL(request.url);
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      const action = publicAction(body);
      if (action) submitted.set(action, (submitted.get(action) ?? 0) + 1);
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      const answer = await fetchImpl(new URL(incoming.pathname + incoming.search, upstream), {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
      });
      if (action && options.dropFirst.includes(action) && !dropped.has(action)) {
        // The backend has answered (the operation is admitted); lose that answer.
        await answer.arrayBuffer().catch(() => undefined);
        dropped.set(action, 1);
        return new Response("upstream timeout", { status: 504 });
      }
      // `fetch` has already decoded the body, so its encoding and length no longer apply.
      const forwarded = new Headers(answer.headers);
      forwarded.delete("content-encoding");
      forwarded.delete("content-length");
      return new Response(await answer.arrayBuffer(), {
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
    async stop() {
      await server.stop(true);
    },
  };
}

/** The public action a gateway invoke body carries, when it is one. */
function publicAction(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { args?: { action?: unknown } };
    return typeof parsed.args?.action === "string" ? parsed.args.action : undefined;
  } catch {
    return undefined;
  }
}
