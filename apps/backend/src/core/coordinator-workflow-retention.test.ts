import { describe, expect, test } from "bun:test";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";

import {
  COORDINATOR_WORKFLOW_CLEANUP_BATCH,
  COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS,
  COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR,
  MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS,
  selectCoordinatorWorkflowsToClear,
} from "./coordinator-workflow-retention.js";
import { createEnvironment, createProject } from "./storage.js";
import { readStoredValue, seedStore, withTemporaryStorage } from "./storage-test-support.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const OLD = "2026-10-01T00:00:00.000Z";

/** A multi-review the coordinator was already told finished: plain history. */
function finished(
  id: string,
  overrides: Partial<CoordinatorWorkflowAssociation> = {},
): CoordinatorWorkflowAssociation {
  return {
    id,
    projectId: "project-1",
    coordinatorId: "coordinator-1",
    conversationId: "conversation-1",
    kind: "multi-review",
    resourceId: `review-${id}`,
    requestId: `request-${id}`,
    payloadHash: `hash-${id}`,
    createdAt: OLD,
    terminalNotifiedAt: OLD,
    ...overrides,
  };
}

function minutesAgo(minutes: number, from = NOW): string {
  return new Date(from - minutes * 60_000).toISOString();
}

function select(
  workflows: CoordinatorWorkflowAssociation[],
  options: { environments?: string[]; batch?: number } = {},
): Set<string> {
  const environments = new Set(options.environments ?? []);
  return selectCoordinatorWorkflowsToClear({
    workflows,
    environmentExists: (id) => environments.has(id),
    now: NOW,
    ...(options.batch !== undefined ? { batch: options.batch } : {}),
  });
}

