/**
 * Plan item 3003: the mirror stores' writers (`useEnvironmentDiffStats`,
 * `useWorktreeSnapshotRevisions`, `usePrMonitorService`) read, listen and
 * re-read on reconnect through the client of the node scope that renders
 * them, and write that scope's store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { DIFF_STATS_CHANGED_EVENT } from "@orkestrator/protocol/diff-stats";
import type { BackendId } from "@orkestrator/protocol/federation";
import { PR_MONITOR_CHANGED_EVENT } from "@orkestrator/protocol/pr-monitor";
import {
  WORKTREE_SNAPSHOT_CHANGED_EVENT,
  WORKTREE_SNAPSHOT_REVISIONS_COMMAND,
} from "@orkestrator/protocol/worktree-snapshots";
import type { ReactNode } from "react";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { environmentDiffStore } from "@/stores/environmentDiffStore";
import { useEnvironmentDiffStats } from "./useEnvironmentDiffStats";
import { usePrMonitorService } from "./usePrMonitorService";
import { useWorktreeSnapshotRevisions } from "./useWorktreeSnapshotRevisions";

const NODE_A = "bk_mirror-a" as BackendId;
const NODE_B = "bk_mirror-b" as BackendId;

let windowScope: WindowScope | null = null;

afterEach(() => {
  windowScope?.dispose();
  windowScope = null;
  resetWindowScopeForTests();
});

const CASES = [
  {
    name: "useEnvironmentDiffStats",
    command: "get_environment_diff_stats",
    event: DIFF_STATS_CHANGED_EVENT,
    use: () => useEnvironmentDiffStats(),
  },
  {
    name: "useWorktreeSnapshotRevisions",
    command: WORKTREE_SNAPSHOT_REVISIONS_COMMAND,
    event: WORKTREE_SNAPSHOT_CHANGED_EVENT,
    use: () => useWorktreeSnapshotRevisions({ enabled: true }),
  },
  {
    name: "usePrMonitorService",
    command: "get_pr_monitor_state",
    event: PR_MONITOR_CHANGED_EVENT,
    use: () => usePrMonitorService(),
  },
] as const;

function nodeClient(nodeId: BackendId): FakeNodeClient {
  return new FakeNodeClient({
    nodeId,
    invoke: Object.fromEntries(CASES.map(({ command }) => [command, { entries: [] }])),
  });
}

function twoNodes() {
  windowScope = new WindowScope();
  const clientA = nodeClient(NODE_A);
  const clientB = nodeClient(NODE_B);
  const a = windowScope.open({ role: "command", client: clientA });
  const b = windowScope.open({ role: "leaf", client: clientB });
  return { a, b, clientA, clientB };
}

function inScope(scope: NodeScope) {
  return ({ children }: { children: ReactNode }) => (
    <WindowScopeProvider windowScope={windowScope!}>
      <NodeScopeProvider scope={scope}>{children}</NodeScopeProvider>
    </WindowScopeProvider>
  );
}

describe.each(CASES.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
  test("reads, listens and re-reads on its own node", async () => {
    const { b, clientA, clientB } = twoNodes();
    const { unmount } = renderHook(entry.use, { wrapper: inScope(b) });

    await waitFor(() => expect(clientB.calls(entry.command)).toHaveLength(1));
    expect(clientB.listenerCount(entry.event)).toBe(1);
    expect(clientA.invocations).toEqual([]);
    expect(clientA.listenerCount()).toBe(0);

    // B's connection coming back is B's re-read; A's is not.
    act(() => clientA.connection.set("connecting"));
    act(() => clientA.connection.set("live"));
    act(() => clientB.connection.set("connecting"));
    act(() => clientB.connection.set("live"));
    await waitFor(() => expect(clientB.calls(entry.command)).toHaveLength(2));
    expect(clientA.invocations).toEqual([]);

    unmount();
    expect(clientB.listenerCount(entry.event)).toBe(0);
  });
});

test("a node's diff-stat changes land in that node's store only", async () => {
  resetWindowScopeForTests(new FakeNodeClient({ nodeId: NODE_A }));
  const { a, b, clientB } = twoNodes();
  renderHook(() => useEnvironmentDiffStats(), { wrapper: inScope(b) });
  await waitFor(() => expect(clientB.listenerCount(DIFF_STATS_CHANGED_EVENT)).toBe(1));

  act(() =>
    clientB.emit(DIFF_STATS_CHANGED_EVENT, {
      environmentId: "env-1",
      comparisonRef: "main",
      computedAt: "2026-11-07T00:00:00.000Z",
      stats: { additions: 4, deletions: 1, filesChanged: 2, truncated: false },
    }),
  );

  await waitFor(() =>
    expect(b.store(environmentDiffStore).getState().stats.get("env-1")?.additions).toBe(4),
  );
  expect(a.store(environmentDiffStore).getState().stats.size).toBe(0);
  expect(getWindowScope().commandScope().store(environmentDiffStore).getState().stats.size).toBe(0);
});
