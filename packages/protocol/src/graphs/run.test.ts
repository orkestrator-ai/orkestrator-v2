import { describe, expect, test } from "bun:test";
import {
  COMMIT_A,
  COMMIT_B,
  POLICY_FIXTURE,
  RUN_FIXTURE_AT,
  activationFixture,
  artifactFixture,
  graphRunFixture,
} from "./run-fixtures.test-support.js";
import {
  GRAPH_ARTIFACT_BUDGETS,
  GRAPH_RUN_BOUNDS,
  appendGraphActivation,
  applyGraphRewind,
  boundGraphError,
  graphActivationKey,
  graphArtifactDigest,
  graphArtifactFilePath,
  graphArtifactId,
  graphArtifactLimitViolation,
  graphLineageDescendants,
  graphRunLimitViolation,
  graphRunRecordBytesViolation,
  liveGraphArtifactsForPort,
  parseGraphActivationKey,
  parseGraphArtifactFilePath,
  replaceGraphActivation,
  validateGraphArtifact,
  validateGraphRun,
  verifyGraphArtifactIdentity,
  type GraphRewind,
  type GraphRun,
  type NodeActivation,
} from "./run.js";

function codes(result: { ok: boolean; errors?: Array<{ path: string; code: string }> }) {
  return result.ok ? [] : result.errors!.map((error) => `${error.path}:${error.code}`);
}

function rewind(overrides: Partial<GraphRewind> = {}): GraphRewind {
  return {
    id: "rewind-1",
    kind: "restart",
    nodeId: "build",
    activation: graphActivationKey({ nodeId: "build", iteration: 1, attempt: 1 }),
    iteration: 1,
    requestedAt: RUN_FIXTURE_AT,
    requestedBy: "user",
    superseded: { activations: [], artifacts: [] },
    ...overrides,
  };
}

describe("activation keys", () => {
  test("build and parse round-trip, with and without a branch", () => {
    const plain = graphActivationKey({ nodeId: "review", iteration: 2, attempt: 3 });
    expect(plain).toBe("review#iter=2#attempt=3");
    expect(parseGraphActivationKey(plain)).toEqual({ nodeId: "review", iteration: 2, attempt: 3 });
    const branched = graphActivationKey({
      nodeId: "review",
      iteration: 1,
      branchKey: "panel.1+lens.security",
      attempt: 1,
    });
    expect(branched).toBe("review#iter=1#branch=panel.1+lens.security#attempt=1");
    expect(parseGraphActivationKey(branched)).toEqual({
      nodeId: "review",
      iteration: 1,
      branchKey: "panel.1+lens.security",
      attempt: 1,
    });
  });

  test("refuses parts no key may hold and keys no builder makes", () => {
    expect(() => graphActivationKey({ nodeId: "Review", iteration: 1, attempt: 1 })).toThrow();
    expect(() => graphActivationKey({ nodeId: "review", iteration: 0, attempt: 1 })).toThrow();
    expect(() => graphActivationKey({ nodeId: "review", iteration: 11, attempt: 1 })).toThrow();
    expect(() =>
      graphActivationKey({ nodeId: "review", iteration: 1, attempt: 1, branchKey: "a#b" }),
    ).toThrow();
    for (const key of [
      "review#iter=01#attempt=1",
      "review#attempt=1#iter=1",
      "review#iter=1#branch=#attempt=1",
      "review#iter=1#branch=a=b#attempt=1",
      "review#iter=1#attempt=1#",
      "review#iter=1#attempt=1001",
      "x".repeat(300),
      42,
    ]) {
      expect(parseGraphActivationKey(key)).toBeNull();
    }
  });
});

