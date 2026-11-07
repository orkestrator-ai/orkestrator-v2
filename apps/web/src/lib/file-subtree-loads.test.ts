import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { StoreApi } from "zustand/vanilla";
import type { FileNode } from "@/lib/backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { filesPanelStore, type FilesPanelState } from "@/stores/filesPanelStore";
import { loadFileSubtree as loadFileSubtreeIn } from "./file-subtree-loads";

let windowScope: WindowScope;
let scope: NodeScope;
let store: StoreApi<FilesPanelState>;
type LoadArgs =
  Parameters<typeof loadFileSubtreeIn> extends [NodeScope, ...infer Rest] ? Rest : never;
const loadFileSubtree = (...args: LoadArgs) => loadFileSubtreeIn(scope, ...args);

const fresh = (children: FileNode[] = [], digest = "") => ({
  unchanged: false,
  digest,
  value: { children, truncated: false },
});

beforeEach(() => {
  windowScope = new WindowScope();
  scope = windowScope.open({ role: "command", client: new FakeNodeClient() });
  store = scope.store(filesPanelStore);
  store.setState({
    fileSubtreeKey: "target",
    fileSubtrees: {},
    fileSubtreeDigests: {},
    folderLoadTokens: new Map(),
    loadingFolders: [],
    failedFolders: [],
    expandedFolders: [],
  });
});
afterEach(() => windowScope.dispose());

test("initial loads and refreshes share a four-read concurrency limit across mounts", async () => {
  const paths = Array.from({ length: 12 }, (_, i) => `dir-${i}`);
  store.setState({ expandedFolders: paths });
  let running = 0;
  let maximum = 0;
  const releases: Array<() => void> = [];
  const read = async () => {
    running += 1;
    maximum = Math.max(maximum, running);
    await new Promise<void>((resolve) => releases.push(resolve));
    running -= 1;
    return fresh();
  };
  const loads = paths.map((path) => loadFileSubtree("target", path, false, read));
  const refreshes = paths.map((path) => loadFileSubtree("target", path, true, read));
  expect(running).toBe(4);
  for (let i = 0; i < 12; i += 1) {
    releases.splice(0).forEach((release) => release());
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  }
  await Promise.all([...loads, ...refreshes]);
  expect(maximum).toBe(4);
  expect(running).toBe(0);
  expect(Object.keys(store.getState().fileSubtrees)).toHaveLength(12);
});

test("equivalent refreshes queue one follow-up and collapsed queued work never starts", async () => {
  store.setState({ expandedFolders: ["dir"] });
  const releases: Array<() => void> = [];
  let reads = 0;
  const read = async () => {
    reads += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    return fresh();
  };
  const first = loadFileSubtree("target", "dir", false, read);
  const refreshes = Array.from({ length: 3 }, () => loadFileSubtree("target", "dir", true, read));
  releases.shift()!();
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  expect(reads).toBe(2);
  store.getState().setFolderExpanded("dir", false);
  releases.shift()!();
  await Promise.all([first, ...refreshes]);
  expect(store.getState().fileSubtrees).toEqual({});
});

test("a collapsed branch waiting for admission never calls its reader", async () => {
  const paths = ["a", "b", "c", "d", "parent", "parent/child"];
  store.setState({ expandedFolders: paths });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const read = async () => {
    reads += 1;
    await gate;
    return fresh();
  };
  const loads = paths.map((path) => loadFileSubtree("target", path, false, read));
  expect(reads).toBe(4);
  store.getState().setFolderExpanded("parent", false);
  release();
  await Promise.all(loads);
  expect(reads).toBe(4);
  expect(store.getState().loadingFolders).toEqual([]);
});

test("a directory re-read with its digest and found unchanged keeps what is held", async () => {
  store.setState({ expandedFolders: ["dir"] });
  const file: FileNode = { name: "a.txt", path: "dir/a.txt", isDirectory: false };
  const asked: Array<string | undefined> = [];

  await loadFileSubtree("target", "dir", false, async (digest) => {
    asked.push(digest);
    return fresh([file], "digest-1");
  });
  const held = store.getState().fileSubtrees;

  await loadFileSubtree("target", "dir", true, async (digest) => {
    asked.push(digest);
    return { unchanged: true, digest: "digest-1" };
  });

  expect(asked).toEqual([undefined, "digest-1"]);
  // Same object, so nothing that merges or renders the tree has any work to do.
  expect(store.getState().fileSubtrees).toBe(held);
  expect(store.getState().loadingFolders).toEqual([]);
  expect(store.getState().folderLoadTokens.size).toBe(0);
});

