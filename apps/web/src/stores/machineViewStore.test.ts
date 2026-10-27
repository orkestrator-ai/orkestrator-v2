import { afterEach, expect, test } from "bun:test";
import { MAX_RECENT_KEYS, useMachineViewStore, withRecentKeys } from "./machineViewStore";

const original = useMachineViewStore.getState();
afterEach(() => useMachineViewStore.setState(original, true));

test("recency deduplicates incoming keys, ignores empty keys and preserves newest-first order", () => {
  expect(withRecentKeys(["old", "used", "older"], ["used", "", "new", "used"])).toEqual([
    "used",
    "new",
    "old",
    "older",
  ]);
  useMachineViewStore.setState({ recentKeys: ["old", "used", "older"] });
  useMachineViewStore.getState().recordRecent(["used", "", "new", "used"]);
  expect(useMachineViewStore.getState().recentKeys).toEqual(["used", "new", "old", "older"]);
});

test("recording the current prefix or no keys is an idempotent no-op", () => {
  const keys = ["new", "old"];
  expect(withRecentKeys(keys, ["new", "new", ""])).toBe(keys);
  expect(withRecentKeys(keys, [])).toBe(keys);
  useMachineViewStore.setState({ recentKeys: keys });
  const before = useMachineViewStore.getState();
  useMachineViewStore.getState().recordRecent(["new", "old", "new"]);
  expect(useMachineViewStore.getState()).toBe(before);
  useMachineViewStore.getState().recordRecent([]);
  expect(useMachineViewStore.getState()).toBe(before);
});

test("recency is bounded to 64 newest keys across repeated updates and oversized batches", () => {
  const keys = Array.from({ length: MAX_RECENT_KEYS + 10 }, (_, i) => `key-${i}`);
  expect(withRecentKeys([], keys)).toEqual(keys.slice(0, MAX_RECENT_KEYS));
  useMachineViewStore.getState().recordRecent(keys);
  useMachineViewStore.getState().recordRecent(["new"]);
  expect(useMachineViewStore.getState().recentKeys).toEqual([
    "new",
    ...keys.slice(0, MAX_RECENT_KEYS - 1),
  ]);
});
