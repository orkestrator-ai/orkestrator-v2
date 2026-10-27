/**
 * The approval gate with the gate actually on.
 *
 * `interactions.test.ts` exercises the parked-approval machinery directly,
 * because the default is off. This file turns the gate on, so the paths it
 * covers are the ones only `requestToolApproval` itself can take: the
 * read-only bypass, the pending cap, the timeout — every one of which must
 * deny rather than approve — and pausing that timeout.
 *
 * The gate follows each session's execution policy, so the sessions here are
 * created under `ask`. Time is Bun's fake clock,
 * which also moves `Date.now`, so the default five-minute window and the
 * day-long hold ceiling are proven without waiting for either.
 */
import { describe, expect, jest, test } from "bun:test";
import { AGENT_INTERACTION_HOLD_CEILING_MS as CEILING } from "@orkestrator/protocol/agent-interactions";

const { holdApproval, publicApprovals, requestToolApproval, resolveApproval } =
  await import("./interactions.js");
const { newSessionState: newBareSessionState } = await import("./agent-session.js");

/** A session whose execution policy turns the approval gate on. */
function newSessionState() {
  return newBareSessionState(undefined, {
    id: "interactive-host",
    sandbox: "none",
    approvals: "ask",
    projectResources: false,
    networkAccess: "full",
  });
}
const { approvalTimeoutMs, MAX_PENDING_APPROVALS } = await import("./config.js");

const HOUR = 60 * 60 * 1000;
const EXPIRED = "The approval request expired before it was answered.";

/** Run `body` on Bun's fake clock, restoring real timers however it ends. */
async function withFakeTime(body: () => Promise<void>): Promise<void> {
  jest.useFakeTimers();
  try {
    await body();
  } finally {
    jest.useRealTimers();
  }
}

/** Park one mutating call through the real gate. */
function parkBash(state: ReturnType<typeof newSessionState>) {
  const decision = requestToolApproval(state, "call-1", "bash", { command: "make release" });
  const [id] = [...state.approvals.keys()];
  return { id: id!, decision };
}

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
    await withFakeTime(async () => {
      const state = newSessionState();
      const { id, decision } = parkBash(state);

      jest.advanceTimersByTime(approvalTimeoutMs() - 1);
      expect(state.approvals.has(id)).toBe(true);
      jest.advanceTimersByTime(1);

      // The timeout is the case that matters most: an unanswered prompt is a
      // prompt nobody saw.
      expect(await decision).toEqual({ block: true, reason: EXPIRED });
      expect(state.approvals.size).toBe(0);
    });
  });

  // An edit or write is a file approval. It shares the command's timer and
  // answer path, so these pin that the kind changes neither.
  for (const { toolName, change } of [
    { toolName: "edit", change: "update" },
    { toolName: "write", change: "create" },
  ]) {
    test(`parks a ${toolName} as a file approval and runs it once allowed`, async () => {
      const state = newSessionState();
      const decision = requestToolApproval(state, "call-1", toolName, { path: "src/a.ts" });

      const { approvals } = publicApprovals(state) as { approvals: Array<Record<string, unknown>> };
      expect(approvals).toEqual([
        expect.objectContaining({
          kind: "file-change",
          changes: [{ path: "src/a.ts", kind: change }],
          reason: `Pi requested to run the ${toolName} tool.`,
        }),
      ]);
      expect(approvals[0]).not.toHaveProperty("actionable");
      expect(resolveApproval(state, approvals[0]!.approvalId as string, "allow")).toBe(true);

      expect(await decision).toEqual({ block: false });
      expect(state.approvals.size).toBe(0);
    });

    test(`denies a ${toolName} nobody answered before it expired`, async () => {
      await withFakeTime(async () => {
        const state = newSessionState();
        const decision = requestToolApproval(state, "call-1", toolName, { path: "src/a.ts" });
        const [id] = [...state.approvals.keys()];

        jest.advanceTimersByTime(approvalTimeoutMs() - 1);
        expect(state.approvals.has(id!)).toBe(true);
        jest.advanceTimersByTime(1);

        expect(await decision).toEqual({ block: true, reason: EXPIRED });
        expect(state.approvals.size).toBe(0);
        // Settled is closed: a late allow approves nothing.
        expect(resolveApproval(state, id!, "allow")).toBe(false);
      });
    });
  }

  test("answers an id it does not know as false rather than throwing", () => {
    const state = newSessionState();
    expect(resolveApproval(state, "never-existed", "allow")).toBe(false);
  });
});