describe("selectCoordinatorWorkflowsToClear", () => {
  test("hiding work leaves cleanup, replay, mail ownership and wake protections unchanged", () => {
    const workflows = [
      finished("expired"),
      finished("replay", { createdAt: minutesAgo(1) }),
      finished("mail-owner", { kind: "environment", resourceId: "live", baseCommit: "abc" }),
      finished("status-wake", { kind: "pull-request", terminalNotifiedAt: undefined }),
      finished("outcome-wake", { workerOutcome: { environmentId: "gone", observedAt: OLD } }),
    ];
    const expected = new Set(["expired"]);
    expect(select(workflows, { environments: ["live"] })).toEqual(expected);
    expect(
      select(
        workflows.map((item) => ({ ...item, workHiddenAt: minutesAgo(1) })),
        {
          environments: ["live"],
        },
      ),
    ).toEqual(expected);
  });

  test("keeps creation provenance for existing pipeline and graph environments", () => {
    const records = [
      finished("pipeline", { kind: "build-pipeline", createdEnvironmentId: "live" }),
      finished("graph", { kind: "graph-run", createdEnvironmentId: "live" }),
      finished("remote", {
        kind: "build-pipeline",
        nodeId: "leaf",
        createdEnvironmentId: "remote-live",
      }),
      finished("deleted", { kind: "graph-run", createdEnvironmentId: "gone" }),
    ];
    expect(select(records, { environments: ["live"] })).toEqual(new Set(["deleted"]));
  });

  test("keeps a remote creation intent until late provisioning identifies the environment", () => {
    const records = [
      finished("pending-provision", {
        kind: "build-pipeline",
        nodeId: "leaf",
        createsEnvironment: true,
      }),
      finished("existing-target", {
        kind: "build-pipeline",
        nodeId: "leaf",
        createsEnvironment: false,
      }),
    ];
    expect(select(records)).toEqual(new Set(["existing-target"]));
  });

  test("settled terminal or deleted remote creation intents expire after their observation replay window", () => {
    for (const terminalNotifiedAt of [undefined, OLD]) {
      const settled = finished("remote-settled", {
        kind: "build-pipeline",
        nodeId: "leaf",
        createsEnvironment: true,
        terminalNotifiedAt,
        environmentCreationSettledAt: OLD,
      });
      expect(select([settled])).toEqual(new Set([settled.id]));
      expect(select([{ ...settled, environmentCreationSettledAt: minutesAgo(1) }])).toEqual(
        new Set(),
      );
      expect(select([{ ...settled, pending: true }])).toEqual(new Set());
    }
  });

  test("clears the oldest finished records first, up to the batch", () => {
    const workflows = [
      finished("c", { createdAt: "2026-09-03T00:00:00.000Z" }),
      finished("a", { createdAt: "2026-09-01T00:00:00.000Z" }),
      finished("b", { createdAt: "2026-09-02T00:00:00.000Z" }),
    ];
    expect([...select(workflows, { batch: 2 })]).toEqual(["a", "b"]);
  });

  test("keeps records that are pending, unreported, or have a live delegation", () => {
    const workflows = [
      finished("pending", { pending: true, claimPid: 1, terminalNotifiedAt: undefined }),
      finished("unreported", { terminalNotifiedAt: undefined }),
      finished("follow-live", { kind: "pull-request", terminalNotifiedAt: undefined }),
      finished("running", {
        kind: "environment",
        resourceId: "gone-env",
        delegation: { requestedAt: OLD, workerTabId: "tab", state: "running" },
      }),
      finished("unwoken", {
        kind: "environment",
        resourceId: "gone-env",
        delegation: {
          requestedAt: OLD,
          workerTabId: "tab-2",
          state: "completed",
          completedAt: OLD,
        },
      }),
      finished("waiting", {
        kind: "environment",
        resourceId: "gone-env",
        delegation: {
          requestedAt: OLD,
          workerTabId: "tab-3",
          state: "running",
          waiting: { since: OLD },
        },
      }),
    ];
    expect(select(workflows).size).toBe(0);
  });

  test("keeps a review a live pull-request follow still points at", () => {
    const workflows = [
      finished("review"),
      finished("follow", {
        kind: "pull-request",
        terminalNotifiedAt: undefined,
        pullRequest: { source: "multi-review", reviewAssociationId: "review" },
      }),
      finished("ended-follow-review"),
      finished("ended-follow", {
        kind: "pull-request",
        pullRequest: { source: "multi-review", reviewAssociationId: "ended-follow-review" },
      }),
    ];
    expect(select(workflows)).toEqual(new Set(["ended-follow-review", "ended-follow"]));
  });

  test("keeps a finished pipeline whose worker outcome watch is still live", () => {
    const pipeline = (id: string, workerOutcome: CoordinatorWorkflowAssociation["workerOutcome"]) =>
      finished(id, { kind: "build-pipeline", resourceId: `pipeline-${id}`, workerOutcome });
    const workflows = [
      pipeline("watching", { environmentId: "env-1", observedAt: OLD, prState: "open" }),
      pipeline("merged", {
        environmentId: "env-2",
        observedAt: OLD,
        ended: { key: "merged:abc", at: OLD, notified: true },
      }),
      pipeline("never-watched", undefined),
    ];
    expect(select(workflows)).toEqual(new Set(["merged", "never-watched"]));
  });

  test("keeps an existing environment's launch record and newest delegation per tab", () => {
    const delegation = (requestedAt: string, workerTabId = "tab") => ({
      requestedAt,
      workerTabId,
      state: "completed" as const,
      completedAt: requestedAt,
      wokenAt: requestedAt,
    });
    const environment = (id: string, overrides: Partial<CoordinatorWorkflowAssociation>) =>
      finished(id, { kind: "environment", terminalNotifiedAt: undefined, ...overrides });
    const workflows = [
      environment("launch", { resourceId: "live", baseCommit: "abc", delegation: delegation(OLD) }),
      environment("older-delegation", { resourceId: "live", delegation: delegation(OLD) }),
      environment("newest-delegation", { resourceId: "live", delegation: delegation(OLD) }),
      environment("other-tab", { resourceId: "live", delegation: delegation(OLD, "tab-2") }),
      environment("plain-launch", { resourceId: "live" }),
      environment("gone-launch", { resourceId: "gone", baseCommit: "abc" }),
      environment("gone-delegation", { resourceId: "gone", delegation: delegation(OLD) }),
      environment("remote-launch", { resourceId: "remote", nodeId: "bk_node" }),
      environment("remote-old", {
        resourceId: "remote",
        nodeId: "bk_node",
        delegation: delegation(OLD),
      }),
      environment("remote-newest", {
        resourceId: "remote",
        nodeId: "bk_node",
        delegation: delegation(OLD),
      }),
    ];
    expect(select(workflows, { environments: ["live"] })).toEqual(
      new Set(["older-delegation", "gone-launch", "gone-delegation", "remote-old"]),
    );
  });

  test("keeps anything created inside the replay window", () => {
    const workflows = [
      finished("recent", { createdAt: minutesAgo(60), terminalNotifiedAt: minutesAgo(30) }),
      finished("edge", {
        createdAt: new Date(NOW - COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS + 1).toISOString(),
      }),
      finished("old", {
        createdAt: new Date(NOW - COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS).toISOString(),
      }),
      finished("unreadable", { createdAt: "not a date" }),
    ];
    expect(select(workflows)).toEqual(new Set(["unreadable", "old"]));
  });
});

