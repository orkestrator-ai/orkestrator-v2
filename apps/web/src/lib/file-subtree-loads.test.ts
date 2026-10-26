import { beforeEach, expect, test } from "bun:test";
import { useFilesPanelStore as store } from "@/stores/filesPanelStore";
import { loadFileSubtree } from "./file-subtree-loads";

beforeEach(() =>
  store.setState({
    fileSubtreeKey: "target",
    fileSubtrees: {},
    folderLoadTokens: new Map(),
    loadingFolders: [],
    failedFolders: [],
    expandedFolders: [],
  }),
);

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
    return { children: [], truncated: false };
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
    return { children: [], truncated: false };
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
    return { children: [], truncated: false };
  };
  const loads = paths.map((path) => loadFileSubtree("target", path, false, read));
  expect(reads).toBe(4);
  store.getState().setFolderExpanded("parent", false);
  release();
  await Promise.all(loads);
  expect(reads).toBe(4);
  expect(store.getState().loadingFolders).toEqual([]);
});