describe("pausing an approval's deadline", () => {
  test("a paused approval outlives its window and is denied at the hold ceiling", async () => {
    await withFakeTime(async () => {
      const window = approvalTimeoutMs();
      const state = newSessionState();
      const { id, decision } = parkBash(state);
      const requestedAt = Date.now();

      jest.advanceTimersByTime(window - 1_000);
      const pausedAt = Date.now();
      const revision = state.revision;
      expect(holdApproval(state, id, true)).toEqual({
        result: "applied",
        expiresAt: pausedAt + CEILING,
        hold: { available: true, heldAt: pausedAt },
      });
      // Readers learn of the moved deadline through the snapshot revision.
      expect(state.revision).toBe(revision + 1);
      expect(publicApprovals(state).approvals).toEqual([
        expect.objectContaining({
          approvalId: id,
          requestedAt,
          expiresAt: pausedAt + CEILING,
          hold: { available: true, heldAt: pausedAt },
        }),
      ]);

      // Well past the window: still parked, still unanswered.
      jest.advanceTimersByTime(10 * window);
      expect(state.approvals.has(id)).toBe(true);

      // A pause only moves the deadline. Nobody came back, so it still denies.
      jest.advanceTimersByTime(pausedAt + CEILING - Date.now() - 1);
      expect(state.approvals.has(id)).toBe(true);
      jest.advanceTimersByTime(1);
      expect(await decision).toEqual({ block: true, reason: EXPIRED });
      expect(state.approvals.size).toBe(0);
    });
  });

  test("the turn's own budget caps a pause, and the hold says why", async () => {
    await withFakeTime(async () => {
      const state = newSessionState();
      const turnDeadlineAt = Date.now() + 2 * HOUR;
      state.turnDeadlineAt = turnDeadlineAt;
      const { id, decision } = parkBash(state);

      // Published before any pause, so the card can say a pause is limited.
      expect(publicApprovals(state).approvals).toEqual([
        expect.objectContaining({ hold: { available: true, reason: "provider-limit" } }),
      ]);

      const pausedAt = Date.now();
      expect(holdApproval(state, id, true)).toEqual({
        result: "applied",
        expiresAt: turnDeadlineAt,
        hold: { available: true, heldAt: pausedAt, reason: "provider-limit" },
      });
      expect(publicApprovals(state).approvals).toEqual([
        expect.objectContaining({
          expiresAt: turnDeadlineAt,
          hold: { available: true, heldAt: pausedAt, reason: "provider-limit" },
        }),
      ]);

      jest.advanceTimersByTime(2 * HOUR - 1);
      expect(state.approvals.has(id)).toBe(true);
      jest.advanceTimersByTime(1);
      expect(await decision).toEqual({ block: true, reason: EXPIRED });
    });
  });

  test("a resume restarts a fresh full window rather than the remainder", async () => {
    await withFakeTime(async () => {
      const window = approvalTimeoutMs();
      const state = newSessionState();
      const { id, decision } = parkBash(state);

      // Paused with a second left, resumed three hours later.
      jest.advanceTimersByTime(window - 1_000);
      holdApproval(state, id, true);
      jest.advanceTimersByTime(3 * HOUR);
      const resumedAt = Date.now();
      const revision = state.revision;
      expect(holdApproval(state, id, false)).toEqual({
        result: "applied",
        expiresAt: resumedAt + window,
        hold: { available: true },
      });
      expect(state.revision).toBe(revision + 1);
      expect(publicApprovals(state).approvals).toEqual([
        expect.objectContaining({ expiresAt: resumedAt + window, hold: { available: true } }),
      ]);

      jest.advanceTimersByTime(window - 1);
      expect(state.approvals.has(id)).toBe(true);
      jest.advanceTimersByTime(1);
      expect(await decision).toEqual({ block: true, reason: EXPIRED });
    });
  });

  test("a repeated pause changes nothing and never answers the call", async () => {
    await withFakeTime(async () => {
      const state = newSessionState();
      const { id, decision } = parkBash(state);

      expect(holdApproval(state, id, false).result).toBe("unchanged");
      const paused = holdApproval(state, id, true);
      if (paused.result !== "applied") throw new Error(`expected a pause, got ${paused.result}`);
      const revision = state.revision;
      expect(holdApproval(state, id, true)).toEqual({ ...paused, result: "unchanged" });
      expect(state.revision).toBe(revision);
      expect(state.approvals.has(id)).toBe(true);

      // Still a live control: the user's answer is what settles it.
      expect(resolveApproval(state, id, "allow")).toBe(true);
      expect(await decision).toEqual({ block: false });
      expect(holdApproval(state, id, false)).toEqual({ result: "missing" });

      // The answered call's timer is gone: nothing fires at the ceiling.
      jest.advanceTimersByTime(2 * CEILING);
      expect(state.approvals.size).toBe(0);
    });
  });

  test("is unavailable when the turn ends before the window does", async () => {
    await withFakeTime(async () => {
      const window = approvalTimeoutMs();
      const state = newSessionState();
      state.turnDeadlineAt = Date.now() + 60_000;
      const { id, decision } = parkBash(state);
      const expiresAt = Date.now() + window;
      const revision = state.revision;

      expect(holdApproval(state, id, true)).toEqual({
        result: "unavailable",
        expiresAt,
        hold: { available: false, reason: "no-extension" },
      });
      expect(state.revision).toBe(revision);
      expect(state.approvals.has(id)).toBe(true);

      resolveApproval(state, id, "deny");
      expect((await decision).block).toBe(true);
    });
  });
});