describe("reference artifact paths", () => {
  test("are derived from the run and the file hash", () => {
    const sha = "c".repeat(64);
    expect(graphArtifactFilePath("run-1", sha)).toBe(`.orkestrator/graph-artifacts/run-1/${sha}`);
    expect(graphArtifactFilePath("run-1", sha, "json")).toBe(
      `.orkestrator/graph-artifacts/run-1/${sha}.json`,
    );
    expect(parseGraphArtifactFilePath(`.orkestrator/graph-artifacts/run-1/${sha}.json`)).toEqual({
      runId: "run-1",
      sha256: sha,
      extension: "json",
    });
  });

  test("refuse anything that could leave the run's directory", () => {
    const sha = "c".repeat(64);
    expect(() => graphArtifactFilePath("../run", sha)).toThrow();
    expect(() => graphArtifactFilePath("run-1", "C".repeat(64))).toThrow();
    expect(() => graphArtifactFilePath("run-1", sha, "../x")).toThrow();
    for (const path of [
      `.orkestrator/graph-artifacts/../${sha}`,
      `.orkestrator/graph-artifacts/run-1/../${sha}`,
      `.orkestrator/graph-artifacts/run-1/sub/${sha}`,
      `/.orkestrator/graph-artifacts/run-1/${sha}`,
      `.orkestrator/graph-artifacts/run-1/${sha}.`,
      `.orkestrator/graph-artifacts/run-1/${sha}.tar.gz`,
      `.orkestrator/graph-artifacts//${sha}`,
      `.orkestrator/review-packages/run-1/${sha}`,
    ]) {
      expect(parseGraphArtifactFilePath(path)).toBeNull();
    }
  });
});

describe("artifact identity", () => {
  test("the digest is the type plus the canonical payload, independent of key order", () => {
    const one = graphArtifactDigest("decision@1", { value: { choice: "a", rationale: "r" } });
    const two = graphArtifactDigest("decision@1", { value: { rationale: "r", choice: "a" } });
    expect(one).toBe(two);
    expect(graphArtifactDigest("decision@2", { value: { choice: "a", rationale: "r" } })).not.toBe(
      one,
    );
  });

  test("two producers of the same content get distinct ids", () => {
    const run = graphRunFixture();
    const build = activationFixture({ nodeId: "build" });
    const fix = activationFixture({ nodeId: "fix", iteration: 2 });
    const first = artifactFixture(run.id, { activation: build });
    const second = artifactFixture(run.id, { activation: fix });
    expect(first.digest).toBe(second.digest);
    expect(first.id).not.toBe(second.id);
  });

  test("a tampered envelope fails identity verification", () => {
    const run = graphRunFixture();
    const artifact = artifactFixture(run.id, { workspace: { headRef: COMMIT_A } });
    expect(verifyGraphArtifactIdentity(artifact)).toEqual({ ok: true });
    expect(
      verifyGraphArtifactIdentity({
        ...artifact,
        body: { value: { branch: "main", headRef: COMMIT_B, baseRef: null } },
      }),
    ).toEqual({ ok: false, field: "digest" });
    expect(verifyGraphArtifactIdentity({ ...artifact, inputs: ["d".repeat(64)] })).toEqual({
      ok: false,
      field: "id",
    });
    expect(verifyGraphArtifactIdentity({ ...artifact, workspace: { headRef: COMMIT_B } })).toEqual({
      ok: false,
      field: "id",
    });
    expect(verifyGraphArtifactIdentity({ ...artifact, bytes: artifact.bytes + 1 })).toEqual({
      ok: false,
      field: "bytes",
    });
    // Any hash function gives the same identity; the backend passes its native one.
    expect(
      graphArtifactId({
        digest: artifact.digest,
        runId: run.id,
        producer: artifact.producer,
        inputs: [],
        workspace: { headRef: COMMIT_A },
      }),
    ).toBe(artifact.id);
  });
});

