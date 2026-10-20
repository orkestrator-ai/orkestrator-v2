import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  environmentChangeResourceKey,
  type ChangeFileRow,
  type ChangeProjection,
} from "@orkestrator/protocol/change-resources";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { PublicCapabilities } from "@orkestrator/protocol/public-api";
import {
  encodePublicSessionId,
  nativeTabLogicalSessionKey,
  type PublicChangesHistory,
  type PublicChangesView,
} from "@orkestrator/protocol/public-api-resources";
import type { DiffScanEvent, DiffStatsTarget } from "../diff-stats-service.js";
import { createProject } from "../storage.js";
import { createHarness, type Harness } from "../change-tracking/service-test-support.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

/**
 * `changes.view` and `changes.history` through the real `public_action`
 * gateway, real storage and a real `ChangeTrackingService`. Every answer must
 * be the backend's own projection — the one `changes_get_view` gives UI
 * clients — never a count the public layer computed itself.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ENV = "env-1";
const KEY = environmentChangeResourceKey(ENV);

async function setup(options: { tracking?: boolean } = {}) {
  const harness = await createPublicApiHarness();
  cleanups.push(() => harness.cleanup());
  let tracking: Harness | null = null;
  if (options.tracking !== false) {
    tracking = createHarness();
    cleanups.push(() => tracking!.cleanup());
    harness.context.runtime.attachChangeTracking(tracking.service);
  }
  const project = await harness.storage.addProject(
    createProject("https://example.invalid/changes.git"),
  );
  // No worktree path: the backend's own scanner leaves it alone, so each
  // test decides exactly which scans the change tracker sees.
  await harness.storage.addEnvironment({
    id: ENV,
    projectId: project.id,
    name: "changes",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    setupScriptsComplete: true,
    setupPhase: "ready",
  });
  return { harness, tracking };
}

function target(repo: string): DiffStatsTarget {
  return { environmentId: ENV, comparisonRef: "main", kind: "local", worktreePath: repo };
}

function change(path: string, additions: number, deletions: number, extra: object = {}) {
  return { path, filename: path, directory: "", additions, deletions, status: "M", ...extra };
}

async function scan(tracking: Harness, changes: unknown[]): Promise<void> {
  const at = new Date().toISOString();
  const event: DiffScanEvent = {
    kind: "scanned",
    target: target(tracking.repo),
    result: {
      stats: { additions: 0, deletions: 0, filesChanged: changes.length, truncated: false },
      changes: changes as never,
      baseOid: "a".repeat(40),
    },
    changed: true,
    at,
    startedAt: at,
  };
  tracking.service.onDiffScanEvent(event);
  await tracking.service.environments.idle();
}

function backendProjection(tracking: Harness, resourceKey = KEY, pageSize?: number) {
  const view = tracking.service.getView({
    resourceKey,
    ...(pageSize !== undefined ? { pageSize } : {}),
  });
  if (view.kind !== "projection") throw new Error(`projection expected, got ${view.kind}`);
  return view.projection;
}

async function withTab(harness: PublicApiHarness, tabId: string) {
  await harness.storage.savePaneLayout(
    ENV,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: tabId,
            type: "agent-native",
            displayTitle: "agent",
            nativeAgentData: { environmentId: ENV, platform: "claude" },
          },
        ],
        activeTabId: tabId,
      },
    },
    0,
  );
  return encodePublicSessionId(ENV, tabId);
}

async function view(harness: PublicApiHarness, input: Record<string, unknown> = {}) {
  return harness.call<PublicChangesView>("changes.view", { environmentId: ENV, ...input });
}

describe("changes.view", () => {
  test("answers the backend's own projection, with unknown, partial and binary counts intact", async () => {
    const { harness, tracking } = await setup();
    await scan(tracking!, [
      change("a.ts", 3, 1),
      change("img.png", 0, 0, { binary: true }),
      change("big.log", 0, 0, { status: "?", countOmitted: true }),
    ]);
    const response = await view(harness);
    if (!response.ok) throw new Error(`changes.view failed: ${JSON.stringify(response.error)}`);
    const { projection, files } = response.result;
    expect(response.result.environmentId).toBe(ENV);
    expect(response.result.scope).toBe("environment");
    // The same object every UI client is given — not a recount.
    expect(projection).toEqual(backendProjection(tracking!));
    expect(projection.resourceKey).toBe(KEY);
    expect(projection.labelKey).toBe("changes.scope.environment-net");
    expect(projection.counters.changedFiles).toBe(3);
    expect(projection.counters.additions).toEqual({ value: 3, quality: "partial", bound: "none" });
    expect(files).toEqual({
      rows: projection.filePage!.rows,
      nextCursor: null,
      totalRows: 3,
    });
    const byPath = (path: string) => files.rows.find((row) => row.newPathDisplay === path)!;
    expect(byPath("img.png").additions.quality).toBe("not-applicable");
    expect(byPath("big.log").additions).toMatchObject({ value: null, quality: "unknown" });
    expect(byPath("a.ts").additions).toEqual({ value: 3, quality: "complete", bound: "exact" });
  });

  test("pages file rows with the backend's revision-pinned cursor", async () => {
    const { harness, tracking } = await setup();
    await scan(tracking!, [change("a.ts", 1, 0), change("b.ts", 2, 0), change("c.ts", 3, 0)]);
    const rows: ChangeFileRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const response = await view(harness, { pageSize: 1, ...(cursor ? { cursor } : {}) });
      if (!response.ok) throw new Error(JSON.stringify(response.error));
      expect(response.result.files.rows).toHaveLength(1);
      expect(response.result.files.totalRows).toBe(3);
      rows.push(...response.result.files.rows);
      cursor = response.result.files.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(rows.map((row) => row.newPathDisplay)).toEqual(
      backendProjection(tracking!).filePage!.rows.map((row) => row.newPathDisplay),
    );
  });

  test("a cursor from an earlier revision is cursor-expired, never mixed into a newer listing", async () => {
    const { harness, tracking } = await setup();
    await scan(tracking!, [change("a.ts", 1, 0), change("b.ts", 2, 0)]);
    const first = await view(harness, { pageSize: 1 });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const cursor = first.result.files.nextCursor!;
    expect(cursor).toEqual(expect.any(String));
    await scan(tracking!, [change("a.ts", 5, 0), change("c.ts", 1, 1), change("d.ts", 1, 0)]);
    const stale = await view(harness, { pageSize: 1, cursor });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("cursor-expired");
    expect(stale.error.exitCode).toBe(8);
    const garbage = await view(harness, { cursor: "not-a-cursor" });
    expect(!garbage.ok && garbage.error.code).toBe("cursor-expired");
  });

  test("before any measurement the projection says so instead of reporting zero", async () => {
    const { harness, tracking } = await setup();
    const response = await view(harness);
    if (!response.ok) throw new Error(JSON.stringify(response.error));
    const projection: ChangeProjection = response.result.projection;
    expect(projection).toEqual(backendProjection(tracking!));
    expect(projection.measurementId).toBeNull();
    expect(projection.hasFileChanges).toBeNull();
    expect(projection.counters.additions.value).toBeNull();
    expect(response.result.files).toEqual({ rows: [], nextCursor: null, totalRows: null });
  });

  test("validates its target and input", async () => {
    const { harness } = await setup();
    const missing = await harness.call("changes.view", { environmentId: "env-missing" });
    expect(!missing.ok && missing.error.code).toBe("not-found");
    for (const input of [{ scope: "thread" }, { pageSize: 0 }, { pageSize: 201 }, { extra: 1 }]) {
      const refused = await view(harness, input);
      expect({ input, code: !refused.ok && refused.error.code }).toEqual({
        input,
        code: "invalid-input",
      });
    }
  });

  test("without change tracking both actions are capability-unavailable and advertised so", async () => {
    const { harness } = await setup({ tracking: false });
    const response = await view(harness);
    expect(!response.ok && response.error.code).toBe("capability-unavailable");
    expect(!response.ok && response.error.exitCode).toBe(8);
    const history = await harness.call("changes.history", {
      sessionId: await withTab(harness, "agent"),
    });
    expect(!history.ok && history.error.code).toBe("capability-unavailable");
    const capabilities = await harness.call<PublicCapabilities>("capabilities", {});
    if (!capabilities.ok) throw new Error(JSON.stringify(capabilities.error));
    expect(capabilities.result.actions["changes.view"]).toEqual({
      version: 1,
      available: false,
      reason: "Change tracking is unavailable in this backend",
    });
    expect(capabilities.result.actions["changes.history"]?.available).toBe(false);
    expect(capabilities.result.actions["environment.get"]?.available).toBe(true);
  });

  test("capabilities advertise both actions when change tracking is attached", async () => {
    const { harness } = await setup();
    const capabilities = await harness.call<PublicCapabilities>("capabilities", {});
    if (!capabilities.ok) throw new Error(JSON.stringify(capabilities.error));
    expect(capabilities.result.actions["changes.view"]).toEqual({ version: 1, available: true });
    expect(capabilities.result.actions["changes.history"]).toEqual({
      version: 1,
      available: true,
    });
  });
});

describe("changes.history", () => {
  async function runTurn(tracking: Harness, tabId: string, requestId: string, work: () => void) {
    const logicalSessionKey = nativeTabLogicalSessionKey(ENV, tabId);
    await tracking.service.prepareTurnStart({
      environmentId: ENV,
      logicalSessionKey,
      requestId,
      provider: "claude",
    });
    tracking.service.markTurnDispatched(ENV, logicalSessionKey, requestId, "accepted");
    work();
    await tracking.service.finalizeTurn({ environmentId: ENV, logicalSessionKey, requestId });
  }

  test("lists the session's turns with the backend's projection of each", async () => {
    const { harness, tracking } = await setup();
    const sessionId = await withTab(harness, "agent");
    const empty = await harness.call<PublicChangesHistory>("changes.history", { sessionId });
    if (!empty.ok) throw new Error(JSON.stringify(empty.error));
    expect(empty.result).toEqual({ sessionId, entries: [], nextCursor: null });

    await runTurn(tracking!, "agent", "r1", () =>
      writeFileSync(join(tracking!.repo, "a.txt"), "one\nTWO\nthree\n"),
    );
    await runTurn(tracking!, "agent", "r2", () =>
      writeFileSync(join(tracking!.repo, "b.txt"), "new\n"),
    );
    const first = await harness.call<PublicChangesHistory>("changes.history", {
      sessionId,
      limit: 1,
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(first.result.entries).toHaveLength(1);
    const entry = first.result.entries[0]!;
    const projection = entry.projections[entry.turnResourceKey]!;
    expect(projection).toEqual(backendProjection(tracking!, entry.turnResourceKey, 0));
    expect(projection.filePage).toBeNull();
    expect(projection.counters.additions).toEqual({
      value: 2,
      quality: "complete",
      bound: "exact",
    });
    expect(projection.counters.deletions).toEqual({
      value: 1,
      quality: "complete",
      bound: "exact",
    });
    expect(first.result.nextCursor).toEqual(expect.any(String));

    const second = await harness.call<PublicChangesHistory>("changes.history", {
      sessionId,
      limit: 1,
      cursor: first.result.nextCursor,
    });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect(second.result.entries).toHaveLength(1);
    const later = second.result.entries[0]!;
    expect(later.turnId).not.toBe(entry.turnId);
    expect(later.projections[later.turnResourceKey]!.counters.changedFiles).toBe(1);
    expect(second.result.nextCursor).toBeNull();
  });

  test("a closed tab or an invalid handle is not-found", async () => {
    const { harness } = await setup();
    await withTab(harness, "agent");
    const closed = await harness.call("changes.history", {
      sessionId: encodePublicSessionId(ENV, "gone"),
    });
    expect(!closed.ok && closed.error.code).toBe("not-found");
    const invalid = await harness.call("changes.history", { sessionId: "ses_nope" });
    expect(!invalid.ok && invalid.error.code).toBe("not-found");
  });
});