/** A store already holding `workflows`, as the backend left it. */
function seedWorkflows(dataDir: string, workflows: CoordinatorWorkflowAssociation[]): void {
  seedStore(dataDir, "coordinators.json", {
    version: 1,
    revision: 1,
    workspaces: {},
    workflows,
    actionReceipts: [],
  });
}

function storedWorkflows(dataDir: string): CoordinatorWorkflowAssociation[] {
  return (
    readStoredValue<{ workflows: CoordinatorWorkflowAssociation[] }>(dataDir, "coordinators.json")
      ?.workflows ?? []
  );
}

function fresh(id: string): CoordinatorWorkflowAssociation {
  return {
    id,
    projectId: "project-1",
    coordinatorId: "coordinator-1",
    conversationId: "conversation-1",
    kind: "build-pipeline",
    resourceId: `pipeline-${id}`,
    requestId: `request-${id}`,
    payloadHash: `hash-${id}`,
    createdAt: new Date().toISOString(),
  };
}

/** `count` running delegations: records that must never be cleared. */
function active(count: number, prefix = "active"): CoordinatorWorkflowAssociation[] {
  return Array.from({ length: count }, (_, index) =>
    finished(`${prefix}-${index}`, {
      kind: "environment",
      resourceId: `env-${index}`,
      terminalNotifiedAt: undefined,
      delegation: { requestedAt: OLD, workerTabId: "tab", state: "running" },
    }),
  );
}

function history(count: number): CoordinatorWorkflowAssociation[] {
  return Array.from({ length: count }, (_, index) =>
    finished(`history-${String(index).padStart(4, "0")}`, {
      createdAt: new Date(Date.parse(OLD) + index * 1000).toISOString(),
    }),
  );
}