test("read-only reviews deny commands, writes and unknown tools even with approvals disabled", async () => {
  // No policy runs as the host default, auto-approve.
  const state = newBareSessionState();
  state.readOnly = true;
  for (const tool of ["bash", "write", "edit", "custom-extension"]) {
    expect(await requestToolApproval(state, tool, tool, {})).toMatchObject({ block: true });
  }
  expect(await requestToolApproval(state, "read", "read", {})).toEqual({ block: false });
  expect(state.approvals.size).toBe(0);
  state.readOnly = false;
  expect(await requestToolApproval(state, "fix", "edit", {})).toEqual({ block: false });
});

test("a coordinator cannot reach the network through an extension's web tool", async () => {
  // Pi ships no web tool, but a user extension can register one (and project
  // extensions are not loaded for a coordinator). The gate is a name
  // allowlist, so any such tool is refused before it runs, approvals or not.
  const { coordinatorProcessPolicy } = await import("./agent-session.js");
  const state = newBareSessionState();
  state.policy = coordinatorProcessPolicy();
  state.readOnly = true;
  for (const tool of ["web_search", "web_fetch", "webfetch", "fetch", "browser"]) {
    expect(
      await requestToolApproval(state, tool, tool, { url: "https://example.com" }),
    ).toMatchObject({ block: true });
  }
  expect(state.approvals.size).toBe(0);
});

test("coordinator read-only allows Orkestrator MCP tools and still denies the rest", async () => {
  const { preparePiMcp, setPiMcpTransportForTests } = await import("./mcp.js");
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
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
    await rm(root, { recursive: true, force: true });
  }
});

