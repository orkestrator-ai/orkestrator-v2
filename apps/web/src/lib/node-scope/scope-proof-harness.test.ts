import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  createScopeProofHarness,
  desktopHostApi,
  type ScopeProofHost,
  type ScopeProofRoute,
} from "./scope-proof-harness";
import { WindowScope } from "./window-scope";

const COMMAND = "bk_scope-proof-command" as BackendId;
const LEAF = "bk_scope-proof-leaf" as BackendId;

let windowScope: WindowScope | null = null;

afterEach(() => {
  windowScope?.dispose();
  windowScope = null;
});

/** A node that answers the harness's reads and announces its own kanban changes. */
function fakeNode(nodeId: BackendId, projectId: string): FakeNodeClient {
  const client = new FakeNodeClient({ nodeId });
  let revision = 0;
  client
    .respond("get_node_status", { nodeId })
    .respond("get_projects", [{ id: projectId }])
    .respond("add_kanban_task", (args: Readonly<Record<string, unknown>>) => {
      client.emit("resource-changed", {
        resource: "kanban",
        id: args.projectId,
        revision: ++revision,
      });
      return { id: `task-${revision}` };
    })
    .respond("delete_kanban_task", (args: Readonly<Record<string, unknown>>) => {
      client.emit("resource-changed", { resource: "kanban", id: projectId, revision: ++revision });
      return { deleted: args.taskId };
    });
  return client;
}

/** A leaf whose local terminal runs `echo uf2013-$((40+2))-<nonce>` (or only echoes it). */
function withTerminal(client: FakeNodeClient, { runs = true } = {}): FakeNodeClient {
  return client
    .respond("create_local_terminal_session", { sessionId: "term-1", created: true })
    .respond("start_local_terminal_session", null)
    .respond("local_terminal_write", (args: Readonly<Record<string, unknown>>) => {
      const typed = String(args.data);
      // The shell's echo of the input, then (when it ran) its output.
      client.emitTerminalOutput("term-1", { text: typed.replace("\r", "\r\n") });
      if (runs)
        client.emitTerminalOutput("term-1", {
          text: `${typed.replace("$((40+2))", "42").slice(5)}\n`,
        });
      return { delivered: true };
    })
    .respond("close_local_terminal_session", null);
}

function setup(options: { leaf?: FakeNodeClient; command?: FakeNodeClient } = {}) {
  const scope = new WindowScope();
  windowScope = scope;
  const command = options.command ?? fakeNode(COMMAND, "project-command");
  scope.open({ role: "command", client: command });
  const leaf = options.leaf ?? withTerminal(fakeNode(LEAF, "project-leaf"));
  const route: ScopeProofRoute = {
    path: "relay",
    baseUrl: `http://127.0.0.1:1/__orkestrator/nodes/${LEAF}`,
    relayed: true,
  };
  const host: ScopeProofHost = {
    kind: "browser",
    openLeafScope: async (windowScope, nodeId) =>
      windowScope.get(nodeId) ?? windowScope.open({ role: "leaf", client: leaf }),
    route: async () => route,
  };
  const harness = createScopeProofHarness({ host, windowScope: () => scope, settleMs: 0 });
  return { harness, command, leaf, scope };
}

