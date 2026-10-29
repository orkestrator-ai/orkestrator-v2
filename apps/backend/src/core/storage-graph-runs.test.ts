import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GRAPH_ARTIFACT_BUDGETS,
  GRAPH_RUN_BOUNDS,
  applyGraphRewind,
  graphLineageDescendants,
  type GraphRun,
} from "@orkestrator/protocol/graphs/run";
import { compile } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { GraphStorageError } from "./graph-run-errors.js";
import {
  GRAPH_FIXTURE_AT,
  graphActivationFixture,
  graphArtifactFixture,
  graphEnvironmentFixture,
  graphRunFixture,
} from "./graph-run-test-support.js";
import { StorageService } from "./storage.js";
import { storageDatabase } from "./storage-test-support.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function openStorage(dataDir?: string): Promise<StorageService> {
  const directory = dataDir ?? (await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-runs-")));
  if (!dataDir) directories.push(directory);
  const storage = new StorageService(directory);
  await storage.init();
  services.push(storage);
  if (!dataDir) {
    await storage.addEnvironment(graphEnvironmentFixture());
    await storage.addEnvironment(graphEnvironmentFixture({ id: "e2", order: 1 }));
  }
  return storage;
}

async function refusal(promise: Promise<unknown>): Promise<GraphStorageError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraphStorageError) return error;
    throw error;
  }
  throw new Error("Expected a graph storage refusal");
}

/** Activations with unique keys: attempts 1..1000 per branch. */
function activations(count: number, state: "complete" | "superseded" = "complete") {
  return Array.from({ length: count }, (_, index) =>
    graphActivationFixture(
      "build",
      { attempt: (index % 1_000) + 1, branchKey: `b${Math.floor(index / 1_000)}` },
      state === "superseded" ? { state, supersededBy: "rewind-1" } : {},
    ),
  );
}

