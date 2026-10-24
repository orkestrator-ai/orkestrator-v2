import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentToolsServer,
  CLAUDE_STATE_SIGNAL_PATH,
  WORKTREE_SIGNAL_PATH,
  type WorktreeSignalReason,
} from "./agent-tools.js";
import { OrkestratorBackend } from "./index.js";
import type { CommandContext } from "./commands-context.js";
import { StorageService } from "./storage.js";

describe("Claude state signal route", () => {
  let dataDir: string;
  let server: AgentToolsServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-state-signal-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    server = new AgentToolsServer(storage, "127.0.0.1");
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** The issued URL names the container's host alias; the test reaches it on loopback. */
  function loopback(url: string): string {
    const parsed = new URL(url);
    parsed.hostname = "127.0.0.1";
    return parsed.toString();
  }

  function ring(url: string, token: string, init: RequestInit = {}): Promise<Response> {
    return fetch(loopback(url), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      ...init,
    });
  }

  test("production command context exposes the live server's state credential issuer", async () => {
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: server,
    });
    try {
      const context = (backend as unknown as { context: CommandContext }).context;
      let rings = 0;
      const credential = context.agentTools?.issueStateSignal?.(() => {
        rings += 1;
      });
      expect(credential).toBeTruthy();
      expect((await ring(credential!.url, credential!.token)).status).toBe(204);
      expect(rings).toBe(1);
      credential!.revoke();
      expect((await ring(credential!.url, credential!.token)).status).toBe(401);
    } finally {
      await backend.shutdown();
    }
  });

  test("issues a container URL only once the server listens", async () => {
    const stopped = new AgentToolsServer(new StorageService(dataDir), "127.0.0.1");
    expect(stopped.issueStateSignal(() => undefined)).toBeNull();

    const credential = server.issueStateSignal(() => undefined)!;
    const url = new URL(credential.url);
    expect(url.hostname).toBe("host.docker.internal");
    expect(url.port).toBe(String(server.servicePort()));
    expect(url.pathname).toBe(CLAUDE_STATE_SIGNAL_PATH);
    expect(credential.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("rings exactly the credential's receiver and ignores any body", async () => {
    const rings: string[] = [];
    const first = server.issueStateSignal(() => rings.push("first"))!;
    const second = server.issueStateSignal(() => rings.push("second"))!;

    const response = await ring(first.url, first.token, { body: "state=working" });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rings).toEqual(["first"]);

    expect((await ring(second.url, second.token)).status).toBe(204);
    expect(rings).toEqual(["first", "second"]);
  });

  test("refuses unknown, revoked and MCP credentials, and other methods", async () => {
    const rings: number[] = [];
    const credential = server.issueStateSignal(() => rings.push(1))!;
    const mcp = server.connection("env-1", "project-1", "container");

    expect((await ring(credential.url, "x".repeat(43))).status).toBe(401);
    expect((await ring(credential.url, mcp.token)).status).toBe(401);
    const get = await fetch(loopback(credential.url), {
      headers: { Authorization: `Bearer ${credential.token}` },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    credential.revoke();
    expect((await ring(credential.url, credential.token)).status).toBe(401);
    expect(rings).toEqual([]);
  });

  test("a doorbell credential opens no MCP tools", async () => {
    const credential = server.issueStateSignal(() => undefined)!;
    const mcpUrl = new URL(loopback(credential.url));
    mcpUrl.pathname = "/mcp";
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        Accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  test("a revoke from a replaced credential does not drop its successor", async () => {
    const rings: string[] = [];
    const old = server.issueStateSignal(() => rings.push("old"))!;
    const current = server.issueStateSignal(() => rings.push("current"))!;
    old.revoke();
    old.revoke();
    expect((await ring(current.url, current.token)).status).toBe(204);
    expect(rings).toEqual(["current"]);
  });

  test("a worktree credential rings only its own route and reports its reason", async () => {
    const reasons: WorktreeSignalReason[] = [];
    let claudeRings = 0;
    const worktree = server.issueWorktreeSignal((reason) => reasons.push(reason))!;
    const claude = server.issueStateSignal(() => {
      claudeRings += 1;
    })!;
    expect(new URL(worktree.url).pathname).toBe(WORKTREE_SIGNAL_PATH);

    const send = (url: string, token: string, reason?: string) =>
      ring(url, token, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(reason === undefined ? {} : { "X-Orkestrator-Signal": reason }),
        },
      });
    expect((await send(worktree.url, worktree.token, "ready")).status).toBe(204);
    expect((await send(worktree.url, worktree.token, "overflow")).status).toBe(204);
    expect((await send(worktree.url, worktree.token, "lost")).status).toBe(204);
    // Anything unrecognised (or absent) only ever asks for a rescan.
    expect((await send(worktree.url, worktree.token, "trust-me")).status).toBe(204);
    expect((await send(worktree.url, worktree.token)).status).toBe(204);
    expect(reasons).toEqual(["ready", "overflow", "lost", "change", "change"]);

    // Neither credential opens the other's route.
    expect((await send(claude.url, worktree.token)).status).toBe(401);
    expect((await send(worktree.url, claude.token)).status).toBe(401);
    expect(claudeRings).toBe(0);
    expect(reasons).toHaveLength(5);
  });

  test("stopping the server forgets every doorbell", async () => {
    const credential = server.issueStateSignal(() => undefined)!;
    await server.stop();
    await server.start();
    const fresh = server.issueStateSignal(() => undefined)!;
    expect((await ring(fresh.url, credential.token)).status).toBe(401);
  });
});
