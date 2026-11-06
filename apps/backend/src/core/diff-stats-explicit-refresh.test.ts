import { afterEach, expect, spyOn, test } from "bun:test";
import * as containerExec from "./commands-container-exec.js";
import { DiffStatsTracking } from "./diff-stats-tracking.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A tracking owner whose container reads answer nothing; no Docker is reached. */
function tracking(): { tracking: DiffStatsTracking; calls: string[] } {
  const exec = spyOn(containerExec, "dockerExec").mockResolvedValue("");
  const owner = new DiffStatsTracking({ emit: () => undefined });
  const calls: string[] = [];
  const invalidate = spyOn(owner.containerGitFetchPolicy, "invalidate").mockImplementation(
    (lookup, reason) => {
      calls.push(`invalidate ${lookup.containerId} ${reason}`);
    },
  );
  const refresh = spyOn(owner.service, "refresh").mockImplementation((id) => {
    calls.push(`refresh ${id}`);
  });
  cleanups.push(() => {
    owner.shutdown();
    exec.mockRestore();
    invalidate.mockRestore();
    refresh.mockRestore();
  });
  return { tracking: owner, calls };
}

test("an explicit refresh of a container asks for its remote before it scans", () => {
  const { tracking: owner, calls } = tracking();
  owner.service.track({
    environmentId: "container-env",
    kind: "container",
    containerId: "c1",
    comparisonRef: "main",
  });
  expect(owner.service.trackedContainerId("container-env")).toBe("c1");
  owner.refreshExplicitly("container-env");
  expect(calls).toEqual(["invalidate c1 explicit", "refresh container-env"]);
});

test("an explicit refresh of a local or untracked environment only scans", () => {
  const { tracking: owner, calls } = tracking();
  owner.service.track({
    environmentId: "local-env",
    kind: "local",
    worktreePath: "/nonexistent/worktree",
    comparisonRef: "main",
  });
  expect(owner.service.trackedContainerId("local-env")).toBeUndefined();
  owner.refreshExplicitly("local-env");
  owner.refreshExplicitly("unknown-env");
  expect(calls).toEqual(["refresh local-env", "refresh unknown-env"]);
});
