import { afterEach, describe, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { COORDINATOR_LAUNCH_OVERRIDES_COMMAND } from "@orkestrator/protocol/coordinator-launch-overrides";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { TabLaunchOverrideMarker } from "./TabLaunchOverrideMarker";

/*
 * The marker on a worker tab of another node (coordinator.md, "Launch defaults"). A command node's
 * coordinator keeps the delegation of a worker it launched on a leaf, so the
 * leaf's own answer has no row for it; the leaf tab finds its row in the
 * window's command scope, by the leaf's node id.
 */

const LEAF = "bk_leaf" as BackendId;
const COMMAND = "bk_command" as BackendId;

afterEach(cleanupNodeScopes);

/** The command node's answer: its own rows, and those naming a node apart. */
const answer = (rows: Array<Record<string, string>>) => ({
  overrides: rows.filter((row) => !row.nodeId),
  remoteOverrides: rows.filter((row) => row.nodeId),
});

function scopes(commandOverrides: Array<Record<string, string>>, leafOverrides: unknown[] = []) {
  const windowScope = new WindowScope();
  const command = new FakeNodeClient({
    nodeId: COMMAND,
    invoke: { [COORDINATOR_LAUNCH_OVERRIDES_COMMAND]: answer(commandOverrides) },
  });
  const leaf = new FakeNodeClient({
    nodeId: LEAF,
    invoke: { [COORDINATOR_LAUNCH_OVERRIDES_COMMAND]: { overrides: leafOverrides } },
  });
  windowScope.open({ role: "command", client: command });
  return { windowScope, command, leaf };
}

const renderOnLeaf = (windowScope: WindowScope, leaf: FakeNodeClient, tabId = "startup-agent") =>
  renderInNodeScope(<TabLaunchOverrideMarker environmentId="worker" tabId={tabId} />, {
    windowScope,
    client: leaf,
    role: "leaf",
  });

describe("TabLaunchOverrideMarker on another node's tab", () => {
  test("shows the command node's row for this node's worker", async () => {
    const { windowScope, command, leaf } = scopes([
      { nodeId: LEAF, environmentId: "worker", tabId: "startup-agent", model: "opus" },
    ]);
    renderOnLeaf(windowScope, leaf);
    const marker = await screen.findByTestId("tab-launch-override");
    expect(marker.textContent).toBe("requested");
    expect(marker.getAttribute("title")).toContain("opus");
    expect(command.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1);
    expect(leaf.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1);
  });

  test("a row for another node, or for the command node's own tab, is not this tab's", async () => {
    const { windowScope, command, leaf } = scopes([
      { nodeId: "bk_other", environmentId: "worker", tabId: "startup-agent" },
      { environmentId: "worker", tabId: "startup-agent" },
    ]);
    renderOnLeaf(windowScope, leaf);
    await waitFor(() =>
      expect(command.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1),
    );
    await waitFor(() => expect(leaf.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("tab-launch-override") === null).toBe(true);
  });

  test("the leaf's own coordinator's worker is marked from the leaf's answer", async () => {
    const { windowScope, leaf } = scopes(
      [],
      [{ environmentId: "worker", tabId: "startup-agent", reasoning: "max" }],
    );
    renderOnLeaf(windowScope, leaf);
    const marker = await screen.findByTestId("tab-launch-override");
    expect(marker.getAttribute("title")).toContain("max");
  });

  test("every leaf tab shares the command node's one read", async () => {
    const { windowScope, command, leaf } = scopes([
      { nodeId: LEAF, environmentId: "worker", tabId: "a" },
      { nodeId: LEAF, environmentId: "worker", tabId: "b" },
    ]);
    renderOnLeaf(windowScope, leaf, "a");
    renderOnLeaf(windowScope, leaf, "b");
    await waitFor(() => expect(screen.queryAllByTestId("tab-launch-override")).toHaveLength(2));
    expect(command.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1);
  });

  test("a tab on the command scope ignores the rows it holds for other nodes", async () => {
    const windowScope = new WindowScope();
    const command = new FakeNodeClient({
      nodeId: COMMAND,
      invoke: {
        [COORDINATOR_LAUNCH_OVERRIDES_COMMAND]: answer([
          { nodeId: LEAF, environmentId: "worker", tabId: "startup-agent" },
        ]),
      },
    });
    renderInNodeScope(<TabLaunchOverrideMarker environmentId="worker" tabId="startup-agent" />, {
      windowScope,
      client: command,
    });
    await waitFor(() =>
      expect(command.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("tab-launch-override") === null).toBe(true);
  });

  test("a command scope opened after the leaf tab mounted marks it", async () => {
    const windowScope = new WindowScope();
    const leaf = new FakeNodeClient({
      nodeId: LEAF,
      invoke: { [COORDINATOR_LAUNCH_OVERRIDES_COMMAND]: { overrides: [] } },
    });
    renderOnLeaf(windowScope, leaf);
    await waitFor(() => expect(leaf.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1));
    expect(screen.queryByTestId("tab-launch-override") === null).toBe(true);

    const command = new FakeNodeClient({
      nodeId: COMMAND,
      invoke: {
        [COORDINATOR_LAUNCH_OVERRIDES_COMMAND]: answer([
          { nodeId: LEAF, environmentId: "worker", tabId: "startup-agent", model: "opus" },
        ]),
      },
    });
    act(() => {
      windowScope.open({ role: "command", client: command });
    });
    const marker = await screen.findByTestId("tab-launch-override");
    expect(marker.getAttribute("title")).toContain("opus");
    expect(command.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1);
  });

  test("disposing the command scope drops its row; the leaf's own answer stays", async () => {
    const { windowScope, command, leaf } = scopes(
      [{ nodeId: LEAF, environmentId: "worker", tabId: "a", model: "opus" }],
      [{ environmentId: "worker", tabId: "b", reasoning: "max" }],
    );
    renderOnLeaf(windowScope, leaf, "a");
    renderOnLeaf(windowScope, leaf, "b");
    await waitFor(() => expect(screen.queryAllByTestId("tab-launch-override")).toHaveLength(2));

    act(() => {
      windowScope.commandScope().dispose();
    });
    await waitFor(() => expect(screen.queryAllByTestId("tab-launch-override")).toHaveLength(1));
    expect(screen.getByTestId("tab-launch-override").getAttribute("title")).toContain("max");
    expect(command.disposed).toBe(true);
  });

  test("a replacement command scope's answer replaces the old one's row", async () => {
    const { windowScope, leaf } = scopes([
      { nodeId: LEAF, environmentId: "worker", tabId: "startup-agent", model: "opus" },
    ]);
    renderOnLeaf(windowScope, leaf);
    const first = await screen.findByTestId("tab-launch-override");
    expect(first.getAttribute("title")).toContain("opus");

    const replacement = new FakeNodeClient({
      nodeId: "bk_command-2" as BackendId,
      invoke: {
        [COORDINATOR_LAUNCH_OVERRIDES_COMMAND]: answer([
          { nodeId: LEAF, environmentId: "worker", tabId: "startup-agent", model: "sonnet" },
        ]),
      },
    });
    act(() => {
      windowScope.commandScope().dispose();
      windowScope.open({ role: "command", client: replacement });
    });
    await waitFor(() =>
      expect(screen.getByTestId("tab-launch-override").getAttribute("title")).toContain("sonnet"),
    );
    expect(replacement.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1);
  });

  test("a lone leaf scope with no command scope reads only its own node", async () => {
    const windowScope = new WindowScope();
    const leaf = new FakeNodeClient({
      nodeId: LEAF,
      invoke: { [COORDINATOR_LAUNCH_OVERRIDES_COMMAND]: { overrides: [] } },
    });
    renderOnLeaf(windowScope, leaf);
    await waitFor(() => expect(leaf.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1));
    expect(screen.queryByTestId("tab-launch-override") === null).toBe(true);
  });
});
