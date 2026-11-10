import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { GatewayTransport } from "../src/client/transport.js";
import { ClientSession } from "../src/client/session.js";
import { LocalReceiptStore } from "../src/client/receipts.js";
import { publicErrorEnvelope, publicSuccessEnvelope } from "@orkestrator/protocol/public-api";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  capabilities,
  createSandbox,
  defaultResponder,
  envelope,
  json,
  startFakeGateway,
  TOKEN,
  type ClientSandbox,
  type FakeGateway,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  respond = defaultResponder(),
): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox();
  const gateway = await startFakeGateway(respond);
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  // The descriptor still pins the installation identity for every response.
  const added = await box.run([
    "connection",
    "add",
    "local",
    "--data-dir",
    dataDir,
    "--default",
    "--no-check",
  ]);
  expect(added.code).toBe(0);
  gateway.requests.length = 0;
  return { box, gateway };
}

describe("authenticated transport", () => {
  test("rejects an already aborted request without fetching", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const transport = new GatewayTransport(
      {
        baseUrl: "http://127.0.0.1:1",
        identity: { name: "test", kind: "connection", endpoint: "test" },
        readToken: async () => TOKEN,
      },
      async () => {
        calls += 1;
        throw new Error("unexpected fetch");
      },
      20,
    );
    await expect(
      transport.invoke("x", {}, { mutation: true, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "connection-failed" });
    expect(calls).toBe(0);
  });

  test("credential rotation cannot restart an observation request's exhausted budget", async () => {
    let now = 1000;
    let calls = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const transport = new GatewayTransport(
        {
          baseUrl: "http://127.0.0.1:1",
          identity: { name: "test", kind: "connection", endpoint: "test" },
          readToken: async () => TOKEN,
        },
        async () => {
          calls += 1;
          now += 101;
          return calls === 1 ? new Response(null, { status: 401 }) : json({ result: null });
        },
      );
      await expect(
        transport.invoke("x", {}, { mutation: false, timeoutMs: 100 }),
      ).rejects.toMatchObject({ code: "connection-failed" });
      expect(calls).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("decodes a body read once, whether it arrives in one chunk or several", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ result: { text: "é".repeat(64) } }));
    for (const cuts of [[], [1, 7, 40]]) {
      const transport = new GatewayTransport(
        {
          baseUrl: "http://127.0.0.1:1",
          identity: { name: "test", kind: "connection", endpoint: "test" },
          readToken: async () => TOKEN,
        },
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                // Cut through a multi-byte character to prove nothing decodes per chunk.
                let from = 0;
                for (const to of [...cuts, payload.byteLength]) {
                  controller.enqueue(payload.slice(from, to));
                  from = to;
                }
                controller.close();
              },
            }),
          ),
      );
      // Count readers across all streams, including any replacement Response.
      // The former read -> new Response -> read path acquires two readers.
      const readers = spyOn(ReadableStream.prototype, "getReader");
      try {
        expect(await transport.invoke("x", {}, { mutation: false })).toEqual({
          text: "é".repeat(64),
        });
        expect(readers).toHaveBeenCalledTimes(1);
      } finally {
        readers.mockRestore();
      }
    }
  });

  test("a refused answer's body is cancelled, not read", async () => {
    let pulled = 0;
    let cancelled = false;
    const transport = new GatewayTransport(
      {
        baseUrl: "http://127.0.0.1:1",
        identity: { name: "test", kind: "connection", endpoint: "test" },
        readToken: async () => TOKEN,
      },
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 403 },
        ),
    );
    await expect(transport.invoke("x", {}, { mutation: true })).rejects.toMatchObject({
      code: "auth-failed",
    });
    expect(cancelled).toBe(true);
    // The stream may prefill its queue once; the client never drains it.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  test("a safe read cancels a 401 body before refreshing its token and retrying once", async () => {
    let pulled = 0;
    let tokenReads = 0;
    const events: string[] = [];
    const authorizations: Array<string | null> = [];
    const transport = new GatewayTransport(
      {
        baseUrl: "http://127.0.0.1:1",
        identity: { name: "test", kind: "connection", endpoint: "test" },
        readToken: async () => {
          tokenReads += 1;
          events.push(`token-${tokenReads}`);
          return tokenReads === 1 ? "expired-token" : "rotated-token";
        },
      },
      async (_url, init) => {
        authorizations.push(new Headers(init.headers).get("authorization"));
        events.push(`fetch-${authorizations.length}`);
        if (authorizations.length === 2) return json({ result: { retried: true } });
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(1024));
              },
              cancel() {
                events.push("cancel-401");
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 401 },
        );
      },
    );
    expect(await transport.invoke("x", {}, { mutation: false })).toEqual({ retried: true });
    expect(authorizations).toEqual(["Bearer expired-token", "Bearer rotated-token"]);
    expect(events).toEqual(["token-1", "fetch-1", "cancel-401", "token-2", "fetch-2"]);
    expect(pulled).toBe(0);
  });

  test("request deadline includes a body stalled after headers", async () => {
    const transport = new GatewayTransport(
      {
        baseUrl: "http://127.0.0.1:1",
        identity: { name: "test", kind: "connection", endpoint: "test" },
        readToken: async () => TOKEN,
      },
      async () => new Response(new ReadableStream({ start() {} })),
      20,
    );
    await expect(transport.invoke("x", {}, { mutation: true })).rejects.toMatchObject({
      code: "transport-uncertain",
    });
  });

  test("caller abort interrupts a body stalled after headers", async () => {
    const controller = new AbortController();
    const transport = new GatewayTransport(
      {
        baseUrl: "http://127.0.0.1:1",
        identity: { name: "test", kind: "connection", endpoint: "test" },
        readToken: async () => TOKEN,
      },
      async () => new Response(new ReadableStream({ start() {} })),
      60_000,
    );
    const pending = transport.invoke("x", {}, { mutation: true, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: "transport-uncertain" });
  });

  test("abort during receipt persistence prevents mutation send", async () => {
    const controller = new AbortController();
    let calls = 0;
    class AbortingReceipts extends LocalReceiptStore {
      override async save() {
        controller.abort();
      }
    }
    const session = new ClientSession(
      {
        baseUrl: "http://127.0.0.1:1",
        identity: { name: "test", kind: "connection", endpoint: "test" },
        readToken: async () => TOKEN,
      },
      new AbortingReceipts("/unused"),
      {
        signal: controller.signal,
        fetchImpl: async () => {
          calls += 1;
          return envelope(publicSuccessEnvelope("capabilities", capabilities()));
        },
      },
    );
    await expect(
      session.mutate(
        "project.add",
        { remote: "https://example.invalid/a.git" },
        "abort-after-save",
      ),
    ).rejects.toMatchObject({ code: "connection-failed" });
    expect(calls).toBe(1);
  });
  test("sends the bearer token in a header only, and never prints it", async () => {
    const { box, gateway } = await fixture();
    const result = await box.run(["--json", "project", "list"]);
    expect(result.code).toBe(0);
    expect(gateway.requests[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(gateway.requests[0]!.body.command).toBe("public_action");
    expect(result.out + result.err).not.toContain(TOKEN);
    const connection = JSON.parse(result.out).connection;
    expect(connection).toMatchObject({
      name: "local",
      kind: "connection",
      installationId: "install-a",
    });
    expect(connection.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("refuses redirects instead of following them with credentials", async () => {
    const { box, gateway } = await fixture(
      () => new Response(null, { status: 307, headers: { location: "http://example.invalid/" } }),
    );
    const result = await box.run(["--json", "project", "list"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.message).toContain("redirect");
    expect(gateway.requests).toHaveLength(1);
  });

  test("bounds the decoded response", async () => {
    const { box } = await fixture(() => json({ result: "x".repeat(9 * 1024 * 1024) }));
    const result = await box.run(["--json", "project", "list"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.code).toBe("response-invalid");
  });

  test("an answer from a different installation is an identity mismatch", async () => {
    const { box } = await fixture((request) =>
      envelope(
        publicSuccessEnvelope(String(request.body.args.action), { items: [], total: 0 }),
        "install-other",
      ),
    );
    const result = await box.run(["--json", "project", "list"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.code).toBe("identity-mismatch");
  });

  test("a backend without the public contract is incompatible, not a failure to classify", async () => {
    const { box } = await fixture(() =>
      json({ error: "Unknown backend command: public_action" }, 500),
    );
    const result = await box.run(["--json", "project", "list"]);
    expect(JSON.parse(result.out).error.code).toBe("backend-incompatible");
    expect(result.code).toBe(8);
  });

  test("an unadvertised mutation is refused before any mutation request is sent", async () => {
    const { box, gateway } = await fixture(
      defaultResponder({
        capabilities: publicSuccessEnvelope(
          "capabilities",
          capabilities({
            actions: {
              capabilities: { version: 1, available: true },
              "project.add": { version: 1, available: false, reason: "disabled" },
            },
          }),
        ),
      }),
    );
    const result = await box.run([
      "--json",
      "project",
      "add",
      "--remote",
      "https://example.invalid/r.git",
    ]);
    expect(result.code).toBe(8);
    expect(JSON.parse(result.out).error.code).toBe("capability-unavailable");
    expect(gateway.requests.map((request) => request.body.args.action)).toEqual(["capabilities"]);
  });

  test("HTTP 200 carrying a rejected dispatch is not success", async () => {
    const { box } = await fixture(
      defaultResponder({
        "session.prompt": {
          schemaVersion: 1,
          action: "session.prompt",
          ok: false,
          error: { code: "dispatch-unknown", message: "maybe", exitCode: 7 },
        },
      }),
    );
    const result = await box.run(["--json", "session", "prompt", "ses_eA", "--prompt", "hello"]);
    expect(result.code).toBe(7);
  });

  test("a transient prompt refusal keeps exit 1 and says it is retryable", async () => {
    // 7260: a bridge's 503 before dispatch sent nothing, so a new key may succeed.
    const { box } = await fixture(
      defaultResponder({
        "session.prompt": publicErrorEnvelope("session.prompt", {
          code: "operation-failed",
          message: "claude prompt dispatch is temporarily unavailable (HTTP 503)",
          retryable: true,
        }),
      }),
    );
    const result = await box.run(["--json", "session", "prompt", "ses_eA", "--prompt", "hello"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).error).toMatchObject({
      code: "operation-failed",
      exitCode: 1,
      retryable: true,
    });
  });

  test("an in-progress mutation receipt does not dereference an empty result", async () => {
    const { box } = await fixture(
      defaultResponder({
        "project.add": publicErrorEnvelope(
          "project.add",
          { code: "busy", message: "The operation is still in progress", retryable: true },
          PUBLIC_API_FIXTURES.runCompleted.receipt,
        ),
      }),
    );
    const result = await box.run([
      "--json",
      "project",
      "add",
      "--remote",
      "https://example.invalid/a.git",
    ]);
    expect(result.code).toBe(8);
    const output = JSON.parse(result.out);
    expect(output.error.code).toBe("busy");
    expect(output.receipt).toBeDefined();
  });
});

describe("request keys and local receipts", () => {
  test("saves a private receipt before sending and keeps the key on a lost response", async () => {
    let calls = 0;
    const { box, gateway } = await fixture((request) => {
      if (request.body.args.action === "capabilities")
        return envelope(publicSuccessEnvelope("capabilities", capabilities()));
      calls += 1;
      // Admission may have happened; the response is lost.
      return new Response("not json", { status: 502 });
    });
    const result = await box.run([
      "--json",
      "project",
      "add",
      "--remote",
      "https://example.invalid/r.git",
      "--request-id",
      "lost-1",
    ]);
    expect(result.code).toBe(4);
    const error = JSON.parse(result.out).error;
    expect(error.code).toBe("transport-uncertain");
    expect(error.details).toMatchObject({ requestId: "lost-1" });
    expect(calls).toBe(1);
    const mutation = gateway.requests.find(
      (request) => request.body.args.action === "project.add",
    )!;
    expect(mutation.body.args.request).toMatchObject({ requestId: "lost-1" });
    const receiptsDir = path.join(box.configDir, "receipts", "install-a");
    const files = await readdir(receiptsDir);
    expect(files).toHaveLength(1);
    const saved = JSON.parse(await readFile(path.join(receiptsDir, files[0]!), "utf8"));
    expect(saved).toMatchObject({ requestId: "lost-1", action: "project.add" });
    expect(JSON.stringify(saved)).not.toContain("example.invalid");
    expect((await stat(path.join(receiptsDir, files[0]!))).mode & 0o077).toBe(0);
    // The listing shows it as sent without a response; nothing resubmits it.
    const listed = await box.run(["--json", "run", "receipts"]);
    expect(JSON.parse(listed.out).result.items[0]).toMatchObject({ requestId: "lost-1" });
    expect(calls).toBe(1);
  });

  test("replaying a key reuses the namespace recorded in its local receipt", async () => {
    const namespaces: unknown[] = [];
    const { box } = await fixture((request) => {
      if (request.body.args.action === "capabilities")
        return envelope(publicSuccessEnvelope("capabilities", capabilities()));
      namespaces.push((request.body.args.request as { namespace?: string }).namespace);
      return envelope(publicSuccessEnvelope("project.add", { project: { id: "p" } }));
    });
    await box.run([
      "project",
      "add",
      "--remote",
      "https://example.invalid/r.git",
      "--request-id",
      "ns-1",
    ]);
    await box.run([
      "project",
      "add",
      "--remote",
      "https://example.invalid/r.git",
      "--request-id",
      "ns-1",
    ]);
    expect(namespaces).toHaveLength(2);
    expect(namespaces[0]).toBe(namespaces[1]);
  });

  test("rejects malformed request IDs locally", async () => {
    const { box, gateway } = await fixture();
    const result = await box.run([
      "--json",
      "project",
      "add",
      "--remote",
      "https://example.invalid/r.git",
      "--request-id",
      "has space",
    ]);
    expect(result.code).toBe(2);
    expect(
      gateway.requests.filter((request) => request.body.args.action === "project.add"),
    ).toHaveLength(0);
  });
});