describe("validateGraphRun", () => {
  test("accepts a run with activations, a rewind and policies", () => {
    const build = activationFixture(
      { nodeId: "build" },
      {
        state: "superseded",
        supersededBy: "rewind-1",
        session: {
          agent: "claude",
          requestId: "request-1",
          dispatchState: "sent",
          resultTransport: "tool-call-v1",
          resultKeys: { code: "key_code", report: "key-report" },
        },
        policy: POLICY_FIXTURE,
        enforcement: "advisory",
        baseline: { headRef: COMMIT_A, pathsDigest: "e".repeat(64) },
        guards: [{ guard: "read-only", outcome: "passed", at: RUN_FIXTURE_AT }],
      },
    );
    const retry = activationFixture({ nodeId: "build", attempt: 2 }, { state: "running" });
    const run = graphRunFixture({
      activations: [build, retry],
      rewinds: [rewind({ superseded: { activations: [build.key], artifacts: [] } })],
    });
    expect(codes(validateGraphRun(run))).toEqual([]);
  });

  test("checks the guard baseline's paths and upstream refs (item 209)", () => {
    const baseline = {
      headRef: COMMIT_A,
      pathsDigest: "e".repeat(64),
      pathCount: 1,
      paths: ["notes.md"],
      capturedAt: RUN_FIXTURE_AT,
      upstream: [{ remote: "origin", ref: "refs/heads/main", sha: null }],
    };
    const valid = graphRunFixture({
      activations: [activationFixture({ nodeId: "build" }, { state: "running", baseline })],
    });
    expect(codes(validateGraphRun(valid))).toEqual([]);
    const invalid = graphRunFixture({
      activations: [
        activationFixture(
          { nodeId: "build" },
          {
            state: "running",
            baseline: {
              ...baseline,
              pathCount: 2,
              paths: Array.from({ length: 65 }, (_, index) => `f${index}`),
              capturedAt: "yesterday",
              upstream: [{ remote: "-x", ref: "refs/heads/main", sha: "nope" }],
            },
          },
        ),
      ],
    });
    expect(codes(validateGraphRun(invalid))).toEqual(
      expect.arrayContaining([
        "activations[0].baseline.paths:too_many",
        "activations[0].baseline.capturedAt:timestamp",
        "activations[0].baseline.upstream[0].remote:pattern",
        "activations[0].baseline.upstream[0].sha:pattern",
      ]),
    );
  });

  test("refuses a frozen plan that no longer matches its digest", () => {
    const run = graphRunFixture();
    run.plan.limits.maxAgentSessions = 1;
    expect(codes(validateGraphRun(run))).toContain("plan:digest");
  });

  test("refuses a plan from another template, unknown nodes and loops", () => {
    const run = graphRunFixture({
      template: { id: "other", revision: 1, digest: "f".repeat(64) },
      activations: [activationFixture({ nodeId: "nowhere" })],
      loopIterations: { elsewhere: 1 },
    });
    expect(codes(validateGraphRun(run))).toEqual(
      expect.arrayContaining([
        "plan.template:mismatch",
        "plan.templateDigest:mismatch",
        "activations[0].nodeId:unknown_node",
        "loopIterations.elsewhere:unknown_node",
      ]),
    );
  });

  test("checks the activation's internal consistency", () => {
    const keyed = activationFixture({ nodeId: "build" });
    const run = graphRunFixture({
      activations: [
        { ...keyed, attempt: 2 },
        activationFixture({ nodeId: "fix", iteration: 2 }, { state: "superseded" }),
        activationFixture({ nodeId: "review" }, { supersededBy: "rewind-9" }),
        activationFixture(
          { nodeId: "verify" },
          {
            session: {
              agent: "codex",
              requestId: "r",
              dispatchState: "prepared",
              resultTransport: "tool-call-v1",
            },
          },
        ),
        activationFixture({ nodeId: "address" }, { policy: POLICY_FIXTURE }),
      ],
    });
    expect(codes(validateGraphRun(run))).toEqual(
      expect.arrayContaining([
        "activations[0].key:mismatch",
        "activations[1].supersededBy:required",
        "activations[2].supersededBy:mismatch",
        "activations[3].policy:required",
        "activations[4].enforcement:required",
      ]),
    );
  });

  test("refuses duplicate keys and unknown fields", () => {
    const build = activationFixture({ nodeId: "build" });
    const run = { ...graphRunFixture({ activations: [build, build] }), extra: true };
    expect(codes(validateGraphRun(run))).toEqual(
      expect.arrayContaining(["$.extra:unknown_field", "activations[1].key:duplicate"]),
    );
  });
});