describe("scope proof harness", () => {
  test("holds the command scope and a leaf scope, reads, listens and opens a leaf terminal", async () => {
    const { harness, command, leaf, scope } = setup();
    const report = await harness.run({ leafNodeId: LEAF, leafEnvironmentId: "env-leaf" });

    expect(report.openScopes).toEqual([
      { nodeId: COMMAND, role: "command" },
      { nodeId: LEAF, role: "leaf" },
    ]);
    expect(report.command).toMatchObject({
      role: "command",
      scopeNodeId: COMMAND,
      answeredBy: COMMAND,
      projects: 1,
      resourceChanged: { projectId: "project-command", received: true, seenByOtherScope: 0 },
    });
    expect(report.leaf).toMatchObject({
      role: "leaf",
      scopeNodeId: LEAF,
      answeredBy: LEAF,
      resourceChanged: { projectId: "project-leaf", received: true, seenByOtherScope: 0 },
    });
    expect(report.terminal).toMatchObject({ opened: true, outputSeen: true });
    expect(report.route?.relayed).toBe(true);
    // Each node's mutations went to its own scope only.
    expect(command.calls("add_kanban_task")).toHaveLength(1);
    expect(leaf.calls("add_kanban_task")).toHaveLength(1);
    expect(command.calls("create_local_terminal_session")).toHaveLength(0);
    expect(leaf.calls("create_local_terminal_session")[0]?.args).toMatchObject({
      environmentId: "env-leaf",
    });
    expect(leaf.calls("close_local_terminal_session")).toHaveLength(1);
    expect(leaf.calls("delete_kanban_task")).toHaveLength(1);
    // The leaf scope was released; its client disposed; no listener left behind.
    expect(scope.get(LEAF)).toBeNull();
    expect(leaf.disposed).toBe(true);
    expect(command.listenerCount()).toBe(0);
    expect(report.leafScopeOpenAfterRun).toBe(false);
  });

  test("reports a change one scope sees for the other scope's project", async () => {
    const command = fakeNode(COMMAND, "project-command");
    const leaf = withTerminal(fakeNode(LEAF, "project-leaf"));
    // A command stream that (wrongly) repeats the leaf's change.
    leaf.respond("add_kanban_task", (args: Readonly<Record<string, unknown>>) => {
      leaf.emit("resource-changed", { resource: "kanban", id: args.projectId, revision: 1 });
      command.emit("resource-changed", { resource: "kanban", id: args.projectId, revision: 1 });
      return { id: "task-leaf" };
    });
    const { harness } = setup({ command, leaf });
    const report = await harness.run({ leafNodeId: LEAF, leafEnvironmentId: "env-leaf" });
    expect(report.leaf.resourceChanged.seenByOtherScope).toBe(1);
    expect(report.command.resourceChanged.seenByOtherScope).toBe(0);
  });

  test("a terminal that only echoes the input is not output", async () => {
    const leaf = withTerminal(fakeNode(LEAF, "project-leaf"), { runs: false });
    const { harness } = setup({ leaf });
    const report = await harness.run({
      leafNodeId: LEAF,
      leafEnvironmentId: "env-leaf",
      timeoutMs: 200,
    });
    expect(report.terminal).toMatchObject({ opened: true, outputSeen: false, closed: false });
    expect(report.terminal.frames).toBeGreaterThan(0);
    expect(leaf.calls("close_local_terminal_session")).toHaveLength(1);
  });

  test("a missing change event is reported, not hung on", async () => {
    const leaf = withTerminal(fakeNode(LEAF, "project-leaf"));
    leaf.respond("add_kanban_task", { id: "silent" });
    const { harness } = setup({ leaf });
    const report = await harness.run({
      leafNodeId: LEAF,
      leafEnvironmentId: "env-leaf",
      timeoutMs: 200,
    });
    expect(report.leaf.resourceChanged.received).toBe(false);
    expect(report.command.resourceChanged.received).toBe(true);
  });

  test("keepOpen leaves the leaf scope open until close", async () => {
    const { harness, command, leaf, scope } = setup();
    await harness.run({ leafNodeId: LEAF, leafEnvironmentId: "env-leaf", keepOpen: true });
    expect(scope.get(LEAF)).not.toBeNull();
    expect(harness.scopes().map((entry) => entry.role)).toEqual(["command", "leaf"]);
    // Both scopes keep a listener, so their streams stay open while held.
    expect(command.listenerCount("resource-changed")).toBe(1);
    expect(leaf.listenerCount("resource-changed")).toBe(1);
    harness.close(LEAF);
    expect(scope.get(LEAF)).toBeNull();
    expect(leaf.disposed).toBe(true);
    expect(command.listenerCount()).toBe(0);
  });
});

describe("desktopHostApi", () => {
  test("uses the preload API only when it can open node scopes", () => {
    const node = () => ({});
    const preload = { node } as unknown as NonNullable<Window["orkestrator"]>;
    expect(desktopHostApi({ orkestrator: preload } as unknown as Window)).toBe(preload);
    expect(
      desktopHostApi({
        orkestrator: { invoke: () => undefined },
        orkestratorDesktopHost: { api: preload, baseUrl: "http://127.0.0.1:1" },
      } as unknown as Window),
    ).toBe(preload);
    expect(desktopHostApi({ orkestrator: { invoke: () => undefined } } as unknown as Window)).toBe(
      undefined,
    );
  });
});