test("a coordinator may call its research servers' tools, by exact registered name only", async () => {
  const { preparePiMcp, publicPiMcpServers, setPiMcpTransportForTests } = await import("./mcp.js");
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-coord-research-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  // A user server under the research name must not stand in for it: it is a
  // local program, and the gate would otherwise admit its tools by name.
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { context7: { command: "local-context7" } } }),
  );
  const connected: { id: string; scope: string; transport: string; url?: string }[] = [];
  setPiMcpTransportForTests({
    async connect(server) {
      connected.push({
        id: server.id,
        scope: server.scope,
        transport: server.transport,
        ...(server.url ? { url: server.url } : {}),
      });
      return {
        tools: server.id === "orkestrator" ? [{ name: "send_message" }] : [{ name: "query-docs" }],
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
  state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "coordinator-token" };
  const env = {
    ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
    ORKESTRATOR_COORDINATOR_WEB_RESEARCH: "search-and-mcp",
    ORKESTRATOR_COORDINATOR_RESEARCH_MCP: JSON.stringify([
      { name: "context7", url: "https://mcp.context7.com/mcp" },
    ]),
  };
  try {
    await preparePiMcp(state, { agentDir, cwd: root, env });
    expect(connected).toContainEqual({
      id: "context7",
      scope: "research",
      transport: "http",
      url: "https://mcp.context7.com/mcp",
    });
    expect(connected.some((server) => server.transport === "stdio")).toBe(false);
    expect(await requestToolApproval(state, "docs", "mcp_context7_query-docs", {})).toEqual({
      block: false,
    });
    // Same server, a name it never registered.
    expect(
      await requestToolApproval(state, "other", "mcp_context7_resolve-library-id", {}),
    ).toMatchObject({ block: true });
    expect(await requestToolApproval(state, "bash", "bash", {})).toMatchObject({ block: true });
    // Configured in Orkestrator's settings, so reported as Orkestrator's.
    expect(publicPiMcpServers(state).find((server) => server.id === "context7")?.scope).toBe(
      "orkestrator",
    );

    // Without the coordinator's process authority the research variables are
    // ignored, so a worker's read-only review never gains a remote server.
    connected.length = 0;
    const { ORKESTRATOR_BRIDGE_EXECUTION_POLICY: _policy, ...workerEnv } = env;
    await preparePiMcp(state, { agentDir, cwd: root, env: workerEnv });
    expect(connected.some((server) => server.scope === "research")).toBe(false);
    expect(await requestToolApproval(state, "docs", "mcp_context7_query-docs", {})).toMatchObject({
      block: true,
    });
  } finally {
    setPiMcpTransportForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a read-only coordinator may call every Control MCP coordinator tool", async () => {
  const { preparePiMcp, setPiMcpTransportForTests } = await import("./mcp.js");
  const { COORDINATOR_CONTROL_TOOL_NAMES } = await import("@orkestrator/protocol/coordinator");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-coord-control-"));
  setPiMcpTransportForTests({
    async connect() {
      return {
        tools: COORDINATOR_CONTROL_TOOL_NAMES.map((name) => ({ name })),
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
  state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "coordinator-token" };
  try {
    await preparePiMcp(state, { agentDir: join(root, "agent"), cwd: root, env: {} });
    // read_messages and get_message were refused before: the gate only knew
    // the tab-credential mail names.
    for (const name of COORDINATOR_CONTROL_TOOL_NAMES) {
      expect(await requestToolApproval(state, `call-${name}`, name, {})).toEqual({ block: false });
    }
    expect(await requestToolApproval(state, "write", "write", {})).toMatchObject({ block: true });
  } finally {
    setPiMcpTransportForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["ask", "deny"] as const)(
  "a worker whose approvals are %s can still use its mail tools, and nothing else is exempt",
  async (approvals) => {
    const { preparePiMcp, setPiMcpTransportForTests } = await import("./mcp.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-worker-mail-"));
    setPiMcpTransportForTests({
      async connect() {
        return {
          tools: [{ name: "send_message" }, { name: "reply_message" }, { name: "create_ticket" }],
          async call() {
            return { content: [{ type: "text", text: "ok" }] };
          },
          async close() {},
        };
      },
    });
    const state = newSessionState();
    state.policy = {
      id: "interactive-host",
      sandbox: "provider",
      approvals,
      projectResources: false,
      networkAccess: "restricted",
    };
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
    try {
      await preparePiMcp(state, { agentDir: join(root, "agent"), cwd: root, env: {} });
      for (const tool of ["send_message", "reply_message"]) {
        expect(await requestToolApproval(state, `call-${tool}`, tool, {})).toEqual({
          block: false,
        });
      }
      if (approvals === "deny") {
        expect(await requestToolApproval(state, "ticket", "create_ticket", {})).toMatchObject({
          block: true,
        });
      }
    } finally {
      setPiMcpTransportForTests();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a colliding Orkestrator tool name does not unlock a Pi built-in", async () => {
  const { preparePiMcp, setPiMcpTransportForTests } = await import("./mcp.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
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
    await rm(root, { recursive: true, force: true });
  }
});

test("a read-only reviewer may use its own attempt's result tools under every approval policy", async () => {
  const { preparePiMcp, setPiMcpTransportForTests } = await import("./mcp.js");
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-reviewer-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  // Another server offering tools of the same names is not the reviewer's.
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" } } }),
  );
  const attemptTools = [
    "validate_workflow_result",
    "submit_review_report",
    "get_workflow_result_status",
    "report_finding",
  ];
  setPiMcpTransportForTests({
    async connect(server) {
      return {
        tools:
          server.id === "orkestrator"
            ? [...attemptTools, "submit_fix_result"].map((name) => ({ name }))
            : [{ name: "submit_review_report" }],
        async call() {
          return { content: [{ type: "text", text: "ok" }] };
        },
        async close() {},
      };
    },
  });
  const resultKey = "11111111-1111-4111-8111-111111111111";
  const own = { resultKey };
  const other = { resultKey: "22222222-2222-4222-8222-222222222222" };
  try {
    for (const approvals of ["auto-approve", "ask", "deny"] as const) {
      const state = newSessionState();
      state.readOnly = true;
      state.policy = {
        id: "pipeline",
        sandbox: "none",
        approvals,
        projectResources: false,
        networkAccess: "full",
      };
      state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "attempt-capability" };
      state.workflowResultTurn = { tool: "submit_review_report", resultKey };
      await preparePiMcp(state, { agentDir, cwd: root, env: {} });

      for (const tool of attemptTools) {
        expect(await requestToolApproval(state, tool, tool, own)).toEqual({ block: false });
        // Another reviewer's key is never this reviewer's to submit.
        expect(await requestToolApproval(state, tool, tool, other)).toMatchObject({ block: true });
      }
      // A tool this attempt does not offer, the same name from another server,
      // and the read-only gate itself all still hold.
      expect(await requestToolApproval(state, "fix", "submit_fix_result", own)).toMatchObject({
        block: true,
      });
      expect(
        await requestToolApproval(state, "other", "mcp_docs_submit_review_report", own),
      ).toMatchObject({ block: true });
      expect(await requestToolApproval(state, "edit", "edit", {})).toMatchObject({ block: true });
      expect(state.approvals.size).toBe(0);

      // A turn that declared no attempt is not a reviewer's.
      state.workflowResultTurn = undefined;
      expect(await requestToolApproval(state, "submit", "submit_review_report", own)).toMatchObject(
        { block: true },
      );
      // An explicit deny still wins.
      state.workflowResultTurn = { tool: "submit_review_report", resultKey };
      state.policy = { ...state.policy, toolPolicy: { deny: ["submit_review_report"] } };
      expect(await requestToolApproval(state, "submit", "submit_review_report", own)).toMatchObject(
        { block: true },
      );
      state.approvals.clear();
    }
  } finally {
    setPiMcpTransportForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a read-only workflow turn may use its own artifact-only server's tools", async () => {
  const { preparePiMcp, setPiMcpTransportForTests } = await import("./mcp.js");
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-artifacts-"));
  await mkdir(join(root, "agent"), { recursive: true });
  const connected: Array<{ id: string; url?: string; authorization?: string }> = [];
  setPiMcpTransportForTests({
    async connect(server) {
      connected.push({
        id: server.id,
        url: server.url,
        authorization: server.headers?.Authorization,
      });
      return {
        tools:
          server.id === "orkestrator-artifacts"
            ? [{ name: "publish_artifact" }, { name: "create_artifact" }]
            : [{ name: "submit_review_report" }],
        async call() {
          return { content: [{ type: "text", text: "ok" }] };
        },
        async close() {},
      };
    },
  });
  try {
    for (const approvals of ["auto-approve", "ask", "deny"] as const) {
      connected.length = 0;
      const state = newSessionState();
      state.readOnly = true;
      state.policy = {
        id: "pipeline",
        sandbox: "none",
        approvals,
        projectResources: false,
        networkAccess: "full",
      };
      state.agentMcp = {
        url: "http://127.0.0.1:4567/mcp",
        token: "attempt-capability",
        artifacts: { token: "oag1.turn-grant" },
      };
      await preparePiMcp(state, { agentDir: join(root, "agent"), cwd: root, env: {} });

      expect(connected).toContainEqual({
        id: "orkestrator-artifacts",
        url: "http://127.0.0.1:4567/artifact-mcp",
        authorization: "Bearer oag1.turn-grant",
      });
      expect(await requestToolApproval(state, "pub", "publish_artifact", {})).toEqual({
        block: false,
      });
      // The read-only gate still holds for everything else.
      expect(await requestToolApproval(state, "edit", "edit", {})).toMatchObject({ block: true });
      // An explicit deny still wins.
      state.policy = { ...state.policy, toolPolicy: { deny: ["publish_artifact"] } };
      expect(await requestToolApproval(state, "pub", "publish_artifact", {})).toMatchObject({
        block: true,
      });
      state.approvals.clear();
    }
  } finally {
    setPiMcpTransportForTests();
    await rm(root, { recursive: true, force: true });
  }
});
