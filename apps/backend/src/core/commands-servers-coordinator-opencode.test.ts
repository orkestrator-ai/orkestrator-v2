import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { stopLocalServerUnlocked } from "./commands-local-server-lifecycle.js";
import { readLocalServerStatus, startLocalServerUnlocked } from "./commands-servers.js";
import { __testing as commandTesting } from "./commands-testing.js";
import { CoordinatorService } from "./coordinator-service.js";
import { runCommand } from "./shell.js";
import { createProject, StorageService } from "./storage.js";

/**
 * An OpenCode coordinator's `orkestrator` MCP entry is its scoped Control MCP
 * credential, the only route to its delegation tools. These start a real
 * (fake) `opencode serve` that records each MCP configuration it is sent.
 */
describe("Coordinator OpenCode server", () => {
  const SCOPED_URL = "http://127.0.0.1:1234/mcp";
  const TAB_URL = "http://127.0.0.1:4321/agent-tools";
  let root: string;
  let storage: StorageService;
  let cleanup: { context: CommandContext; runtimeId: string } | null = null;

  beforeEach(async () => {
    commandTesting.resetLocalServerLifecycle();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-coordinator-opencode-")));
    const checkout = path.join(root, "checkout");
    await fs.mkdir(checkout);
    await runCommand("git", ["init", "-b", "main"], { cwd: checkout });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
    await runCommand("git", ["config", "user.name", "Coordinator Test"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "README.md"), "initial\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: checkout });
    await fs.mkdir(path.join(root, "managed-bin"));
    await fs.writeFile(path.join(root, "mode"), "ok\n");
    await fs.writeFile(
      path.join(root, "managed-bin", "opencode"),
      `#!${process.execPath}
const fs = require("node:fs");
const root = ${JSON.stringify(root)};
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" && request.method === "POST") {
      const body = await request.json();
      fs.appendFileSync(root + "/mcp-posts.jsonl", JSON.stringify({ url: body.config.url }) + "\\n");
      if (fs.readFileSync(root + "/mode", "utf8").trim() === "fail") {
        return new Response("refused", { status: 500 });
      }
      return Response.json({ [body.name]: { status: "connected" } });
    }
    return Response.json({ healthy: true });
  },
});
process.on("SIGTERM", () => process.exit(0));
`,
      { mode: 0o755 },
    );
    storage = new StorageService(path.join(root, "data"));
    await storage.init();
  });

  afterEach(async () => {
    if (cleanup) {
      await stopLocalServerUnlocked(cleanup.runtimeId, cleanup.context, "opencode").catch(
        () => undefined,
      );
      cleanup = null;
    }
    commandTesting.resetLocalServerLifecycle();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function coordinatorContext() {
    const project = await storage.addProject(createProject("remote", path.join(root, "checkout")));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "opencode");
    const settings = { enabled: true, running: true, url: SCOPED_URL, token: "", error: null };
    const tabConnection = mock(() => ({ url: TAB_URL, token: "tab-token" }));
    const context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      toolchainBinDir: path.join(root, "managed-bin"),
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime: new BackendRuntime({ emit: () => undefined }),
      // Present, as in production: an ordinary environment's ticket tools.
      agentTools: { connection: tabConnection } as unknown as CommandContext["agentTools"],
      controlMcp: {
        getSettings: () => settings,
        rotateToken: async () => settings,
        issueCoordinatorCredential: mock(() => ({ url: SCOPED_URL, token: "scoped-token" })),
        revokeCoordinatorCredentials: mock(() => undefined),
      },
    } as unknown as CommandContext;
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    cleanup = { context, runtimeId };
    return { context, runtimeId, tabConnection };
  }

  async function posted(): Promise<string[]> {
    const text = await fs.readFile(path.join(root, "mcp-posts.jsonl"), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { url: string }).url);
  }

  test("starts only once its Control MCP is connected, and keeps it on every later reconcile", async () => {
    const { context, runtimeId, tabConnection } = await coordinatorContext();

    const started = await startLocalServerUnlocked(runtimeId, context, "opencode");
    expect(started.wasRunning).toBe(false);
    // Awaited, not merely scheduled: the first turn may follow at once.
    expect(await posted()).toEqual([SCOPED_URL]);
    expect(commandTesting.openCodeAgentToolsState(`local:${runtimeId}`)).toBe("connected");

    // Expire the memo so the healthy-reuse and status paths both re-POST.
    commandTesting.setOpenCodeAgentToolsMemoWindowsMs(0, 0);
    const reused = await startLocalServerUnlocked(runtimeId, context, "opencode");
    expect(reused.wasRunning).toBe(true);
    await readLocalServerStatus(runtimeId, context, "opencode");
    for (let attempt = 0; attempt < 200 && (await posted()).length < 3; attempt += 1) {
      await Bun.sleep(10);
    }
    const urls = await posted();
    expect(urls.length).toBeGreaterThanOrEqual(3);
    // Never the tab credential: it would leave the coordinator with mail and
    // ticket tools but none of its delegation tools.
    expect(new Set(urls)).toEqual(new Set([SCOPED_URL]));
    expect(tabConnection).not.toHaveBeenCalled();
  });

  test("a coordinator whose Control MCP will not connect fails to start", async () => {
    const { context, runtimeId } = await coordinatorContext();
    await fs.writeFile(path.join(root, "mode"), "fail\n");
    commandTesting.setOpenCodeAgentToolsRetryDelaysMs([]);

    await expect(startLocalServerUnlocked(runtimeId, context, "opencode")).rejects.toThrow(
      "The OpenCode coordinator could not connect its Orkestrator tools",
    );
    expect(commandTesting.getLocalServerProcess(`opencode:${runtimeId}`)).toBeUndefined();
  });
});