test("a changed directory replaces the contents and the digest", async () => {
  store.setState({ expandedFolders: ["dir"] });
  const file = (name: string): FileNode => ({ name, path: `dir/${name}`, isDirectory: false });
  await loadFileSubtree("target", "dir", false, async () => fresh([file("a.txt")], "digest-1"));
  await loadFileSubtree("target", "dir", true, async () => fresh([file("b.txt")], "digest-2"));
  expect(store.getState().fileSubtrees.dir?.children.map(({ name }) => name)).toEqual(["b.txt"]);
  expect(store.getState().fileSubtreeDigests.dir).toBe("digest-2");
});

test("a backend that sends no digest is asked afresh every time", async () => {
  store.setState({ expandedFolders: ["dir"] });
  const asked: Array<string | undefined> = [];
  for (const reload of [false, true]) {
    await loadFileSubtree("target", "dir", reload, async (digest) => {
      asked.push(digest);
      return fresh();
    });
  }
  expect(asked).toEqual([undefined, undefined]);
});

test("a failed re-read keeps the digest, and an unchanged answer then clears the failure", async () => {
  store.setState({ expandedFolders: ["dir"] });
  await loadFileSubtree("target", "dir", false, async () => fresh([], "digest-1"));
  const held = store.getState().fileSubtrees.dir;
  await loadFileSubtree("target", "dir", true, async () => {
    throw new Error("read failed");
  });
  expect(store.getState().failedFolders).toEqual(["dir"]);
  expect(store.getState().fileSubtrees.dir).toBe(held!);

  await loadFileSubtree("target", "dir", true, async () => ({
    unchanged: true,
    digest: "digest-1",
  }));
  expect(store.getState().failedFolders).toEqual([]);
  expect(store.getState().fileSubtrees.dir).toBe(held!);
});

test("a retried or collapsed directory is read without a digest", async () => {
  store.setState({ expandedFolders: ["dir"] });
  const asked: Array<string | undefined> = [];
  const read = async (digest: string | undefined) => {
    asked.push(digest);
    return fresh([], "digest-1");
  };
  await loadFileSubtree("target", "dir", false, read);
  store.getState().retryFolderLoad("dir");
  await loadFileSubtree("target", "dir", false, read);
  store.getState().setFolderExpanded("dir", false);
  expect(store.getState().fileSubtreeDigests).toEqual({});
  store.getState().setFolderExpanded("dir", true);
  await loadFileSubtree("target", "dir", false, read);
  expect(asked).toEqual([undefined, undefined, undefined]);
});

test("each node has its own store and its own four-read limit", async () => {
  const leaf = windowScope.open({
    role: "leaf",
    client: new FakeNodeClient({ nodeId: "bk_leaf" as BackendId }),
  });
  const leafStore = leaf.store(filesPanelStore);
  const paths = ["a", "b", "c", "d"];
  store.setState({ expandedFolders: paths });
  leafStore.setState({
    fileSubtreeKey: "target",
    expandedFolders: paths,
    fileSubtrees: {},
    folderLoadTokens: new Map(),
  });
  let running = 0;
  const releases: Array<() => void> = [];
  const read = async () => {
    running += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    running -= 1;
    return fresh();
  };
  const loads = [
    ...paths.map((path) => loadFileSubtree("target", path, false, read)),
    ...paths.map((path) => loadFileSubtreeIn(leaf, "target", path, false, read)),
  ];
  // Four on each node: neither waits for the other's reads.
  expect(running).toBe(8);
  releases.splice(0).forEach((release) => release());
  await Promise.all(loads);
  expect(Object.keys(store.getState().fileSubtrees)).toEqual(paths);
  expect(Object.keys(leafStore.getState().fileSubtrees)).toEqual(paths);
});