describe("run bounds", () => {
  function activations(count: number, state: NodeActivation["state"] = "complete") {
    return Array.from({ length: count }, (_, index) =>
      activationFixture(
        {
          nodeId: "build",
          attempt: (index % 1_000) + 1,
          branchKey: `b${Math.floor(index / 1_000)}`,
        },
        state === "superseded" ? { state, supersededBy: "rewind-1" } : { state },
      ),
    );
  }

  test("more than 200 live activations is refused with its own code", () => {
    const run = graphRunFixture({ activations: activations(GRAPH_RUN_BOUNDS.maxActivations + 1) });
    expect(graphRunLimitViolation(run)).toMatchObject({
      code: "activations",
      limit: 200,
      actual: 201,
    });
    expect(codes(validateGraphRun(run))).toContain("activations:too_many");
    // Superseded activations do not count against the live cap.
    const history = graphRunFixture({
      activations: [...activations(300, "superseded"), ...activations(1)].map((activation, index) =>
        activationFixture(
          { nodeId: "build", attempt: index + 1 },
          activation.state === "superseded"
            ? { state: "superseded", supersededBy: "rewind-1" }
            : {},
        ),
      ),
      rewinds: [rewind()],
    });
    expect(graphRunLimitViolation(history)).toBeNull();
    expect(codes(validateGraphRun(history))).toEqual([]);
  });

  test("the history, rewind, error and record-size bounds are refused explicitly", () => {
    const history = graphRunFixture({
      activations: activations(GRAPH_RUN_BOUNDS.maxActivationHistory + 1, "superseded"),
    });
    expect(graphRunLimitViolation(history)?.code).toBe("activation-history");
    const rewinds = graphRunFixture({
      rewinds: Array.from({ length: 51 }, (_, index) => rewind({ id: `rewind-${index}` })),
    });
    expect(graphRunLimitViolation(rewinds)).toMatchObject({ code: "rewinds", limit: 50 });
    expect(codes(validateGraphRun(rewinds))).toContain("rewinds:too_many");
    const error = graphRunFixture({
      activations: [activationFixture({ nodeId: "build" }, { error: "x".repeat(2_001) })],
    });
    expect(graphRunLimitViolation(error)).toMatchObject({ code: "error-length", limit: 2_000 });
    expect(codes(validateGraphRun(error))).toContain("activations[0].error:too_long");
    expect(graphRunRecordBytesViolation(GRAPH_RUN_BOUNDS.maxRecordBytes)).toBeNull();
    expect(graphRunRecordBytesViolation(GRAPH_RUN_BOUNDS.maxRecordBytes + 1)?.code).toBe(
      "record-bytes",
    );
  });

  test("boundGraphError keeps errors inside the bound", () => {
    expect(boundGraphError("short")).toBe("short");
    const bounded = boundGraphError(`${"x".repeat(1_998)}😀😀`);
    expect(bounded.length).toBeLessThanOrEqual(GRAPH_RUN_BOUNDS.maxErrorChars);
    expect(bounded.endsWith("…")).toBe(true);
    expect(bounded).not.toContain("\ud83d…");
  });

  test("appendGraphActivation refuses duplicates and both caps", () => {
    const run = graphRunFixture({ activations: activations(200) });
    expect(appendGraphActivation(run, activationFixture({ nodeId: "fix" }))).toMatchObject({
      ok: false,
      code: "activations",
    });
    expect(appendGraphActivation(run, run.activations[0]!)).toMatchObject({
      ok: false,
      code: "duplicate-activation",
    });
    const full = graphRunFixture({ activations: activations(2_000, "superseded") });
    expect(
      appendGraphActivation(full, activationFixture({ nodeId: "fix" }, { state: "waiting" })),
    ).toMatchObject({ ok: false, code: "activation-history" });
    const small = graphRunFixture();
    const appended = appendGraphActivation(small, activationFixture({ nodeId: "build" }));
    expect(appended.ok && appended.run.activations).toHaveLength(1);
    expect(small.activations).toHaveLength(0);
  });
});

