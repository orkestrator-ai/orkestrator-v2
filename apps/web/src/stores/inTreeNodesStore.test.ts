import { afterEach, expect, test } from "bun:test";
import {
  developmentInTreeOverride,
  isInTreeNode,
  MAX_IN_TREE_NODES,
  normalizeInTreeNodes,
  useInTreeNodesStore,
} from "./inTreeNodesStore";

afterEach(() => useInTreeNodesStore.setState({ nodes: [] }));

test("the setting is empty by default and turns nodes on and off for this window", () => {
  expect(useInTreeNodesStore.getState().nodes).toEqual([]);
  const { setInTree } = useInTreeNodesStore.getState();
  setInTree("bk_a", true);
  setInTree("bk_b", true);
  setInTree("bk_a", true);
  expect(useInTreeNodesStore.getState().nodes).toEqual(["bk_b", "bk_a"]);
  setInTree("bk_b", false);
  expect(useInTreeNodesStore.getState().nodes).toEqual(["bk_a"]);
  setInTree("", true);
  expect(useInTreeNodesStore.getState().nodes).toEqual(["bk_a"]);
});

test("a stored list is bounded and deduplicated; anything else reads as empty", () => {
  expect(normalizeInTreeNodes(undefined)).toEqual([]);
  expect(normalizeInTreeNodes("bk_a")).toEqual([]);
  expect(normalizeInTreeNodes(["bk_a", 3, "", "bk_a", "x".repeat(201), "bk_b"])).toEqual([
    "bk_a",
    "bk_b",
  ]);
  const many = Array.from({ length: MAX_IN_TREE_NODES + 5 }, (_, index) => `bk_${index}`);
  expect(normalizeInTreeNodes(many)).toHaveLength(MAX_IN_TREE_NODES);
});

test("the development override adds nodes in a development build only", () => {
  expect(developmentInTreeOverride({ DEV: false, VITE_ORKESTRATOR_IN_TREE_NODES: "*" })).toEqual(
    new Set(),
  );
  expect(developmentInTreeOverride({ DEV: true, VITE_ORKESTRATOR_IN_TREE_NODES: "*" })).toBe("*");
  const listed = developmentInTreeOverride({
    DEV: true,
    VITE_ORKESTRATOR_IN_TREE_NODES: " bk_a, ,bk_b ",
  });
  expect(listed).toEqual(new Set(["bk_a", "bk_b"]));
  expect(isInTreeNode("bk_a", [], listed)).toBe(true);
  expect(isInTreeNode("bk_c", [], listed)).toBe(false);
  expect(isInTreeNode("bk_c", ["bk_c"], listed)).toBe(true);
  expect(isInTreeNode("bk_z", [], "*")).toBe(true);
  expect(isInTreeNode("bk_a", [], new Set())).toBe(false);
});
