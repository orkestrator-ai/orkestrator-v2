import { afterEach, describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "../agent-provider-contract.js";
import { OpenCode2Client, OpenCode2RequestError, readBoundedJson } from "./client.js";

type Seen = { method: string; path: string; search: string; headers: Headers; body: unknown };

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function serve(handler: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      const entry: Seen = {
        method: request.method,
        path: url.pathname,
        search: url.search,
        headers: request.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      seen.push(entry);
      return handler(entry);
    },
  });
  const client = new OpenCode2Client({
    baseUrl: `http://127.0.0.1:${server.port}`,
    password: "pw",
    directory: "/work/project",
    timeoutMs: 2_000,
  });
  return { client, seen };
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

describe("OpenCode2Client", () => {
  test("authenticates, scopes the directory and unwraps the data envelope", async () => {
    const { client, seen } = serve(() => json({ data: { version: "2.2.6", pid: 1 } }));
    await expect(client.info()).resolves.toEqual({ version: "2.2.6", pid: 1 });
    expect(seen[0]!.headers.get("authorization")).toBe(`Basic ${btoa("opencode:pw")}`);
    expect(seen[0]!.headers.get("x-opencode-directory")).toBe("/work/project");
  });

  test("creates a session at the connection's location", async () => {
    const { client, seen } = serve(() => json({ data: { id: "ses_1" } }));
    await client.createSession({ model: { providerID: "fixture", id: "fixture" } });
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/api/session",
      body: {
        model: { providerID: "fixture", id: "fixture" },
        location: { directory: "/work/project" },
      },
    });
  });

  test("sends steer input with its id and keeps the message cursor", async () => {
    const { client, seen } = serve((request) =>
      request.path.endsWith("/prompt")
        ? json({ data: { id: "msg_x", payload: { text: "go" }, delivery: "steer" } })
        : json({ data: [{ id: "msg_x", type: "user", text: "go" }], cursor: { next: "c2" } }),
    );
    await client.prompt("ses_1", { id: "msg_x", text: "go", delivery: "steer" });
    expect(seen[0]).toMatchObject({
      path: "/api/session/ses_1/prompt",
      body: { id: "msg_x", text: "go", delivery: "steer" },
    });
    const page = await client.listMessages("ses_1", { limit: 50, order: "desc" });
    expect(seen[1]!.search).toBe("?limit=50&order=desc");
    expect(page.messages).toEqual([{ id: "msg_x", type: "user", text: "go" }] as never);
    expect(page.cursor).toEqual({ next: "c2" });
  });

  test("a 4xx is a definitive refusal carrying the server's tag", async () => {
    const { client } = serve(() =>
      json({ _tag: "InvalidRequestError", message: 'Expected a string starting with "msg_"' }, 400),
    );
    const error = await client
      .prompt("ses_1", { id: "bad", text: "x", delivery: "steer" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenCode2RequestError);
    expect(error).toMatchObject({ status: 400, tag: "InvalidRequestError" });
  });

  test("a 5xx, an HTML page or a non-envelope proves nothing", async () => {
    let answer: () => Response = () => json({ message: "boom" }, 503);
    const { client } = serve(() => answer());
    await expect(client.info()).rejects.toBeInstanceOf(ProviderUnavailableError);
    // 1.x routes on a 2.x server answer the bundled web app's page.
    answer = () => new Response("<html></html>", { headers: { "content-type": "text/html" } });
    await expect(client.info()).rejects.toThrow("not the OpenCode 2.x API");
    answer = () => json({ version: "2.2.6" });
    await expect(client.info()).rejects.toThrow("not a 2.x envelope");
  });

  test("204 answers resolve without a body", async () => {
    const { client, seen } = serve(() => new Response(null, { status: 204 }));
    await expect(client.withdrawInput("ses_1", "msg_x")).resolves.toBeUndefined();
    expect(seen[0]).toMatchObject({ method: "DELETE", path: "/api/session/ses_1/inbox/msg_x" });
  });

  test("interrupt reports whether a run was interrupted", async () => {
    const { client, seen } = serve(() => json({ data: { interrupted: true } }));
    await expect(client.interrupt("ses_1", { resume: false })).resolves.toBe(true);
    expect(seen[0]!.search).toBe("?resume=false");
  });

  test("permission and form replies use the 2.x shapes", async () => {
    const { client, seen } = serve(() => new Response(null, { status: 204 }));
    await client.replyPermission("ses_1", "per_1", "reject");
    await client.replyForm("ses_1", "frm_1", { q: "yes" });
    await client.rejectForm("ses_1", "frm_2", "dismissed");
    expect(seen.map((entry) => [entry.method, entry.path + entry.search, entry.body])).toEqual([
      ["POST", "/api/session/ses_1/permission/per_1/reply", { decision: "reject" }],
      ["POST", "/api/session/ses_1/form/frm_1/reply", { answer: { q: "yes" } }],
      ["DELETE", "/api/session/ses_1/form/frm_2?message=dismissed", undefined],
    ]);
  });

  test("the event stream must be an event stream", async () => {
    const { client } = serve(() => json({ data: [] }));
    await expect(client.openEvents(new AbortController().signal)).rejects.toThrow(
      "not an event stream",
    );
  });
});

describe("readBoundedJson", () => {
  test("refuses a body past its bound, declared or streamed", async () => {
    const declared = new Response("{}", { headers: { "content-length": "999999" } });
    await expect(readBoundedJson(declared, "read", 10)).rejects.toThrow("oversized");
    const streamed = new Response(JSON.stringify({ text: "x".repeat(100) }));
    await expect(readBoundedJson(streamed, "read", 10)).rejects.toThrow("oversized");
    await expect(readBoundedJson(new Response("{nope"), "read")).rejects.toThrow("malformed");
  });
});
