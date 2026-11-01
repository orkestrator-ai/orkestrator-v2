import { OpenCodeAgentToolsReconciler } from "./opencode-agent-tools.js";
import { describe, expect, test } from "bun:test";
import { OpenCodeCoordinatorResearch } from "./opencode-coordinator-research.js";
import { fixtureMcpServer } from "./opencode-coordinator-research-test-support.js";
import { MAX_OPENCODE_MCP_STATUS_BYTES } from "./opencode-bounded-response.js";

function fixture(registrations = new OpenCodeCoordinatorResearch()) {
  const research = fixtureMcpServer(["query-docs", "x_shadow"]);
  const posts: unknown[] = [];
  let response: () => Response | Promise<Response> = () =>
    Response.json({ context7: { status: "connected" }, context7_x: { status: "connected" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      posts.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return response();
    },
  });
  const input = {
    serverKey: `local:fixture-${server.port}`,
    port: server.port!,
    password: "fixture",
    directory: "/fixture",
    servers: [{ name: "context7", url: `${research.url.origin}/mcp` }],
  };
  return {
    research,
    registrations,
    posts,
    input,
    respond(next: typeof response) {
      response = next;
    },
    close() {
      registrations.forget(input.serverKey);
      server.stop(true);
      research.stop();
    },
  };
}

describe("OpenCode research registration", () => {
  test("registers trusted endpoints, discovers exact IDs and filters project shadows", async () => {
    const f = fixture();
    try {
      const launch = new AbortController();
      expect(await f.registrations.configure({ ...f.input, signal: launch.signal })).toEqual([
        "context7_query-docs",
      ]);
      launch.abort();
      expect(f.posts).toEqual([
        {
          url: `http://127.0.0.1:${f.input.port}/mcp?directory=%2Ffixture`,
          authorization: `Basic ${Buffer.from("opencode:fixture").toString("base64")}`,
          body: {
            name: "context7",
            config: {
              type: "remote",
              url: f.input.servers[0]!.url,
              enabled: true,
              oauth: false,
              timeout: 10_000,
            },
          },
        },
      ]);
      expect(f.research.requests()).toBeGreaterThan(0);
      await f.registrations.ensure(f.input.serverKey);
      expect(f.posts).toHaveLength(1);
      f.registrations.invalidate(f.input.serverKey);
      expect(f.registrations.toolIds(f.input.serverKey)).toEqual([]);
      await Promise.all([
        f.registrations.ensure(f.input.serverKey),
        f.registrations.ensure(f.input.serverKey),
      ]);
      expect(f.posts).toHaveLength(2);
      expect(f.registrations.toolIds(f.input.serverKey)).toEqual(["context7_query-docs"]);
    } finally {
      f.close();
    }
  });

  test("the runtime reconciler forgets research registrations on cancellation and shutdown", async () => {
    const reconciler = new OpenCodeAgentToolsReconciler();
    const f = fixture(reconciler.research);
    try {
      for (const cancel of [
        () => reconciler.cancel(f.input.serverKey),
        () => reconciler.cancelAll(),
      ]) {
        await f.registrations.configure(f.input);
        reconciler.recordLaunchConnection(f.input.serverKey, {
          url: f.input.servers[0]!.url,
          token: "fixture",
        });
        const posts = f.posts.length;
        cancel();
        f.registrations.invalidate(f.input.serverKey);
        expect(await f.registrations.ensure(f.input.serverKey)).toEqual([]);
        expect(f.posts).toHaveLength(posts);
      }
    } finally {
      reconciler.cancelAll();
      f.close();
    }
  });

  test("disconnected and non-OK registrations grant nothing after invalidation", async () => {
    const f = fixture();
    try {
      await f.registrations.configure(f.input);
      for (const respond of [
        () => new Response("failed", { status: 503 }),
        () => Response.json({ context7: { status: "failed" } }),
      ]) {
        f.registrations.invalidate(f.input.serverKey);
        f.respond(respond);
        expect(await f.registrations.ensure(f.input.serverKey)).toEqual([]);
        expect(f.registrations.toolIds(f.input.serverKey)).toEqual([]);
      }
    } finally {
      f.close();
    }
  });

  test("a late registration cannot restore allowances after disposal or process teardown", async () => {
    for (const retire of ["invalidate", "forget"] as const) {
      const f = fixture();
      let release!: (response: Response) => void;
      let started!: () => void;
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      const response = new Promise<Response>((resolve) => {
        release = resolve;
      });
      f.respond(() => {
        started();
        return response;
      });
      const pending = f.registrations.configure(f.input).catch((error: unknown) => error);
      try {
        await requested;
        f.registrations[retire](f.input.serverKey);
        release(Response.json({ context7: { status: "connected" } }));
        const error = await pending;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("instance changed");
        expect(f.registrations.toolIds(f.input.serverKey)).toEqual([]);
      } finally {
        release(new Response(null, { status: 503 }));
        await pending;
        f.close();
      }
    }
  });

  test("oversized status responses fail closed and can be retried", async () => {
    const f = fixture();
    try {
      await f.registrations.configure(f.input);
      f.registrations.invalidate(f.input.serverKey);
      f.respond(() => new Response("x".repeat(MAX_OPENCODE_MCP_STATUS_BYTES + 1)));
      await expect(f.registrations.ensure(f.input.serverKey)).rejects.toThrow("too large");
      expect(f.registrations.toolIds(f.input.serverKey)).toEqual([]);
      f.respond(() => Response.json({ context7: { status: "connected" } }));
      expect(await f.registrations.ensure(f.input.serverKey)).toEqual([
        "context7_query-docs",
        "context7_x_shadow",
      ]);
    } finally {
      f.close();
    }
  });
});
