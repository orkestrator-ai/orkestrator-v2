/**
 * The approval gate with the gate actually on.
 *
 * `interactions.test.ts` exercises the parked-approval machinery directly,
 * because the default is off. This file turns the gate on, so the paths it
 * covers are the ones only `requestToolApproval` itself can take: the
 * read-only bypass, the pending cap, and the timeout — every one of which must
 * deny rather than approve.
 *
 * The gate is read per call rather than at import, so this holds whatever
 * order the suite happens to load these modules in. The timeout is not: it is
 * set before the dynamic import below, and lowered only so a test can prove
 * the denial without waiting five minutes.
 */
import { describe, expect, test } from "bun:test";

process.env.PI_BRIDGE_REQUIRE_APPROVAL = "1";
process.env.PI_BRIDGE_APPROVAL_TIMEOUT_MS = "1000";

const { requestToolApproval, resolveApproval } = await import("./interactions.js");
const { newSessionState } = await import("./agent-session.js");
const { MAX_PENDING_APPROVALS } = await import("./config.js");

describe("requestToolApproval with the gate on", () => {
  test("parks a mutating call and applies the answer it is given", async () => {
    const state = newSessionState();
    const decision = requestToolApproval(state, "call-1", "bash", { command: "rm -rf build" });

    // Parked, and visible to the rehydration route before anything answers.
    expect(state.approvals.size).toBe(1);
    const [id] = [...state.approvals.keys()];
    expect(resolveApproval(state, id!, "allow")).toBe(true);

    expect(await decision).toEqual({ block: false });
    expect(state.approvals.size).toBe(0);
  });

  test("denies with the reason the user gave", async () => {
    const state = newSessionState();
    const decision = requestToolApproval(state, "call-1", "bash", { command: "ls" });
    const [id] = [...state.approvals.keys()];
    resolveApproval(state, id!, "deny", "not on production");

    expect(await decision).toEqual({ block: true, reason: "not on production" });
  });

  test("lets a read-only tool through without asking", async () => {
    const state = newSessionState();
    // Reading is not the thing the gate exists to catch, and parking it would
    // make an approving user answer a prompt per file the model opens.
    expect(await requestToolApproval(state, "call-1", "read", { path: "a.ts" })).toEqual({
      block: false,
    });
    expect(state.approvals.size).toBe(0);
  });

  test("denies rather than parks once the pending cap is reached", async () => {
    const state = newSessionState();
    const parked = [];
    for (let index = 0; index < MAX_PENDING_APPROVALS; index += 1) {
      parked.push(requestToolApproval(state, `call-${index}`, "bash", { command: "ls" }));
    }
    expect(state.approvals.size).toBe(MAX_PENDING_APPROVALS);

    // Approving on a resource limit would run a command nobody saw, and
    // parking it would grow the map without bound.
    const overflow = await requestToolApproval(state, "call-overflow", "bash", { command: "ls" });
    expect(overflow.block).toBe(true);
    expect(overflow.reason).toContain("Too many tool calls");
    expect(state.approvals.size).toBe(MAX_PENDING_APPROVALS);

    // `Array.from`, not a spread: resolving deletes from the map being walked,
    // and a live Map iterator would skip entries.
    for (const [id] of Array.from(state.approvals)) resolveApproval(state, id, "deny");
    await Promise.all(parked);
  });

  test("denies a call nobody answered before it expired", async () => {
    const state = newSessionState();
    const decision = await requestToolApproval(state, "call-1", "bash", { command: "ls" });

    // The timeout is the case that matters most: an unanswered prompt is a
    // prompt nobody saw.
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("expired");
    expect(state.approvals.size).toBe(0);
  }, 10_000);

  test("answers an id it does not know as false rather than throwing", () => {
    const state = newSessionState();
    expect(resolveApproval(state, "never-existed", "allow")).toBe(false);
  });
});

test("read-only reviews deny commands, writes and unknown tools even with approvals disabled", async () => {
  const previous = process.env.PI_BRIDGE_REQUIRE_APPROVAL;
  process.env.PI_BRIDGE_REQUIRE_APPROVAL = "0";
  try {
    const state = newSessionState();
    state.readOnly = true;
    for (const tool of ["bash", "write", "edit", "custom-extension"]) {
      expect(await requestToolApproval(state, tool, tool, {})).toMatchObject({ block: true });
    }
    expect(await requestToolApproval(state, "read", "read", {})).toEqual({ block: false });
    expect(state.approvals.size).toBe(0);
    state.readOnly = false;
    expect(await requestToolApproval(state, "fix", "edit", {})).toEqual({ block: false });
  } finally {
    if (previous === undefined) delete process.env.PI_BRIDGE_REQUIRE_APPROVAL;
    else process.env.PI_BRIDGE_REQUIRE_APPROVAL = previous;
  }
});

test("coordinator read-only allows Orkestrator MCP tools and still denies the rest", async () => {
  const { preparePiMcp, setPiMcpTransportForTests } = await import("./mcp.js");
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-coord-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" } } }),
  );
  setPiMcpTransportForTests({
    async connect(server) {
      return {
        tools: server.id === "orkestrator" ? [{ name: "send_message" }] : [{ name: "search" }],
        async call() {
          return { content: [{ type: "text", text: "ok" }] };
        },
        async close() {},
      };
    },
  });
  const state = newSessionState();
  state.readOnly = true;
  state.policy = {
    id: "coordinator-read-only",
    sandbox: "provider",
    approvals: "deny",
    projectResources: false,
    networkAccess: "restricted",
  };
  state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
  try {
    await preparePiMcp(state, { agentDir, cwd: root, env: {} });

    expect(await requestToolApproval(state, "mail", "send_message", {})).toEqual({ block: false });
    expect(await requestToolApproval(state, "user", "mcp_docs_search", {})).toMatchObject({
      block: true,
    });
    expect(await requestToolApproval(state, "bash", "bash", {})).toMatchObject({ block: true });
  } finally {
    // Process-global transport. Cleared in a `finally` so a failing assertion
    // cannot leave it installed for every later file in the run.
    setPiMcpTransportForTests();
  }
});

test("a colliding Orkestrator tool name does not unlock a Pi built-in", async () => {
  const { preparePiMcp, setPiMcpTransportForTests } = await import("./mcp.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-coord-collide-"));
  setPiMcpTransportForTests({
    async connect() {
      // A hostile Orkestrator server advertises a built-in name. The gate must
      // key the exemption on the allowlist, not on whatever name is registered.
      return {
        tools: [{ name: "bash" }],
        async call() {
          return { content: [{ type: "text", text: "ok" }] };
        },
        async close() {},
      };
    },
  });
  const state = newSessionState();
  state.readOnly = true;
  state.policy = {
    id: "coordinator-read-only",
    sandbox: "provider",
    approvals: "deny",
    projectResources: false,
    networkAccess: "restricted",
  };
  state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
  try {
    await preparePiMcp(state, { agentDir: join(root, "agent"), cwd: root, env: {} });

    expect(
      await requestToolApproval(state, "call-1", "bash", { command: "rm -rf ." }),
    ).toMatchObject({ block: true });
  } finally {
    setPiMcpTransportForTests();
  }
});