describe("coordinator workflow store cleanup", () => {
  test("the real store reclaims settled remote creation intents at capacity", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const rows = history(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS).map((row, index) => ({
        ...row,
        kind: "build-pipeline" as const,
        nodeId: "leaf",
        createsEnvironment: true,
        terminalNotifiedAt: undefined,
        ...(index === 0 ? {} : { environmentCreationSettledAt: OLD }),
      }));
      seedWorkflows(dataDir, rows);
      await storage.coordinators.saveCoordinatorWorkflowAssociation(fresh("after-remote-cleanup"));
      const ids = new Set(storedWorkflows(dataDir).map((row) => row.id));
      expect(ids.has(rows[0]!.id)).toBe(true);
      expect(ids.has(rows[1]!.id)).toBe(false);
      expect(ids.has("after-remote-cleanup")).toBe(true);
      expect(ids.size).toBe(
        MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - COORDINATOR_WORKFLOW_CLEANUP_BATCH + 1,
      );
    });
  });

  test("a full store clears one batch of its oldest finished records and accepts the new one", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const finishedCount = 500;
      seedWorkflows(dataDir, [
        ...active(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - finishedCount),
        ...history(finishedCount),
      ]);

      const saved = await storage.coordinators.saveCoordinatorWorkflowAssociation(fresh("new"));
      expect(saved.id).toBe("new");

      const after = storedWorkflows(dataDir);
      expect(after).toHaveLength(
        MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - COORDINATOR_WORKFLOW_CLEANUP_BATCH + 1,
      );
      const ids = new Set(after.map((item) => item.id));
      // Every active record survives; the oldest finished ones are the ones gone.
      for (const record of active(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - finishedCount))
        expect(ids.has(record.id)).toBe(true);
      expect(ids.has("history-0000")).toBe(false);
      expect(
        ids.has(`history-${String(COORDINATOR_WORKFLOW_CLEANUP_BATCH - 1).padStart(4, "0")}`),
      ).toBe(false);
      expect(
        ids.has(`history-${String(COORDINATOR_WORKFLOW_CLEANUP_BATCH).padStart(4, "0")}`),
      ).toBe(true);
      expect(ids.has("new")).toBe(true);
    });
  });

  test("the batch leaves room, so the next inserts do not clear anything", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      seedWorkflows(dataDir, history(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS));
      await storage.coordinators.saveCoordinatorWorkflowAssociation(fresh("first"));
      const afterFirst = storedWorkflows(dataDir).length;
      expect(afterFirst).toBe(
        MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - COORDINATOR_WORKFLOW_CLEANUP_BATCH + 1,
      );
      for (const id of ["second", "third", "fourth"]) {
        await storage.coordinators.reserveCoordinatorWorkflowAssociation(fresh(id));
      }
      expect(storedWorkflows(dataDir)).toHaveLength(afterFirst + 3);
    });
  });

  test("every insert path makes room the same way", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      seedWorkflows(dataDir, history(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS));
      const reserved = await storage.coordinators.reserveCoordinatorWorkflowAssociation(
        fresh("reserved"),
      );
      expect(reserved.claimed).toBe(true);

      seedWorkflows(dataDir, history(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS));
      const follow = await storage.coordinators.followCoordinatorPullRequest({
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        environmentId: "env-1",
        requestId: "follow-request",
        source: "create-pr",
      });
      expect(storedWorkflows(dataDir).some((item) => item.id === follow.id)).toBe(true);
    });
  });

  test("an existing environment's launch record survives cleanup", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const project = await storage.addProject(createProject("https://example.invalid/repo.git"));
      const environment = await storage.addEnvironment(createEnvironment(project.id));
      const launch = finished("launch", {
        kind: "environment",
        resourceId: environment.id,
        baseCommit: "abc123",
        terminalNotifiedAt: undefined,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const goneLaunch = { ...launch, id: "gone-launch", resourceId: "deleted-env" };
      seedWorkflows(dataDir, [
        launch,
        goneLaunch,
        ...history(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - 2),
      ]);
      await storage.coordinators.saveCoordinatorWorkflowAssociation(fresh("new"));
      const ids = new Set(storedWorkflows(dataDir).map((item) => item.id));
      expect(ids.has("launch")).toBe(true);
      // Older than every history record, and its environment is gone.
      expect(ids.has("gone-launch")).toBe(false);
    });
  });

  test.each([undefined, OLD])(
    "a retry replays its original record (hidden: %s)",
    async (workHiddenAt) => {
      await withTemporaryStorage(async (storage, dataDir) => {
        const recent = finished("recent", {
          workHiddenAt,
          kind: "build-pipeline",
          createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          terminalNotifiedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        });
        seedWorkflows(dataDir, [recent, ...history(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - 1)]);

        // An unrelated launch fills the store and triggers cleanup; the recent
        // record, finished but inside the replay window, is kept.
        await storage.coordinators.saveCoordinatorWorkflowAssociation(fresh("unrelated"));
        expect(storedWorkflows(dataDir).some((item) => item.id === "recent")).toBe(true);

        const before = storedWorkflows(dataDir).length;
        const retried = await storage.coordinators.reserveCoordinatorWorkflowAssociation({
          ...recent,
          id: "retry-attempt",
          terminalNotifiedAt: undefined,
        });
        expect(retried).toEqual({
          association: expect.objectContaining({ id: "recent" }),
          claimed: false,
        });
        expect(storedWorkflows(dataDir)).toHaveLength(before);
      });
    },
  );

  test("recent aliases survive cleanup and replay, including legacy aliases", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const old = finished("old-review");
      seedWorkflows(dataDir, [old, ...history(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - 1)]);
      await storage.coordinators.addCoordinatorWorkflowRequestAlias(
        old.id,
        old.coordinatorId,
        old.conversationId!,
        "today",
        "today-hash",
      );
      await storage.coordinators.saveCoordinatorWorkflowAssociation(fresh("unrelated"));
      const replay = await storage.coordinators.addCoordinatorWorkflowRequestAlias(
        old.id,
        old.coordinatorId,
        old.conversationId!,
        "today",
        "today-hash",
      );
      expect(replay.id).toBe(old.id);
      expect(replay.requestAliases?.[0]?.receivedAt).toBeString();
      expect(
        select([
          finished("legacy", { requestAliases: [{ requestId: "legacy", payloadHash: "hash" }] }),
        ]).size,
      ).toBe(0);
    });
  });

  test("joining an old PR follow protects the new request after the follow finishes", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const follow = finished("follow", {
        kind: "pull-request",
        resourceId: "env",
        terminalNotifiedAt: undefined,
        pullRequest: { source: "create-pr" },
      });
      seedWorkflows(dataDir, [follow, ...history(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - 1)]);
      const joined = await storage.coordinators.followCoordinatorPullRequest({
        projectId: follow.projectId,
        coordinatorId: follow.coordinatorId,
        environmentId: "env",
        requestId: "new-follow",
        source: "create-pr",
      });
      expect(joined.id).toBe(follow.id);
      expect(joined.requestAliases?.[0]?.receivedAt).toBeString();
      seedWorkflows(
        dataDir,
        storedWorkflows(dataDir).map((item) =>
          item.id === follow.id ? { ...item, terminalNotifiedAt: new Date().toISOString() } : item,
        ),
      );
      await storage.coordinators.saveCoordinatorWorkflowAssociation(fresh("new"));
      const replay = await storage.coordinators.followCoordinatorPullRequest({
        projectId: follow.projectId,
        coordinatorId: follow.coordinatorId,
        environmentId: "env",
        requestId: "new-follow",
        source: "create-pr",
      });
      expect(replay.id).toBe(follow.id);
    });
  });

  test("current persisted resource state protects retries and reclaims unreported missing or terminal work", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      // These control records model the committed failed -> running retry transition.
      for (const [kind, file] of [
        ["multi-review", "multi-reviews.json"],
        ["build-pipeline", "build-pipelines.json"],
        ["graph-run", "graph-runs.json"],
      ] as const) {
        const running = finished("retry", {
          kind,
          resourceId: "retry",
          createdAt: "2020-01-01T00:00:00Z",
        });
        const missing = finished("missing", {
          kind,
          resourceId: "missing",
          terminalNotifiedAt: undefined,
        });
        const terminal = finished("terminal", {
          kind,
          resourceId: "terminal",
          terminalNotifiedAt: undefined,
        });
        const remote = finished("remote", {
          kind,
          nodeId: "remote-node",
          terminalNotifiedAt: undefined,
        });
        seedStore(dataDir, file, {
          retry: { snapshot: { phase: "running" }, status: "running" },
          terminal: { snapshot: { phase: "failed" }, status: "failed", updatedAt: OLD },
          recent: {
            snapshot: { phase: "failed" },
            status: "failed",
            updatedAt: new Date().toISOString(),
          },
        });
        seedWorkflows(dataDir, [
          running,
          missing,
          terminal,
          remote,
          finished("pending-missing", { kind, pending: true, resourceId: "absent" }),
          finished("recent", { kind, resourceId: "recent", terminalNotifiedAt: undefined }),
          ...active(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - 6),
        ]);
        await storage.coordinators.saveCoordinatorWorkflowAssociation(fresh("new"));
        const ids = storedWorkflows(dataDir).map((item) => item.id);
        expect(ids).toContain("retry");
        expect(ids).toContain("remote");
        expect(ids).toContain("pending-missing");
        expect(ids).toContain("recent");
        expect(ids).not.toContain("missing");
        expect(ids).not.toContain("terminal");
      }
    });
  });

  test("a full store of records still in use refuses with an error that says so", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const workflows = active(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS);
      seedWorkflows(dataDir, workflows);
      const error = await storage.coordinators
        .saveCoordinatorWorkflowAssociation(fresh("refused"))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR);
      expect((error as Error).message).toContain(
        `all ${MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS} records are still in use`,
      );
      // Nothing was removed or added.
      expect(storedWorkflows(dataDir).map((item) => item.id)).toEqual(
        workflows.map((item) => item.id),
      );
      await expect(
        storage.coordinators.reserveCoordinatorWorkflowAssociation(fresh("reserve-refused")),
      ).rejects.toThrow(COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR);
    });
  });
});