describe("validateGraphArtifact and its bounds", () => {
  test("accepts value and reference artifacts", () => {
    const run = graphRunFixture();
    expect(codes(validateGraphArtifact(artifactFixture(run.id)))).toEqual([]);
    const file = artifactFixture(run.id, {
      type: "review-package@2",
      file: { sha256: "c".repeat(64), bytes: 1_024 },
      value: { id: "p" },
    });
    expect(codes(validateGraphArtifact(file))).toEqual([]);
  });

  test("refuses a file path that names another run or hash", () => {
    const artifact = artifactFixture("run-1", {
      type: "review-package@2",
      file: { sha256: "c".repeat(64), bytes: 1 },
    });
    const body = artifact.body as { file: { path: string; sha256: string; bytes: number } };
    const other = {
      ...artifact,
      body: {
        file: { ...body.file, path: `.orkestrator/graph-artifacts/run-2/${"c".repeat(64)}` },
      },
    };
    expect(codes(validateGraphArtifact(other))).toContain("body.file.path:mismatch");
    const escaped = { ...artifact, body: { file: { ...body.file, path: "../../etc/passwd" } } };
    expect(codes(validateGraphArtifact(escaped))).toContain("body.file.path:pattern");
  });

  test("every per-artifact bound has a typed violation", () => {
    const run = graphRunFixture();
    const big = artifactFixture(run.id, {
      type: "text@1",
      value: { text: "x".repeat(GRAPH_ARTIFACT_BUDGETS.maxValueBytes) },
    });
    expect(graphArtifactLimitViolation(big)?.code).toBe("value-bytes");
    const file = artifactFixture(run.id, {
      type: "review-package@2",
      file: { sha256: "c".repeat(64), bytes: GRAPH_ARTIFACT_BUDGETS.maxReferenceBytes + 1 },
    });
    expect(graphArtifactLimitViolation(file)?.code).toBe("reference-bytes");
    const inputs = artifactFixture(run.id, {
      inputs: Array.from({ length: 257 }, (_, index) => index.toString(16).padStart(64, "0")),
    });
    expect(graphArtifactLimitViolation(inputs)?.code).toBe("artifact-inputs");
    const items = {
      ...artifactFixture(run.id),
      itemIds: Array.from({ length: 10_001 }, (_, index) => `i${index}`),
    };
    expect(graphArtifactLimitViolation(items)?.code).toBe("artifact-items");
    expect(graphArtifactLimitViolation(artifactFixture(run.id))).toBeNull();
    const folded = {
      ...artifactFixture(run.id),
      itemIds: ["a"],
      itemSources: [Array.from({ length: 10_001 }, (_, index) => `s${index}`)],
    };
    expect(graphArtifactLimitViolation(folded)?.code).toBe("artifact-items");
  });

  test("item sources run parallel to item ids, each naming at least one source", () => {
    const run = graphRunFixture();
    const merged = {
      ...artifactFixture(run.id),
      itemIds: ["review/panel.1/issue-1", "review/panel.1/issue-2"],
      itemSources: [
        ["review/panel.1/issue-1", "review/panel.2/issue-1"],
        ["review/panel.1/issue-2"],
      ],
    };
    expect(codes(validateGraphArtifact(merged))).toEqual([]);
    expect(codes(validateGraphArtifact({ ...merged, itemSources: [["a"]] }))).toContain(
      "itemSources:mismatch",
    );
    expect(codes(validateGraphArtifact({ ...merged, itemSources: [[], ["b"]] }))).toContain(
      "itemSources[0]:too_few",
    );
    const { itemIds: _itemIds, ...withoutIds } = merged;
    expect(codes(validateGraphArtifact(withoutIds))).toContain("itemSources:mismatch");
  });
});

