/**
 * A real bridge process, killed without a chance to flush.
 *
 * The in-process durability suites prove the published file is correct; this
 * one proves the acknowledgement contract survives the thing it exists for: a
 * `SIGKILL` straight after the acknowledgements, with no graceful shutdown and
 * no drain. A fresh process on the same state directory must recover the
 * session id, its client key and the composer selection.
 *
 * The child runs the production entry point from source with a private state
 * directory, a private HOME and credential file (so no stored Cursor login is
 * read and nothing can authenticate), a random port and a random token. Only
 * the processes this test spawned are ever signalled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "index.ts");
const PACKAGE_DIR = resolve(import.meta.dir, "..");
const STARTUP_TIMEOUT_MS = 30_000;
const policy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
} as const;

interface Bridge {
  child: ChildProcess;
  port: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const spawned: Bridge[] = [];
const temporary: string[] = [];

afterEach(async () => {
  // Only this test's own children, and only if they are still running.
  for (const bridge of spawned.splice(0)) {
    if (bridge.child.exitCode === null && bridge.child.signalCode === null) {
      bridge.child.kill("SIGKILL");
      await bridge.exited;
    }
  }
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function startBridge(root: string, token: string): Promise<Bridge> {
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PACKAGE_DIR,
    // A minimal environment: nothing ambient can supply a credential.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      CWD: join(root, "workspace"),
      CURSOR_BRIDGE_TOKEN: token,
      CURSOR_BRIDGE_STATE_DIR: join(root, "state"),
      CURSOR_BRIDGE_AUTH_FILE: join(root, "home", "no-auth.json"),
      // The bridge's own watchdog: if this test runner dies, the child follows.
      ORKESTRATOR_PARENT_PID: String(process.pid),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Bounded, and only for a failure message: the child logs no prompt here.
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4_096) stderr += chunk.toString("utf8").slice(0, 4_096 - stderr.length);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  const bridge = { child, port, exited };
  spawned.push(bridge);

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `bridge exited during startup (${child.exitCode ?? child.signalCode}): ${stderr}`,
      );
    }
    const healthy = await Bun.fetch(`http://127.0.0.1:${port}/global/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (healthy) return bridge;
    await Bun.sleep(50);
  }
  throw new Error(`bridge did not become healthy within ${STARTUP_TIMEOUT_MS}ms: ${stderr}`);
}

function call(bridge: Bridge, token: string, path: string, body?: unknown): Promise<Response> {
  return Bun.fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("process kill after acknowledgement", () => {
  test(
    "SIGKILL right after create and config acknowledgements loses nothing acknowledged",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "cursor-bridge-process-"));
      temporary.push(root);
      for (const name of ["home", "workspace", "state"]) await mkdir(join(root, name));
      const token = randomBytes(24).toString("base64url");

      const first = await startBridge(root, token);
      const created = await call(first, token, "/session/create", {
        policy,
        clientSessionKey: "process-tab",
        modelId: "model-at-create",
      });
      expect(created.status).toBe(201);
      const { sessionId } = (await created.json()) as { sessionId: string };
      const configured = await call(first, token, `/session/${sessionId}/config`, {
        modelId: "model-after-create",
        mode: "plan",
      });
      expect(configured.status).toBe(200);
      expect(await configured.json()).toMatchObject({
        selectedModelId: "model-after-create",
        selectedModeId: "plan",
      });

      // Checkpoint: both acknowledgements are in hand. Kill the exact child
      // now — no SIGTERM, so no drain and no final write.
      expect(first.child.kill("SIGKILL")).toBe(true);
      const death = await first.exited;
      // Reported on its own: a process that died some other way is a fixture
      // problem, not a durability finding.
      expect({ killedBy: death.signal }).toEqual({ killedBy: "SIGKILL" });

      const second = await startBridge(root, token);
      const composer = await call(second, token, `/session/${sessionId}/config`);
      expect(composer.status).toBe(200);
      expect(await composer.json()).toMatchObject({
        selectedModelId: "model-after-create",
        selectedModeId: "plan",
      });
      const again = await call(second, token, "/session/create", {
        policy,
        clientSessionKey: "process-tab",
      });
      expect(again.status).toBe(201);
      expect(((await again.json()) as { sessionId: string }).sessionId).toBe(sessionId);
    },
    { timeout: 2 * STARTUP_TIMEOUT_MS + 10_000 },
  );
});
