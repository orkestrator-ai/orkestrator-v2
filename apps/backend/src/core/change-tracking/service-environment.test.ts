import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import type { DiffScanEvent, DiffStatsTarget } from "../diff-stats-service.js";
import { createHarness, git, type Harness } from "./service-test-support.js";
import { SharedScanQueue } from "./shared-physical-work.js";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function setup() {
  const h = createHarness();
  harnesses.push(h);
  const target: DiffStatsTarget = {
    environmentId: "env-1",
    comparisonRef: "main",
    kind: "local",
    worktreePath: h.repo,
  };
  return { h, target, key: environmentChangeResourceKey("env-1") };
}

function scanned(
  target: DiffStatsTarget,
  changes: unknown[],
  extra: Partial<Extract<DiffScanEvent, { kind: "scanned" }>> = {},
): DiffScanEvent {
  const at = new Date().toISOString();
  return {
    kind: "scanned",
    target,
    result: {
      stats: { additions: 0, deletions: 0, filesChanged: changes.length, truncated: false },
      changes,
      baseOid: "a".repeat(40),
    },
    changed: true,
    at,
    startedAt: at,
    ...extra,
  };
}

const change = (
  path: string,
  additions: number,
  deletions: number,
  extra: Record<string, unknown> = {},
) => ({
  path,
  filename: path,
  directory: "",
  additions,
  deletions,
  status: "M",
  ...extra,
});