describe("lineage and rewinds", () => {
  /** build → prepare → review; an independent verify reads only the run input. */
  function chain(): { run: GraphRun; artifacts: ReturnType<typeof artifactFixture>[] } {
    const base = graphRunFixture();
    const input = artifactFixture(base.id);
    const build = activationFixture({ nodeId: "build" }, { inputs: { code: input.id } });
    const built = artifactFixture(base.id, { activation: build, inputs: [input.id] });
    build.outputs = { code: built.id };
    const prepare = activationFixture({ nodeId: "prepare" }, { inputs: { code: built.id } });
    const prepared = artifactFixture(base.id, {
      activation: prepare,
      port: "plan",
      type: "text@1",
      value: { text: "plan" },
      inputs: [built.id],
    });
    prepare.outputs = { plan: prepared.id };
    const review = activationFixture({ nodeId: "review" }, { inputs: { plan: [prepared.id] } });
    const verify = activationFixture({ nodeId: "verify" }, { inputs: { code: input.id } });
    const verified = artifactFixture(base.id, {
      activation: verify,
      inputs: [input.id],
      workspace: { headRef: COMMIT_B },
    });
    verify.outputs = { code: verified.id };
    return {
      run: { ...base, activations: [build, prepare, review, verify] },
      artifacts: [input, built, prepared, verified],
    };
  }

  test("descendants are exactly what transitively consumed the restarted node's output", () => {
    const { run, artifacts } = chain();
    const [input, built, prepared, verified] = artifacts;
    const descendants = graphLineageDescendants(run, artifacts, run.activations[0]!.key)!;
    expect(descendants.activations).toEqual([
      run.activations[0]!.key,
      run.activations[1]!.key,
      run.activations[2]!.key,
    ]);
    expect(descendants.artifacts).toEqual([built!.id, prepared!.id].sort());
    expect(descendants.artifacts).not.toContain(input!.id);
    expect(descendants.artifacts).not.toContain(verified!.id);
    expect(graphLineageDescendants(run, artifacts, "build#iter=9#attempt=1")).toBeNull();
  });

  test("a rewind supersedes the descendants, rewinds the loop and is bounded", () => {
    const { run, artifacts } = chain();
    const fix = activationFixture({ nodeId: "fix", iteration: 2 });
    const looped = {
      ...run,
      activations: [...run.activations, fix],
      loopIterations: { rounds: 3 },
    };
    const descendants = graphLineageDescendants(looped, artifacts, fix.key)!;
    const applied = applyGraphRewind(
      looped,
      rewind({ nodeId: "fix", activation: fix.key, iteration: 2, superseded: { ...descendants } }),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.run.loopIterations).toEqual({ rounds: 2 });
    expect(applied.run.activations.at(-1)).toMatchObject({
      state: "superseded",
      supersededBy: "rewind-1",
    });
    expect(applied.run.activations[0]!.state).toBe("complete");
    expect(codes(validateGraphRun(applied.run))).toEqual([]);
    // A repeated request must not supersede twice.
    expect(
      applyGraphRewind(applied.run, rewind({ id: "rewind-2", superseded: descendants })),
    ).toMatchObject({ ok: false, code: "already-superseded" });
    expect(applyGraphRewind(applied.run, rewind())).toMatchObject({
      ok: false,
      code: "duplicate-rewind",
    });
    const full = {
      ...run,
      rewinds: Array.from({ length: 50 }, (_, index) => rewind({ id: `r${index}` })),
    };
    expect(applyGraphRewind(full, rewind({ id: "r50" }))).toMatchObject({
      ok: false,
      code: "rewinds",
    });
    expect(
      replaceGraphActivation(applied.run, fix.key, (activation) => ({
        ...activation,
        state: "complete",
      })),
    ).toMatchObject({ ok: false, code: "already-superseded" });
  });

  test("live artifacts for a port skip superseded activations and filter by iteration", () => {
    const { run, artifacts } = chain();
    const [input, built] = artifacts;
    expect(
      liveGraphArtifactsForPort(run, artifacts, { nodeId: "build", port: "code" }).map(
        (artifact) => artifact.id,
      ),
    ).toEqual([built!.id]);
    expect(
      liveGraphArtifactsForPort(run, artifacts, { nodeId: "$input", port: "target" }).map(
        (artifact) => artifact.id,
      ),
    ).toEqual([input!.id]);
    expect(
      liveGraphArtifactsForPort(run, artifacts, { nodeId: "build", port: "code", iteration: 2 }),
    ).toEqual([]);
    const superseded = {
      ...run,
      activations: run.activations.map((activation, index) =>
        index === 0
          ? { ...activation, state: "superseded" as const, supersededBy: "rewind-1" }
          : activation,
      ),
    };
    expect(
      liveGraphArtifactsForPort(superseded, artifacts, { nodeId: "build", port: "code" }),
    ).toEqual([]);
  });
});