describe("graph-runs store", () => {
  test("creates, reloads in another process and lists by environment", async () => {
    const storage = await openStorage();
    const created = await storage.graphRuns.createGraphRun(graphRunFixture());
    expect(created.revision).toBe(1);
    await storage.graphRuns.createGraphRun(
      graphRunFixture({ id: "run-2", environmentId: "e2", createdAt: "2026-10-29T00:00:01.000Z" }),
    );
    const other = await openStorage(storage.getDataDir());
    const reloaded = await other.graphRuns.getGraphRun("run-1");
    expect(reloaded).toEqual(created);
    expect((await other.graphRuns.listGraphRuns("e1")).map((run) => run.id)).toEqual(["run-1"]);
    expect((await other.graphRuns.listAllGraphRuns()).map((run) => run.id)).toEqual([
      "run-1",
      "run-2",
    ]);
    expect(await other.graphRuns.getGraphRun("missing")).toBeNull();
    expect((await refusal(storage.graphRuns.createGraphRun(graphRunFixture()))).code).toBe(
      "run-exists",
    );
  });

  test("compare-and-swap refuses a stale revision, also from another process", async () => {
    const storage = await openStorage();
    const created = await storage.graphRuns.createGraphRun(graphRunFixture());
    const first = await storage.graphRuns.saveGraphRun(
      { ...created, status: "waiting" },
      created.revision,
    );
    expect(first.revision).toBe(2);
    const stale = await refusal(
      storage.graphRuns.saveGraphRun({ ...created, status: "paused" }, created.revision),
    );
    expect(stale).toMatchObject({ code: "revision-conflict", limit: 1, actual: 2 });

    // Two writers racing on one revision: exactly one commits.
    const other = await openStorage(storage.getDataDir());
    const results = await Promise.allSettled([
      storage.graphRuns.saveGraphRun({ ...first, usage: { agentSessions: 1, tokens: 1 } }, 2),
      other.graphRuns.saveGraphRun({ ...first, usage: { agentSessions: 2, tokens: 2 } }, 2),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect((rejected.reason as GraphStorageError).code).toBe("revision-conflict");
    expect((await storage.graphRuns.getGraphRun("run-1"))?.revision).toBe(3);
    expect(
      (await refusal(storage.graphRuns.saveGraphRun(graphRunFixture({ id: "nope" }), 0))).code,
    ).toBe("run-not-found");
  });

  test("the plan is frozen and a run never changes environment", async () => {
    const storage = await openStorage();
    const created = await storage.graphRuns.createGraphRun(graphRunFixture());
    const replanned = structuredClone(created);
    replanned.plan.limits.maxAgentSessions = 3;
    expect((await refusal(storage.graphRuns.saveGraphRun(replanned, 1))).code).toBe("invalid-run");
    const moved = { ...created, environmentId: "e2" };
    expect((await refusal(storage.graphRuns.saveGraphRun(moved, 1))).code).toBe("invalid-run");
    // A valid plan of the same template compiled under another ceiling is still another plan.
    const recompiled = compile(graphTemplateExample("build-pipeline-loop"), {
      ceiling: { deny: ["network"] },
    }).plan!;
    expect(recompiled.digest).not.toBe(created.plan.digest);
    expect(
      (await refusal(storage.graphRuns.saveGraphRun({ ...created, plan: recompiled }, 1))).code,
    ).toBe("plan-changed");
    expect((await storage.graphRuns.getGraphRun("run-1"))?.revision).toBe(1);
  });

  test("an environment that is gone or being deleted gets no new writes", async () => {
    const storage = await openStorage();
    expect(
      (await refusal(storage.graphRuns.createGraphRun(graphRunFixture({ environmentId: "nope" }))))
        .code,
    ).toBe("environment-not-found");
    const created = await storage.graphRuns.createGraphRun(graphRunFixture());
    await storage.updateEnvironment("e1", { deletionRequestedAt: GRAPH_FIXTURE_AT });
    expect((await refusal(storage.graphRuns.saveGraphRun(created, 1))).code).toBe(
      "environment-deleting",
    );
    expect(
      (await refusal(storage.graphRuns.putGraphArtifact(graphArtifactFixture("run-1")))).code,
    ).toBe("environment-deleting");
  });

  test("every run bound refuses an overrun with its typed code", async () => {
    const storage = await openStorage();
    const created = await storage.graphRuns.createGraphRun(graphRunFixture());
    const live = await refusal(
      storage.graphRuns.saveGraphRun(
        { ...created, activations: activations(GRAPH_RUN_BOUNDS.maxActivations + 1) },
        1,
      ),
    );
    expect(live).toMatchObject({ code: "activations", limit: 200, actual: 201 });
    const history = await refusal(
      storage.graphRuns.saveGraphRun(
        {
          ...created,
          activations: activations(GRAPH_RUN_BOUNDS.maxActivationHistory + 1, "superseded"),
        },
        1,
      ),
    );
    expect(history).toMatchObject({ code: "activation-history", limit: 2_000, actual: 2_001 });
    const rewind = {
      kind: "restart" as const,
      nodeId: "build",
      activation: "build#iter=1#attempt=1",
      iteration: 1,
      requestedAt: GRAPH_FIXTURE_AT,
      requestedBy: "user" as const,
      superseded: { activations: [], artifacts: [] },
    };
    const rewinds = await refusal(
      storage.graphRuns.saveGraphRun(
        {
          ...created,
          rewinds: Array.from({ length: 51 }, (_, index) => ({ ...rewind, id: `r${index}` })),
        },
        1,
      ),
    );
    expect(rewinds).toMatchObject({ code: "rewinds", limit: 50, actual: 51 });
    const error = await refusal(
      storage.graphRuns.saveGraphRun({ ...created, error: "x".repeat(2_001) }, 1),
    );
    expect(error).toMatchObject({ code: "error-length", limit: 2_000 });
    // Within bounds, but past 16 MiB serialized: guard evidence at its maxima.
    const evidence = Array.from({ length: GRAPH_RUN_BOUNDS.maxGuardResults }, () => ({
      guard: "read-only" as const,
      outcome: "violated" as const,
      at: GRAPH_FIXTURE_AT,
      paths: Array.from({ length: GRAPH_RUN_BOUNDS.maxGuardPaths }, (_, index) =>
        `${index}`.padEnd(1_024, "p"),
      ),
    }));
    const heavy = activations(70).map((activation) => ({ ...activation, guards: evidence }));
    const bytes = await refusal(
      storage.graphRuns.saveGraphRun({ ...created, activations: heavy }, 1),
    );
    expect(bytes).toMatchObject({ code: "record-bytes", limit: GRAPH_RUN_BOUNDS.maxRecordBytes });
    expect((await storage.graphRuns.getGraphRun("run-1"))?.revision).toBe(1);
  });

  test("a record written by a newer build is refused, never rewritten", async () => {
    const storage = await openStorage();
    const created = await storage.graphRuns.createGraphRun(graphRunFixture());
    storageDatabase(storage).updateStoreRow("graph-runs", "run-1", (current) => ({
      result: undefined,
      value: { ...(current as GraphRun), formatVersion: 2 },
    }));
    expect((await refusal(storage.graphRuns.getGraphRun("run-1"))).code).toBe("newer-format");
    expect((await refusal(storage.graphRuns.saveGraphRun(created, 1))).code).toBe("newer-format");
    expect(await storage.graphRuns.listGraphRuns("e1")).toEqual([]);
    expect(await storage.graphRuns.listGraphRunIds("e1")).toEqual(["run-1"]);
  });
});

describe("graph-artifacts store", () => {
  test("puts are idempotent, never overwrite, and index per run", async () => {
    const storage = await openStorage();
    await storage.graphRuns.createGraphRun(graphRunFixture());
    const artifact = graphArtifactFixture("run-1");
    expect(await storage.graphRuns.putGraphArtifact(artifact)).toEqual(artifact);
    // Same envelope, later timestamp: the stored one is returned unchanged.
    expect(
      await storage.graphRuns.putGraphArtifact({
        ...artifact,
        createdAt: "2026-10-30T00:00:00.000Z",
      }),
    ).toEqual(artifact);
    expect(await storage.graphRuns.graphArtifactUsage("run-1")).toEqual({
      artifacts: 1,
      inlineBytes: artifact.bytes,
      diskBytes: 0,
    });
    // Another row under the same id (an older build, a bad import) is never replaced.
    storageDatabase(storage).updateStoreRow("graph-artifacts", `run-1/${artifact.id}`, () => ({
      result: undefined,
      value: { ...artifact, itemIds: ["x"] },
    }));
    expect((await refusal(storage.graphRuns.putGraphArtifact(artifact))).code).toBe(
      "artifact-conflict",
    );
    const tampered = {
      ...artifact,
      body: { value: { branch: "other", headRef: "b".repeat(40), baseRef: null } },
    };
    expect((await refusal(storage.graphRuns.putGraphArtifact(tampered))).code).toBe(
      "invalid-artifact",
    );
    expect(
      (await refusal(storage.graphRuns.putGraphArtifact(graphArtifactFixture("run-9")))).code,
    ).toBe("run-not-found");
    expect((await storage.graphRuns.listGraphArtifacts("run-1")).map((entry) => entry.id)).toEqual([
      artifact.id,
    ]);
    expect(await storage.graphRuns.getGraphArtifact("run-1", artifact.id)).not.toBeNull();
    expect(await storage.graphRuns.getGraphArtifact("run-2", artifact.id)).toBeNull();
  });

  test("the inline budget refuses the artifact that would pass 32 MiB", async () => {
    const storage = await openStorage();
    await storage.graphRuns.createGraphRun(graphRunFixture());
    // `text` of almost the value cap: about 85 fit in 32 MiB.
    const text = "x".repeat(GRAPH_ARTIFACT_BUDGETS.maxValueBytes - 64);
    let stored = 0;
    let error: GraphStorageError | null = null;
    for (let index = 0; index < 100 && !error; index++) {
      try {
        await storage.graphRuns.putGraphArtifact(
          graphArtifactFixture("run-1", { type: "text@1", value: { text: `${index}${text}` } }),
        );
        stored++;
      } catch (caught) {
        if (!(caught instanceof GraphStorageError)) throw caught;
        error = caught;
      }
    }
    expect(error).toMatchObject({ code: "inline-budget", limit: 32 * 1024 * 1024 });
    const usage = await storage.graphRuns.graphArtifactUsage("run-1");
    expect(usage.artifacts).toBe(stored);
    expect(usage.inlineBytes).toBeLessThanOrEqual(GRAPH_ARTIFACT_BUDGETS.maxInlineBytesPerRun);
    expect(usage.inlineBytes + GRAPH_ARTIFACT_BUDGETS.maxValueBytes).toBeGreaterThan(
      GRAPH_ARTIFACT_BUDGETS.maxInlineBytesPerRun,
    );
  });

  test("the disk budget, count bound and per-artifact bounds refuse overruns", async () => {
    const storage = await openStorage();
    await storage.graphRuns.createGraphRun(graphRunFixture());
    const max = GRAPH_ARTIFACT_BUDGETS.maxReferenceBytes;
    for (let index = 0; index < 8; index++) {
      await storage.graphRuns.putGraphArtifact(
        graphArtifactFixture("run-1", {
          type: "review-package@2",
          file: { sha256: index.toString(16).padStart(64, "0"), bytes: max },
        }),
      );
    }
    const disk = await refusal(
      storage.graphRuns.putGraphArtifact(
        graphArtifactFixture("run-1", {
          type: "review-package@2",
          file: { sha256: "f".repeat(64), bytes: 1 },
        }),
      ),
    );
    expect(disk).toMatchObject({ code: "disk-budget", limit: 256 * 1024 * 1024 });
    const tooBig = await refusal(
      storage.graphRuns.putGraphArtifact(
        graphArtifactFixture("run-1", {
          type: "review-package@2",
          file: { sha256: "e".repeat(64), bytes: max + 1 },
        }),
      ),
    );
    expect(tooBig.code).toBe("reference-bytes");
    const value = await refusal(
      storage.graphRuns.putGraphArtifact(
        graphArtifactFixture("run-1", {
          type: "text@1",
          value: { text: "x".repeat(GRAPH_ARTIFACT_BUDGETS.maxValueBytes) },
        }),
      ),
    );
    expect(value.code).toBe("value-bytes");
    const lineage = await refusal(
      storage.graphRuns.putGraphArtifact(
        graphArtifactFixture("run-1", {
          inputs: Array.from({ length: 257 }, (_, index) => index.toString(16).padStart(64, "0")),
        }),
      ),
    );
    expect(lineage.code).toBe("artifact-inputs");
    // The count bound: a usage row one short of it admits one more, then refuses.
    storageDatabase(storage).updateStoreRow("graph-artifacts", "run-1", (current) => ({
      result: undefined,
      value: {
        ...(current as object),
        runId: "run-1",
        usage: {
          artifacts: GRAPH_ARTIFACT_BUDGETS.maxArtifactsPerRun - 1,
          inlineBytes: 0,
          diskBytes: 0,
        },
      },
    }));
    await storage.graphRuns.putGraphArtifact(graphArtifactFixture("run-1"));
    const count = await refusal(
      storage.graphRuns.putGraphArtifact(
        graphArtifactFixture("run-1", { type: "text@1", value: { text: "t" } }),
      ),
    );
    expect(count).toMatchObject({ code: "artifact-count", limit: 8_192 });
  });

  test("a rewind's record and artifact marks commit together", async () => {
    const storage = await openStorage();
    const base = await storage.graphRuns.createGraphRun(graphRunFixture());
    const input = graphArtifactFixture("run-1");
    const build = graphActivationFixture("build", {}, { inputs: { code: input.id } });
    const built = graphArtifactFixture("run-1", {
      producer: { nodeId: "build", activation: build.key, port: "code" },
      value: { branch: "main", headRef: "b".repeat(40), baseRef: null },
      inputs: [input.id],
    });
    build.outputs = { code: built.id };
    for (const artifact of [input, built]) await storage.graphRuns.putGraphArtifact(artifact);
    const saved = await storage.graphRuns.saveGraphRun({ ...base, activations: [build] }, 1);
    const artifacts = await storage.graphRuns.listGraphArtifacts("run-1");
    const descendants = graphLineageDescendants(saved, artifacts, build.key)!;
    expect(descendants.artifacts).toEqual([built.id]);
    const rewind = {
      id: "rewind-1",
      kind: "restart" as const,
      nodeId: "build",
      activation: build.key,
      iteration: 1,
      requestedAt: GRAPH_FIXTURE_AT,
      requestedBy: "user" as const,
      superseded: descendants,
    };
    const applied = applyGraphRewind(saved, rewind);
    if (!applied.ok) throw new Error(applied.message);

    // An unknown artifact aborts the whole save: neither the record nor a mark changes.
    const unknown = await refusal(
      storage.graphRuns.saveGraphRun(applied.run, saved.revision, {
        supersede: { rewindId: "rewind-1", artifactIds: [built.id, "0".repeat(64)] },
      }),
    );
    expect(unknown.code).toBe("artifact-not-found");
    expect((await storage.graphRuns.getGraphRun("run-1"))?.revision).toBe(saved.revision);
    expect((await storage.graphRuns.getGraphArtifact("run-1", built.id))?.state).toBe("live");

    const rewound = await storage.graphRuns.saveGraphRun(applied.run, saved.revision, {
      supersede: { rewindId: "rewind-1", artifactIds: descendants.artifacts },
    });
    expect(rewound.activations[0]).toMatchObject({ state: "superseded", supersededBy: "rewind-1" });
    expect(await storage.graphRuns.getGraphArtifact("run-1", built.id)).toMatchObject({
      state: "superseded",
      supersededBy: "rewind-1",
    });
    expect((await storage.graphRuns.getGraphArtifact("run-1", input.id))?.state).toBe("live");
    // Superseded is final; nothing is deleted while the run exists.
    expect(await storage.graphRuns.supersedeGraphArtifacts("run-1", [built.id], "rewind-2")).toBe(
      0,
    );
    expect(await storage.graphRuns.listGraphArtifacts("run-1")).toHaveLength(2);
  });

  test("deleting an environment's runs removes their records and artifacts only", async () => {
    const storage = await openStorage();
    await storage.graphRuns.createGraphRun(graphRunFixture());
    await storage.graphRuns.createGraphRun(graphRunFixture({ id: "run-2", environmentId: "e2" }));
    await storage.graphRuns.putGraphArtifact(graphArtifactFixture("run-1"));
    await storage.graphRuns.putGraphArtifact(graphArtifactFixture("run-2"));
    expect(await storage.graphRuns.deleteGraphRunsByEnvironment("e1")).toEqual(["run-1"]);
    expect(await storage.graphRuns.getGraphRun("run-1")).toBeNull();
    expect(await storage.graphRuns.listGraphArtifacts("run-1")).toEqual([]);
    expect((await storage.graphRuns.graphArtifactUsage("run-1")).artifacts).toBe(0);
    expect(await storage.graphRuns.getGraphRun("run-2")).not.toBeNull();
    expect(await storage.graphRuns.listGraphArtifacts("run-2")).toHaveLength(1);
  });

  test("run history keeps the newest finished runs per environment and never an unfinished one", async () => {
    const storage = await openStorage();
    const at = (second: number) => `2026-10-29T00:00:${String(second).padStart(2, "0")}.000Z`;
    // Finished runs, out of creation order: the end time decides.
    const finished: [string, GraphRun["status"], number][] = [
      ["old-a", "complete", 10],
      ["old-b", "failed", 11],
      ["new-a", "cancelled", 30],
      ["new-b", "complete", 20],
    ];
    for (const [id, status, second] of finished) {
      const created = await storage.graphRuns.createGraphRun(
        graphRunFixture({ id, createdAt: at(1) }),
      );
      await storage.graphRuns.putGraphArtifact(graphArtifactFixture(id));
      await storage.graphEffects.beginGraphEffect({
        runId: id,
        key: "push:main:abc",
        action: "push-branch",
        nodeId: "push",
        activation: "push#iter=1#attempt=1",
        owner: "process-1",
      });
      await storage.graphRuns.saveGraphRun(
        {
          ...created,
          status,
          startedAt: at(1),
          finishedAt: at(second),
          updatedAt: at(second),
          ...(status === "failed" ? { error: "x", errorCause: "system-error" as const } : {}),
        },
        created.revision,
      );
    }
    // Unfinished runs, older than everything: never deleted, never counted.
    for (const [id, status] of [
      ["live", "running"],
      ["held", "paused"],
      ["asking", "waiting"],
    ] as const) {
      const created = await storage.graphRuns.createGraphRun(
        graphRunFixture({ id, createdAt: at(0) }),
      );
      if (status !== "running") {
        await storage.graphRuns.saveGraphRun({ ...created, status }, created.revision);
      }
    }
    // Another environment's finished run is not this environment's history.
    await storage.graphRuns.createGraphRun(
      graphRunFixture({
        id: "elsewhere",
        environmentId: "e2",
        status: "complete",
        finishedAt: at(1),
      }),
    );

    expect(await storage.graphRuns.pruneFinishedGraphRuns("e1", 2)).toEqual(["old-b", "old-a"]);
    expect((await storage.graphRuns.listGraphRuns("e1")).map((run) => run.id).sort()).toEqual([
      "asking",
      "held",
      "live",
      "new-a",
      "new-b",
    ]);
    for (const id of ["old-a", "old-b"]) {
      expect(await storage.graphRuns.listGraphArtifacts(id)).toEqual([]);
      expect((await storage.graphRuns.graphArtifactUsage(id)).artifacts).toBe(0);
      expect(await storage.graphEffects.listGraphEffects(id)).toEqual([]);
    }
    expect(await storage.graphRuns.listGraphArtifacts("new-b")).toHaveLength(1);
    expect(await storage.graphEffects.listGraphEffects("new-b")).toHaveLength(1);
    // Within the bound: nothing to do. Zero keeps no finished run at all.
    expect(await storage.graphRuns.pruneFinishedGraphRuns("e1", 2)).toEqual([]);
    expect(await storage.graphRuns.pruneFinishedGraphRuns("e1", 0)).toEqual(["new-a", "new-b"]);
    expect((await storage.graphRuns.listGraphRuns("e1")).map((run) => run.id).sort()).toEqual([
      "asking",
      "held",
      "live",
    ]);
    expect(await storage.graphRuns.getGraphRun("elsewhere")).not.toBeNull();
  });
});
