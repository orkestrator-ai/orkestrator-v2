import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { publicSuccessEnvelope } from "@orkestrator/protocol/public-api";
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
