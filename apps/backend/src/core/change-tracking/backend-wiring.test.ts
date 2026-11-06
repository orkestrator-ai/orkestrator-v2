import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import * as containerExec from "../commands-container-exec.js";
import { DiffStatsTracking } from "../diff-stats-tracking.js";
import type { DiffStatsTarget } from "../diff-stats-service.js";
import { createBackendChangeTracking } from "./backend-wiring.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test("production factory connects manual refresh to remote invalidation before a fresh scan", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ork-refresh-wiring-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const exec = spyOn(containerExec, "dockerExec").mockResolvedValue("");
  cleanups.push(() => exec.mockRestore());
  const owner = new DiffStatsTracking({ emit: () => undefined });
  cleanups.push(() => owner.shutdown());
  // This is the factory and owner passed by index.ts, with no private option mutation.
  const service = createBackendChangeTracking({
    dataDir,
    storage: {
      getEnvironment: async () => {
        throw new Error("unused");
      },
      loadConfig: async () => {
        throw new Error("unused");
      },
    },
    emit: () => undefined,
    diffStats: owner,
  });
  cleanups.push(() => service.shutdown());
  const target: DiffStatsTarget = {
    environmentId: "container-env",
    kind: "container",
    containerId: "c1",
    comparisonRef: "main",
  };
  const calls: string[] = [];
  const invalidate = spyOn(owner.containerGitFetchPolicy, "invalidate").mockImplementation(
    ({ containerId }, reason) => {
      calls.push(`invalidate ${containerId} ${reason}`);
    },
  );
  cleanups.push(() => invalidate.mockRestore());
  const refresh = spyOn(owner.service, "refresh").mockImplementation((id) => {
    calls.push(`scan ${id}`);
    const at = new Date().toISOString();
    service.onDiffScanEvent({
      kind: "scanned",
      target,
      changed: true,
      at,
      startedAt: at,
      result: {
        stats: { additions: 0, deletions: 0, filesChanged: 0, truncated: false },
        changes: [],
        baseOid: "a".repeat(40),
      },
    });
  });
  cleanups.push(() => refresh.mockRestore());
  owner.service.track(target);
  const result = await service.refresh({
    resourceKey: environmentChangeResourceKey(target.environmentId),
  });
  expect(result.kind).toBe("settled");
  expect(calls).toEqual(["invalidate c1 explicit", "scan container-env"]);
});
