import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(() => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve test port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  let latest!: T;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ACP state: ${JSON.stringify(latest)}`);
}

describe("ACP bridge", () => {
  test("drives an ACP session and rehydrates a parked permission", async () => {
    const port = await unusedPort();
    const token = "integration-test-token";
    const child = spawn(process.execPath, [resolve(here, "index.ts")], {
      cwd: resolve(here, "../../.."),
      env: {
        ...process.env,
        ACP_PROVIDER: "cursor",
        ACP_AGENT_PATH: resolve(here, "testing/fake-agent.ts"),
        ACP_BRIDGE_TOKEN: token,
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    const base = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => fetch(`${base}/global/health`).then((response) => response.ok).catch(() => false),
      Boolean,
    );

    const unauthorized = await fetch(`${base}/session/create`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const createdResponse = await fetch(`${base}/session/create`, { method: "POST", headers });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string };

    const promptResponse = await fetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Do the work" }),
    });
    expect(promptResponse.status).toBe(202);
    const approval = await waitFor(
      async () => fetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: Array<{ id: string; approvalId: string; title: string; kind: string }> }>,
      (value) => value.approvals.length === 1,
    );
    expect(approval.approvals[0]?.title).toBe("Run safe command");
    expect(approval.approvals[0]).toMatchObject({
      approvalId: approval.approvals[0]!.id,
      kind: "permissions",
    });

    const resolveResponse = await fetch(
      `${base}/session/${created.id}/approvals/${approval.approvals[0]!.id}`,
      { method: "POST", headers, body: JSON.stringify({ decision: "approve" }) },
    );
    expect(resolveResponse.ok).toBe(true);
    const session = await waitFor(
      async () => fetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string; messages: Array<{ content: string; parts: unknown[] }> }>,
      (value) => value.status === "idle",
    );
    expect(session.messages.map((message) => message.content)).toEqual(["Do the work", "approved:once"]);
    expect(session.messages[1]?.parts).toEqual([
      { type: "reasoning", text: "Checking permission. " },
      { type: "text", text: "approved:once" },
    ]);
  });
});
