import { afterEach, expect, test } from "bun:test";
import {
  applyProjectSnapshot,
  getProjectMutationVersion,
  invalidateProjectSnapshots,
  useProjectStore,
} from "./projectStore";
const initial = useProjectStore.getState();
afterEach(() => useProjectStore.setState(initial, true));

test("empty successful snapshots are loaded, while the initial idle store and stale snapshots are not", () => {
  useProjectStore.setState({ projects: [], isLoading: false, hasLoaded: false });
  expect(useProjectStore.getState().hasLoaded).toBe(false);
  const stale = getProjectMutationVersion();
  invalidateProjectSnapshots();
  expect(applyProjectSnapshot([], stale)).toBe(false);
  expect(useProjectStore.getState().hasLoaded).toBe(false);
  expect(applyProjectSnapshot([], getProjectMutationVersion())).toBe(true);
  expect(useProjectStore.getState().hasLoaded).toBe(true);
});
