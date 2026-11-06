import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BRIDGE_AUTHORITY_HEADER,
  mintBridgeAuthorityKeyPair,
  signBridgeRequest,
} from "@orkestrator/protocol/node/bridge-authority";

// A real SDK tool, faux model and HTTP router; no provider credentials or billing.
test("launcher snapshot reaches Pi and only a signed answer releases a pending tool", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-signed-approval-"));
  const authority = mintBridgeAuthorityKeyPair();
  const token = "signed-approval-test-token";
  const snapshot = join(directory, "environment");
  const address = join(directory, "address");
  const marker = join(directory, "approved");
  const entry = resolve(import.meta.dir, "container-fake-engine-server.ts");
  const server = resolve(import.meta.dir, "../server.ts");
  const wrapper = join(directory, "start.ts");
  writeFileSync(
    snapshot,
    Object.entries({
      PI_AGENT_DIR: join(directory, "agent"),
      PI_CODING_AGENT_DIR: join(directory, "agent"),
      PI_SESSION_DIR: join(directory, "sessions"),
      PI_BRIDGE_STATE_DIR: join(directory, "state"),
      FAKE_PI_ROOT: join(directory, "fake"),
      CWD: directory,
      PORT: "0",
      HOSTNAME: "127.0.0.1",
      PI_OFFLINE: "1",
    })
      .map(([key, value]) => `${key}=${value}\0`)
      .join(""),
  );
  writeFileSync(
    wrapper,
    `import { writeFileSync } from "node:fs";
await import(${JSON.stringify(entry)});
const { server } = await import(${JSON.stringify(server)});
writeFileSync(${JSON.stringify(address)}, String(server.address().port));`,
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", wrapper], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      NODE_ENV: "test",
      PI_BRIDGE_TOKEN: token,
      PI_BRIDGE_TOKEN_AUTHORITY_KEY: authority.publicKey,
      ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT: snapshot,
      ORKESTRATOR_BRIDGE_LAUNCH_KEYS: "PI_BRIDGE_TOKEN,PI_BRIDGE_TOKEN_AUTHORITY_KEY",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  // Drain continuously so a failed startup cannot block on a full stderr pipe.
  let diagnostic = "";
  const drain = (async () => {
    for await (const chunk of child.stderr) {
      diagnostic = (diagnostic + Buffer.from(chunk).toString()).slice(-4096);
    }
  })();
  const until = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 20_000;
    while (!(await condition())) {
      if (child.exitCode !== null) throw new Error(`Fixture exited: ${diagnostic}`);
      if (Date.now() > deadline) throw new Error("Timed out waiting for Pi fixture state");
      await Bun.sleep(20);
    }
  };
  try {
    await until(() => existsSync(address));
    expect(existsSync(snapshot)).toBe(false);
    const origin = `http://127.0.0.1:${readFileSync(address, "utf8")}`;
    const call = (path: string, body?: string, signature?: string) =>
      Bun.fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        body,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(signature ? { [BRIDGE_AUTHORITY_HEADER]: signature } : {}),
        },
      });
    const signed = (path: string, body: string) =>
      call(
        path,
        body,
        signBridgeRequest(authority.privateKey, { method: "POST", url: path, body }),
      );
    const created = await signed(
      "/session/create",
      JSON.stringify({
        model: "faux/faux-1",
        policy: {
          id: "interactive-host",
          sandbox: "none",
          approvals: "ask",
          projectResources: false,
          networkAccess: "restricted",
        },
      }),
    );
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string };
    const prompt = await signed(
      `/session/${session.id}/prompt`,
      JSON.stringify({
        prompt: `BASH: touch ${marker}`,
        requestId: "signed-tool-test",
      }),
    );
    expect(prompt.ok).toBe(true);
    const approvals = async () => {
      const response = await call(`/session/${session.id}/approvals`);
      expect(response.status).toBe(200);
      const result = (await response.json()) as { approvals: Array<{ approvalId: string }> };
      return result.approvals;
    };
    let pending: Array<{ approvalId: string }> = [];
    await until(async () => {
      pending = await approvals();
      return pending.length === 1;
    });
    expect(existsSync(marker)).toBe(false);
    const path = `/session/${session.id}/approvals/${pending[0]!.approvalId}`;
    const body = JSON.stringify({ decision: "approve" });
    expect((await call(path, body)).status).toBe(403);
    const signature = signBridgeRequest(authority.privateKey, { method: "POST", url: path, body });
    expect((await call(path, JSON.stringify({ decision: "deny" }), signature)).status).toBe(403);
    expect((await approvals()).length).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect((await call(path, body, signature)).status).toBe(200);
    expect((await call(path, body, signature)).status).toBe(403);
    expect((await signed(path, body)).status).toBe(404);
    await until(() => existsSync(marker));
    await until(async () => (await approvals()).length === 0);
  } finally {
    child.kill();
    await child.exited;
    await drain;
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