describe("environment-net projections", () => {
  test("badge and rows are one measurement; binary is n/a and uncounted is unknown", async () => {
    const { h, target, key } = setup();
    h.service.onDiffScanEvent(
      scanned(target, [
        change("a.ts", 3, 1),
        change("img.png", 0, 0, { binary: true }),
        change("big.log", 0, 0, { status: "?", countOmitted: true }),
      ]),
    );
    await h.service.environments.idle();
    const view = h.service.getView({ resourceKey: key });
    if (view.kind !== "projection") throw new Error("projection expected");
    const projection = view.projection;
    expect(projection.counters.changedFiles).toBe(3);
    expect(projection.counters.additions).toEqual({ value: 3, quality: "partial", bound: "none" });
    expect(projection.badge).toEqual({ visible: true, mode: "counts" });
    const rows = projection.filePage!.rows;
    expect(rows.find((row) => row.newPathDisplay === "img.png")?.additions.quality).toBe(
      "not-applicable",
    );
    expect(rows.find((row) => row.newPathDisplay === "big.log")?.additions.value).toBeNull();
    expect(projection.measurementId).toBe(
      h.service.projections.selectedMeasurement(key)!.measurementId,
    );
    const measurement = h.service.projections.selectedMeasurement(key)!;
    expect(measurement.baselineVersion).toBe(`main@${"a".repeat(40)}`);
  });

  test("measured zero is a hidden badge; a failed scan keeps the last result as stale", async () => {
    const { h, target, key } = setup();
    h.service.onDiffScanEvent(scanned(target, []));
    await h.service.environments.idle();
    let view = h.service.getView({ resourceKey: key });
    if (view.kind !== "projection") throw new Error("projection expected");
    expect(view.projection.hasFileChanges).toBe(false);
    expect(view.projection.badge).toEqual({ visible: false, mode: "none" });
    h.service.onDiffScanEvent({ kind: "failed", target, at: new Date().toISOString() });
    await h.service.environments.idle();
    view = h.service.getView({ resourceKey: key });
    if (view.kind !== "projection") throw new Error("projection expected");
    expect(view.projection.state).toBe("stale");
    expect(view.projection.counters.additions.value).toBe(0);
  });

  test("an unresolved ref is labelled, not presented as a merge-base comparison", async () => {
    const { h, target, key } = setup();
    const event = scanned(target, [change("a.ts", 1, 0)]);
    if (event.kind === "scanned") delete event.result.baseOid;
    h.service.onDiffScanEvent(event);
    await h.service.environments.idle();
    const measurement = h.service.projections.selectedMeasurement(key)!;
    expect(measurement.baselineVersion).toBe("ref:main");
    expect(measurement.completeness.reasons).toContain("baseline-mutable-ref");
  });

  test("removal answers deleted", async () => {
    const { h, target, key } = setup();
    h.service.onDiffScanEvent(scanned(target, [change("a.ts", 1, 0)]));
    h.service.onDiffScanEvent({
      kind: "removed",
      environmentId: "env-1",
      at: new Date().toISOString(),
    });
    await h.service.environments.idle();
    expect(h.service.getView({ resourceKey: key }).kind).toBe("deleted");
  });

  test("V03: a same-count content change invalidates live bodies", async () => {
    const { h, target, key } = setup();
    h.service.onDiffScanEvent({
      kind: "hint",
      target,
      paths: ["a.ts"],
      at: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const invalidation = h.events.find(
      (event) => (event.payload as { kind?: string }).kind === "content-invalidated",
    )?.payload as { resourceKey: string; pathIds: string[]; contentGeneration: number };
    expect(invalidation.resourceKey).toBe(key);
    expect(invalidation.pathIds).toEqual(["u:a.ts"]);
    expect(invalidation.contentGeneration).toBe(1);
  });

  test("live detail resolves a row to a new immutable file identity", async () => {
    const { h, target, key } = setup();
    const base = git(h.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(h.repo, "a.txt"), "one\nTWO\n");
    const event = scanned(target, [change("a.txt", 1, 1)]);
    if (event.kind === "scanned") event.result.baseOid = base;
    h.service.onDiffScanEvent(event);
    await h.service.environments.idle();
    const view = h.service.getView({ resourceKey: key });
    if (view.kind !== "projection") throw new Error("projection expected");
    const row = view.projection.filePage!.rows[0]!;
    const resolved = await h.service.diffBodies.resolveLiveDetail({
      resourceKey: key,
      revision: view.projection.revision,
      rowId: row.rowId,
    });
    expect(resolved.kind).toBe("identity");
    if (resolved.kind !== "identity") return;
    expect(resolved.identity.kind).toBe("file");
    const body = await h.service.diffBodies.getDiff({ diffIdentityId: resolved.identity.id });
    expect(
      body.kind === "body" && body.files[0]!.hunks[0]!.lines.some((line) => line.text === "TWO"),
    ).toBe(true);
    // A stale revision is refused rather than attached to newer bytes.
    const stale = await h.service.diffBodies.resolveLiveDetail({
      resourceKey: key,
      revision: view.projection.revision - 1,
      rowId: row.rowId,
    });
    expect(stale).toMatchObject({ kind: "error", error: { code: "stale-revision" } });
  });

  test("V05: a refresh never settles on a pass that started before it", async () => {
    const { h, target, key } = setup();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    let requested = false;
    (
      h.service as unknown as { options: { requestEnvironmentRefresh: () => void } }
    ).options.requestEnvironmentRefresh = () => {
      requested = true;
      // An older, slow pass finishes after the request.
      h.service.onDiffScanEvent(
        scanned(target, [], { startedAt: earlier, at: new Date().toISOString() }),
      );
      setTimeout(() => {
        const now = new Date().toISOString();
        h.service.onDiffScanEvent(
          scanned(target, [change("a.ts", 1, 0)], { startedAt: now, at: now }),
        );
      }, 250);
    };
    const result = await h.service.refresh({ resourceKey: key });
    expect(requested).toBe(true);
    expect(result.kind).toBe("settled");
    if (result.kind === "settled") expect(result.projection?.counters.changedFiles).toBe(1);
  });

  test("V09: equal scans of one physical worktree share work", async () => {
    const queue = new SharedScanQueue<number>();
    let executed = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const work = async () => {
      executed++;
      await gate;
      return executed;
    };
    const first = queue.run("k", work);
    const joined = Array.from({ length: 9 }, () => queue.run("k", work));
    release();
    await first;
    await Promise.all(joined);
    // One running pass plus one shared fresh pass, however many callers.
    expect(executed).toBe(2);
    expect(queue.stats().joined).toBe(8);
  });
});

test("equal totals with a different file set advance measurement identity and file page", async () => {
  const { h, target, key } = setup();
  h.service.onDiffScanEvent(scanned(target, [change("a.ts", 1, 1)]));
  await h.service.environments.idle();
  const first = h.service.projections.selectedMeasurement(key)!;
  h.service.onDiffScanEvent(scanned(target, [change("b.ts", 1, 1)]));
  await h.service.environments.idle();
  const second = h.service.projections.selectedMeasurement(key)!;
  expect(second.measurementId).not.toBe(first.measurementId);
  const view = h.service.getView({ resourceKey: key });
  expect(view.kind === "projection" && view.projection.filePage?.rows[0]?.newPathDisplay).toBe(
    "b.ts",
  );
});
