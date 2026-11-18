import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useComposerFileMentions } from "./useComposerFileMentions";
import { useFileSearch } from "./useFileSearch";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { ReactNode } from "react";

const windows: WindowScope[] = [];
afterEach(() => {
  cleanup();
  for (const windowScope of windows.splice(0)) windowScope.dispose();
});

function snapshot(filename: string) {
  return {
    unchanged: false,
    digest: filename,
    value: [{ name: filename, path: filename, isDirectory: false }],
  };
}

function workspacePair() {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const client = new FakeNodeClient();
  const scope = windowScope.open({ role: "command", client });
  const leafClient = new FakeNodeClient({ nodeId: "other-node" as FakeNodeClient["nodeId"] });
  const leaf = windowScope.open({ role: "leaf", client: leafClient });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WindowScopeProvider windowScope={windowScope}>
      <NodeScopeProvider scope={scope}>{children}</NodeScopeProvider>
    </WindowScopeProvider>
  );
  return { windowScope, scope, client, leaf, leafClient, wrapper };
}

test("closed composers stay idle and open composers share one read and flattened result", async () => {
  const { wrapper, client } = workspacePair();
  const load = Promise.withResolvers<ReturnType<typeof snapshot>>();
  client.respond("get_local_file_tree", () => load.promise);
  const first = renderHook(() => useComposerFileMentions(undefined, "/checkout"), { wrapper });
  const second = renderHook(() => useComposerFileMentions(undefined, "/checkout"), { wrapper });
  expect(client.calls("get_local_file_tree")).toHaveLength(0);
  expect(first.result.current.fileSearch.isLoading).toBe(false);

  act(() => first.result.current.handleCursorChange(1, "@"));
  expect(first.result.current.fileSearch.isLoading).toBe(true);
  await waitFor(() => expect(client.calls("get_local_file_tree")).toHaveLength(1));

  // The initiating tab can leave while a tab on the same node joins.
  first.unmount();
  act(() => second.result.current.handleCursorChange(1, "@"));
  expect(second.result.current.fileSearch.isLoading).toBe(true);
  await act(async () => load.resolve(snapshot("shared.ts")));
  expect(second.result.current.filteredFiles.map((file) => file.relativePath)).toEqual([
    "shared.ts",
  ]);
  const index = second.result.current.fileSearch.flatFiles;

  const third = renderHook(() => useComposerFileMentions(undefined, "/checkout"), { wrapper });
  act(() => third.result.current.handleCursorChange(1, "@"));
  await waitFor(() => expect(third.result.current.fileSearch.flatFiles).toBe(index));
  expect(client.calls("get_local_file_tree")).toHaveLength(1);
});

test("reopening after three seconds checks the digest and replaces renamed paths", async () => {
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const { wrapper, client } = workspacePair();
    client.respond("get_file_tree", snapshot("old.ts"));
    const view = renderHook(({ open }) => useFileSearch("runtime", undefined, open, "composer"), {
      wrapper,
      initialProps: { open: true },
    });
    await waitFor(() => expect(view.result.current.flatFiles[0]?.relativePath).toBe("old.ts"));
    const previousIndex = view.result.current.flatFiles;

    view.rerender({ open: false });
    now += 3_000;
    client.respond("get_file_tree", { unchanged: true, digest: "old.ts" });
    view.rerender({ open: true });
    await waitFor(() => expect(view.result.current.flatFiles).toBe(previousIndex));
    expect(client.calls("get_file_tree").at(-1)?.args).toMatchObject({
      containerId: "runtime",
      knownDigest: "old.ts",
      refresh: true,
    });

    view.rerender({ open: false });
    now += 3_000;
    client.respond("get_file_tree", snapshot("renamed.ts"));
    view.rerender({ open: true });
    expect(view.result.current.flatFiles).toEqual([]);
    await waitFor(() => expect(view.result.current.flatFiles[0]?.relativePath).toBe("renamed.ts"));
    expect(client.calls("get_file_tree")).toHaveLength(3);
  } finally {
    clock.mockRestore();
  }
});

test("changing workspace and then node while requests are pending fences both old results", async () => {
  const { windowScope, scope, client, leaf, leafClient } = workspacePair();
  const oldWorkspace = Promise.withResolvers<ReturnType<typeof snapshot>>();
  const oldNode = Promise.withResolvers<ReturnType<typeof snapshot>>();
  client.respond("get_local_file_tree", ({ worktreePath }: { worktreePath: string }) =>
    worktreePath === "/first" ? oldWorkspace.promise : oldNode.promise,
  );
  leafClient.respond("get_local_file_tree", snapshot("leaf.ts"));

  let activeScope: NodeScope = scope;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WindowScopeProvider windowScope={windowScope}>
      <NodeScopeProvider scope={activeScope}>{children}</NodeScopeProvider>
    </WindowScopeProvider>
  );
  const view = renderHook(
    ({ workspace }) => useFileSearch(undefined, workspace, true, "composer"),
    {
      wrapper,
      initialProps: { workspace: "/first" },
    },
  );
  await waitFor(() => expect(client.calls("get_local_file_tree")).toHaveLength(1));
  view.rerender({ workspace: "/same-path-on-both-nodes" });
  await waitFor(() => expect(client.calls("get_local_file_tree")).toHaveLength(2));
  activeScope = leaf;
  view.rerender({ workspace: "/same-path-on-both-nodes" });

  expect(view.result.current.flatFiles).toEqual([]);
  await waitFor(() => expect(view.result.current.flatFiles[0]?.relativePath).toBe("leaf.ts"));
  await act(async () => {
    oldWorkspace.resolve(snapshot("other-workspace.ts"));
    oldNode.resolve(snapshot("other-node.ts"));
  });
  expect(view.result.current.flatFiles.map((file) => file.relativePath)).toEqual(["leaf.ts"]);
  expect(leafClient.calls("get_local_file_tree")).toHaveLength(1);
});
