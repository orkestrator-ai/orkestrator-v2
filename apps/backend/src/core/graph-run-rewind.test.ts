/**
 * Restart and code rewind end to end (item 210): real scheduler passes with
 * pass-through executors (and the real gate and merge), a real store, and a
 * real Git repository for code rewinds. Deterministic: a manual clock, no
 * waits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import type { GraphRewind, GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import { graphForcePushRewind } from "@orkestrator/protocol/graphs/system-actions";
import type { GraphNodeSpec, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { createGraphGateExecutor } from "./graph-node-gate.js";
import { createGraphMergeExecutor } from "./graph-node-merge.js";
import {
  bindAllRoles,
  compiledPlan,
  graphFanOutTemplate,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import { GraphRunRewindError, graphCodeRewindBackupRef } from "./graph-run-rewind.js";
import type { GraphRunService, GraphRunServiceOptions } from "./graph-run-service.js";
import { ManualTime } from "./recurring-test-support.js";
import type { EnvironmentGit } from "./workspace-code-rewind.js";

const worlds: GraphRunWorld[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

interface Harness {
  world: GraphRunWorld;
  service: GraphRunService;
  time: ManualTime;
}

async function harness(options: Partial<GraphRunServiceOptions> = {}): Promise<Harness> {
  const world = await graphRunWorld();
  worlds.push(world);
  world.fakes.skipKinds.add("gate");
  world.fakes.skipKinds.add("merge");
  const time = new ManualTime(0);
  const service = world.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
    ...options,
  });
  service.executors.register(createGraphGateExecutor());
  service.executors.register(createGraphMergeExecutor());
  await service.init();
  return { world, service, time };
}

async function launch(
  h: Harness,
  plan: CompiledGraphPlan,
  options: { panel?: number; inputs?: Record<string, unknown> } = {},
): Promise<GraphRun> {
  return h.service.create({
    projectId: "p1",
    environmentId: "e1",
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    roles: bindAllRoles(plan, options.panel ?? 2),
    inputs: Object.fromEntries(
      plan.inputs.map((input) => [
        input.name,
        options.inputs?.[input.name] ?? graphTypeExample(plan, input.type),
      ]),
    ),
  });
}

async function finish(h: Harness, runId: string, passes = 80): Promise<GraphRun> {
  for (let index = 0; index < passes; index++) {
    h.time.jump(3_000);
    const run = await h.service.advanceNow(runId);
    if (!run) throw new Error("the run disappeared");
    if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
      return run;
    }
  }
  throw new Error("the run did not finish");
}

function latest(run: GraphRun, nodeId: string, iteration = 1, branchKey?: string): NodeActivation {
  const found = run.activations
    .filter(
      (activation) =>
        activation.nodeId === nodeId &&
        activation.iteration === iteration &&
        activation.branchKey === branchKey &&
        activation.state !== "superseded",
    )
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (!found) throw new Error(`no live activation of ${nodeId} at ${iteration} ${branchKey ?? ""}`);
  return found;
}

const states = (run: GraphRun, nodeId: string) =>
  run.activations
    .filter((activation) => activation.nodeId === nodeId)
    .map((activation) => `${activation.iteration}.${activation.attempt}:${activation.state}`);

async function refusal(promise: Promise<unknown>): Promise<GraphRunRewindError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraphRunRewindError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function agent(
  id: string,
  access: "read" | "write" | "none",
  inputs: { name: string; type: string; required?: boolean; firstIterationFrom?: unknown }[],
  outputs: { name: string; type: string }[],
  extra: Record<string, unknown> = {},
): GraphNodeSpec {
  return {
    id,
    kind: "agent",
    role: "worker",
    capabilities: {
      profile: access === "write" ? "builder" : access === "read" ? "reviewer" : "observer",
    },
    workspaceAccess: access,
    prompt: {
      template: `Do ${id}.\n\n${inputs.map((input) => `{{> input.${input.name}}}`).join("\n\n")}\n`,
    },
    inputs,
    outputs,
    ...extra,
  } as GraphNodeSpec;
}

function edge(id: string, from: unknown, to: [string, string]) {
  return { id, from, to: { node: to[0], port: to[1] } };
}

function template(
  id: string,
  nodes: GraphNodeSpec[],
  edges: unknown[],
  outputs: unknown[],
  extra: Record<string, unknown> = {},
): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id,
    revision: 1,
    name: id,
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs,
    workspace: { kind: "environment" },
    nodes,
    edges,
    limits: { maxAgentSessions: 40, maxConcurrentAgents: 4 },
    ...extra,
  } as GraphTemplateV1;
}

const CODE = { name: "code", type: "workspace@1" };
const NOTES = { name: "notes", type: "text@1" };

/** target → build → fix → verify, with an optional `docs` node outside that chain. */
function chainTemplate(options: { docs?: boolean; pr?: boolean } = {}): GraphTemplateV1 {
  const nodes = [
    agent("build", "write", [CODE], [CODE]),
    agent("fix", "write", [CODE], [CODE]),
    agent("verify", "read", [CODE], [NOTES]),
  ];
  const edges = [
    edge("target-build", { input: "target" }, ["build", "code"]),
    edge("build-fix", { node: "build", port: "code" }, ["fix", "code"]),
    edge("fix-verify", { node: "fix", port: "code" }, ["verify", "code"]),
  ];
  const outputs: unknown[] = [{ ...NOTES, from: { node: "verify", port: "notes" } }];
  if (options.docs) {
    // No workspace access: it only reports a commit (scripted), as a writer would.
    nodes.push(agent("docs", "none", [CODE], [CODE]));
    edges.push(edge("target-docs", { input: "target" }, ["docs", "code"]));
    outputs.push({ name: "docs", type: "workspace@1", from: { node: "docs", port: "code" } });
  }
  if (options.pr) {
    nodes.push(
      agent("describe", "read", [CODE], [{ name: "description", type: "pr-description@1" }]),
    );
    nodes.push({
      id: "pr",
      kind: "system",
      action: "open-pull-request",
      inputs: [CODE, { name: "description", type: "pr-description@1" }],
      outputs: [{ name: "pr", type: "pr-result@1" }],
    } as GraphNodeSpec);
    edges.push(edge("verify-describe", { node: "fix", port: "code" }, ["describe", "code"]));
    edges.push(edge("fix-pr", { node: "fix", port: "code" }, ["pr", "code"]));
    edges.push(
      edge("describe-pr", { node: "describe", port: "description" }, ["pr", "description"]),
    );
    outputs.push({ name: "pr", type: "pr-result@1", from: { node: "pr", port: "pr" } });
  }
  return template(
    options.docs ? "chain-docs" : options.pr ? "chain-pr" : "chain",
    nodes,
    edges,
    outputs,
  );
}

const REPORT = { name: "report", type: "review-report@1" };
const VERDICT = { name: "verdict", type: "verification-verdict@1" };

/** The §9.2 loop shape: build once, then rounds of fix?, prepare, review, gate, address?, verify. */
function pipelineLoopTemplate(): GraphTemplateV1 {
  return template(
    "pipeline-loop",
    [
      agent("build", "write", [CODE], [CODE]),
      agent("fix", "write", [{ name: "feedback", type: VERDICT.type }, CODE], [CODE], {
        when: { path: "run.iteration", op: "gt", value: 1 },
      }),
      agent(
        "prepare",
        "write",
        [{ ...CODE, firstIterationFrom: { node: "build", port: "code" } }],
        [CODE],
      ),
      agent("review", "read", [CODE], [REPORT]),
      {
        id: "has-issues",
        kind: "gate",
        inputs: [REPORT, CODE],
        branches: [{ to: "issues", when: { path: "report.issues", op: "nonEmpty" } }],
        otherwise: "clean",
      } as GraphNodeSpec,
      agent("address", "write", [REPORT, CODE], [CODE, { name: "report", type: "fix-result@1" }]),
      agent(
        "verify",
        "read",
        [CODE, { name: "address", type: "fix-result@1", required: false }],
        [VERDICT, CODE],
      ),
    ],
    [
      edge("target-build", { input: "target" }, ["build", "code"]),
      edge("build-prepare", { node: "build", port: "code" }, ["prepare", "code"]),
      edge("fix-prepare", { node: "fix", port: "code" }, ["prepare", "code"]),
      edge("prepare-review", { node: "prepare", port: "code" }, ["review", "code"]),
      edge("review-gate", { node: "review", port: "report" }, ["has-issues", "report"]),
      edge("prepare-gate", { node: "prepare", port: "code" }, ["has-issues", "code"]),
      edge("issues-address-report", { node: "has-issues", outlet: "issues", port: "report" }, [
        "address",
        "report",
      ]),
      edge("issues-address-code", { node: "has-issues", outlet: "issues", port: "code" }, [
        "address",
        "code",
      ]),
      edge("address-verify-code", { node: "address", port: "code" }, ["verify", "code"]),
      edge("clean-verify-code", { node: "has-issues", outlet: "clean", port: "code" }, [
        "verify",
        "code",
      ]),
      edge("address-verify-report", { node: "address", port: "report" }, ["verify", "address"]),
    ],
    [
      { name: "verdict", type: VERDICT.type, from: { node: "verify", port: "verdict" } },
      { name: "code", type: "workspace@1", from: { node: "verify", port: "code" } },
    ],
    {
      loops: [
        {
          id: "rounds",
          nodes: ["fix", "prepare", "review", "has-issues", "address", "verify"],
          until: { path: "verify.verdict.complete", op: "eq", value: true },
          maxIterations: 3,
          carry: [
            { from: { node: "verify", port: "verdict" }, to: { node: "fix", port: "feedback" } },
            { from: { node: "verify", port: "code" }, to: { node: "fix", port: "code" } },
          ],
        },
      ],
    },
  );
}

const VERDICT_EXAMPLE = graphTypeExample({ types: [] } as never, "verification-verdict@1") as {
  acceptanceCriteria: { id: string; status: string; evidence: string }[];
};

function verdict(complete: boolean) {
  return {
    ...VERDICT_EXAMPLE,
    complete,
    acceptanceCriteria: VERDICT_EXAMPLE.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      status: complete ? "passed" : criterion.status,
    })),
  };
}

// ---------------------------------------------------------------- restart

describe("restart", () => {
  test("independent branches survive; exactly the descendants are superseded; the run reopens", async () => {
    const h = await harness();
    const plan = compiledPlan(graphFanOutTemplate(4));
    const done = await finish(h, (await launch(h, plan, { panel: 3 })).id);
    expect(done.status).toBe("complete");
    const before = (branch: string) => latest(done, "review", 1, branch);
    const restarted = before("panel.2");
    const consolidate = latest(done, "consolidate");
    const result = await h.service.restart(done.id, restarted.key, { requestId: "restart-1" });
    expect(result.repeated).toBe(false);
    expect(result.rewind).toMatchObject({
      id: "restart-1",
      kind: "restart",
      nodeId: "review",
      activation: restarted.key,
      iteration: 1,
      requestedBy: "user",
    });
    expect(result.rewind.superseded.activations).toEqual([restarted.key, consolidate.key]);
    expect(result.rewind.superseded.artifacts).toEqual(
      [restarted.outputs.report!, consolidate.outputs.report!].sort(),
    );
    // A finished run reopens; its finish time is cleared.
    expect(result.run.status).toBe("running");
    expect(result.run.finishedAt).toBeUndefined();
    // The store marks exactly those artifacts.
    const artifacts = await h.world.storage.graphRuns.listGraphArtifacts(done.id);
    for (const artifact of artifacts) {
      const superseded = result.rewind.superseded.artifacts.includes(artifact.id);
      expect(artifact.state).toBe(superseded ? "superseded" : "live");
      if (superseded) expect(artifact.supersededBy).toBe("restart-1");
    }

    const rerun = await finish(h, done.id);
    expect(rerun.status).toBe("complete");
    // The other branches are the same activations, started once.
    for (const branch of ["panel.1", "panel.3"]) {
      expect(latest(rerun, "review", 1, branch)).toEqual(before(branch));
      expect(
        h.world.fakes.callsOf("start", "review").filter((call) => call.key === before(branch).key),
      ).toHaveLength(1);
    }
    // The restarted branch reran as attempt 2 on the same inputs.
    const again = latest(rerun, "review", 1, "panel.2");
    expect(again.attempt).toBe(2);
    expect(again.inputs).toEqual(restarted.inputs);
    expect(states(rerun, "consolidate")).toEqual(["1.1:superseded", "1.2:complete"]);
    expect(latest(rerun, "consolidate").inputs.reports).toEqual([
      before("panel.1").outputs.report!,
      again.outputs.report!,
      before("panel.3").outputs.report!,
    ]);
  });

  test("admitted descendants are stopped through their executor before they are superseded", async () => {
    const h = await harness();
    h.world.fakes.held.add("fix");
    const plan = compiledPlan(chainTemplate());
    const run = await launch(h, plan);
    for (let index = 0; index < 4; index++) {
      h.time.jump(3_000);
      await h.service.advanceNow(run.id);
    }
    const running = (await h.service.get(run.id))!;
    const fix = latest(running, "fix");
    expect(fix.state).toBe("running");
    const build = latest(running, "build");
    const result = await h.service.restart(run.id, build.key);
    expect(result.rewind.superseded.activations).toEqual([build.key, fix.key]);
    const cancels = h.world.fakes.callsOf("cancel", "fix");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ key: fix.key, reason: "restarted" });
    expect(graphActivation(result.run, fix.key)).toMatchObject({
      state: "superseded",
      supersededBy: result.rewind.id,
    });
    h.world.fakes.held.delete("fix");
    const done = await finish(h, run.id);
    expect(done.status).toBe("complete");
    expect(states(done, "build")).toEqual(["1.1:superseded", "1.2:complete"]);
    expect(states(done, "fix")).toEqual(["1.1:superseded", "1.2:complete"]);
  });

  test("a failed run reopens and the failed node reruns as a new attempt", async () => {
    const h = await harness();
    h.world.fakes.failStart.set("fix", "provider-error");
    const failed = await finish(h, (await launch(h, compiledPlan(chainTemplate()))).id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBeDefined();
    const result = await h.service.restart(failed.id, latest(failed, "fix").key);
    expect(result.run.status).toBe("running");
    expect(result.run.error).toBeUndefined();
    expect(result.run.errorCause).toBeUndefined();
    const done = await finish(h, failed.id);
    expect(done.status).toBe("complete");
    expect(states(done, "fix")).toEqual(["1.1:superseded", "1.2:complete"]);
    expect(states(done, "build")).toEqual(["1.1:complete"]);
  });

  test("inside a loop the counter rewinds and carried inputs come from the previous iteration", async () => {
    const h = await harness();
    h.world.fakes.scripts.set("verify", ({ port, iteration }) =>
      port === "verdict" ? verdict(iteration >= 2) : undefined,
    );
    const plan = compiledPlan(pipelineLoopTemplate());
    const done = await finish(h, (await launch(h, plan)).id);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe("complete");
    expect(done.loopIterations.rounds).toBe(2);

    // Restarting round 1's review rewinds the loop to round 1.
    const review1 = latest(done, "review", 1);
    const result = await h.service.restart(done.id, review1.key);
    expect(result.run.loopIterations.rounds).toBe(1);
    const superseded = new Set(result.rewind.superseded.activations);
    for (const activation of done.activations) {
      const kept =
        activation.nodeId === "build" ||
        (activation.iteration === 1 && ["fix", "prepare"].includes(activation.nodeId));
      expect(superseded.has(activation.key)).toBe(!kept);
    }
    const rerun = await finish(h, done.id);
    expect(rerun.status).toBe("complete");
    expect(rerun.loopIterations.rounds).toBe(2);
    expect(latest(rerun, "review", 1).attempt).toBe(2);
    // Round 2's entry carries the rerun round 1's verify.
    expect(latest(rerun, "fix", 2)).toMatchObject({
      attempt: 2,
      inputs: expect.objectContaining({
        feedback: latest(rerun, "verify", 1).outputs.verdict,
        code: latest(rerun, "verify", 1).outputs.code,
      }),
    });

    // Restarting round 2's entry keeps round 1: its carried inputs are the same.
    const fix2 = latest(rerun, "fix", 2);
    const second = await h.service.restart(rerun.id, fix2.key);
    expect(second.run.loopIterations.rounds).toBe(2);
    const last = await finish(h, rerun.id);
    expect(latest(last, "fix", 2)).toMatchObject({ attempt: 3, inputs: fix2.inputs });
    expect(latest(last, "verify", 1).key).toBe(latest(rerun, "verify", 1).key);
  });

  test("a repeated request is a no-op; superseded and replaced activations are refused", async () => {
    const h = await harness();
    const done = await finish(h, (await launch(h, compiledPlan(chainTemplate()))).id);
    const fix = latest(done, "fix");
    const first = await h.service.restart(done.id, fix.key, { requestId: "click-1" });
    const again = await h.service.restart(done.id, fix.key, { requestId: "click-1" });
    expect(again.repeated).toBe(true);
    expect(again.rewind).toEqual(first.rewind);
    expect(again.run.revision).toBe(first.run.revision);
    // Without an id, the same activation the newest restart superseded is the same request.
    const doubled = await h.service.restart(done.id, fix.key);
    expect(doubled).toMatchObject({ repeated: true, rewind: { id: "click-1" } });
    // The id belongs to that rewind.
    const reused = await refusal(
      h.service.restart(done.id, latest(done, "build").key, { requestId: "click-1" }),
    );
    expect(reused.code).toBe("invalid-request");

    const rerun = await finish(h, done.id);
    await h.service.restart(rerun.id, latest(rerun, "verify").key);
    // fix#1 is now superseded by an older rewind: a previous attempt.
    const stale = await refusal(h.service.restart(rerun.id, fix.key));
    expect(stale.code).toBe("invalid-state");
    expect(stale.message).toContain("previous attempt");
    expect((await refusal(h.service.restart(rerun.id, "nope#iter=1#attempt=1"))).code).toBe(
      "not-found",
    );
    expect(
      (await refusal(h.service.restart(rerun.id, fix.key, { requestId: "bad id" }))).code,
    ).toBe("invalid-request");
  });

  test("a stopping run refuses, and a run allows at most 50 rewinds", async () => {
    const h = await harness();
    const done = await finish(h, (await launch(h, compiledPlan(chainTemplate()))).id);
    const fix = latest(done, "fix");
    const rewinds: GraphRewind[] = Array.from({ length: 50 }, (_, index) => ({
      id: `r${index}`,
      kind: "restart",
      nodeId: "fix",
      activation: fix.key,
      iteration: 1,
      requestedAt: done.createdAt,
      requestedBy: "user",
      superseded: { activations: [], artifacts: [] },
    }));
    const full = await h.world.storage.graphRuns.saveGraphRun({ ...done, rewinds }, done.revision);
    const limit = await refusal(h.service.restart(done.id, fix.key));
    expect(limit.code).toBe("limit");
    expect((await h.service.get(done.id))!.revision).toBe(full.revision);

    const stopping = await h.world.storage.graphRuns.saveGraphRun(
      { ...full, rewinds: [], status: "cancelling" },
      full.revision,
    );
    const refused = await refusal(h.service.restart(stopping.id, fix.key));
    expect(refused.code).toBe("invalid-state");
    expect(refused.message).toContain("stopping");
  });

  test("restart is refused once the run's pull request was merged", async () => {
    const h = await harness();
    const done = await finish(h, (await launch(h, compiledPlan(chainTemplate({ pr: true })))).id);
    expect(done.status).toBe("complete");
    await h.world.storage.updateEnvironment("e1", {
      prUrl: "https://github.com/o/r/pull/1",
      prState: "merged",
    });
    const merged = await refusal(h.service.restart(done.id, latest(done, "fix").key));
    expect(merged.code).toBe("invalid-state");
    expect(merged.message).toContain("merged");
  });
});

function graphActivation(run: GraphRun, key: string): NodeActivation | undefined {
  return run.activations.find((activation) => activation.key === key);
}

// ---------------------------------------------------------------- code rewind

interface Repository {
  dir: string;
  git: EnvironmentGit;
  commit(message: string): string;
  run(...args: string[]): string;
}

async function repository(): Promise<Repository> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-rewind-"));
  directories.push(root);
  const dir = path.join(root, "work");
  const origin = path.join(root, "origin.git");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const run = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
    );
  await fs.mkdir(dir);
  execFileSync("git", ["init", "--bare", "-q", origin], { env });
  run("init", "-q", "-b", "main");
  run("remote", "add", "origin", origin);
  let counter = 0;
  const commit = (message: string) => {
    counter += 1;
    execFileSync("sh", ["-c", `echo ${counter} > file-${counter}.txt`], { cwd: dir });
    run("add", "-A");
    run("commit", "-q", "-m", message);
    return run("rev-parse", "HEAD").trim();
  };
  return {
    dir,
    run,
    commit,
    git: async (_environmentId, args) => run(...args),
  };
}

/** A complete chain run whose build made c1 and fix c2 on top of c0, pushed to origin. */
async function codeRun(
  options: { docs?: boolean; git?: (repo: Repository) => EnvironmentGit } = {},
): Promise<{ h: Harness; repo: Repository; run: GraphRun; c: [string, string, string] }> {
  const repo = await repository();
  const c0 = repo.commit("base");
  const c1 = repo.commit("build: the feature");
  const c2 = repo.commit("fix: review findings");
  repo.run("push", "-q", "-u", "origin", "main");
  const h = await harness({ environmentGit: options.git?.(repo) ?? repo.git });
  const workspace = (headRef: string) => ({ branch: "main", headRef, baseRef: null });
  h.world.fakes.scripts.set("build", () => workspace(c1));
  h.world.fakes.scripts.set("fix", () => workspace(c2));
  h.world.fakes.scripts.set("docs", () => workspace(c2));
  const plan = compiledPlan(chainTemplate({ docs: options.docs ?? false }));
  const run = await finish(h, (await launch(h, plan, { inputs: { target: workspace(c0) } })).id);
  expect(run.status).toBe("complete");
  return { h, repo, run, c: [c0, c1, c2] };
}

describe("code rewind", () => {
  test("the preview names the target, the dropped commits, the upstream and what reruns", async () => {
    const { h, run, c } = await codeRun();
    const fix = latest(run, "fix");
    const preview = await h.service.previewCodeRewind(run.id, fix.key);
    expect(preview).toMatchObject({
      runId: run.id,
      activationKey: fix.key,
      nodeId: "fix",
      iteration: 1,
      targetCommit: c[1],
      head: c[2],
      commitCount: 1,
      commits: [{ sha: c[2], subject: "fix: review findings" }],
      upstream: { ref: "origin/main", droppedCommits: 1 },
      supersedes: { activations: 2, artifacts: 2, nodes: ["fix", "verify"] },
    });
    expect(preview.blocked).toBeUndefined();
  });

  test("it resets to the node's input commit behind a backup ref and records the push facts first", async () => {
    const { h, repo, run, c } = await codeRun();
    const fix = latest(run, "fix");
    const result = await h.service.rewindCode(run.id, fix.key, c[2], { requestId: "rewind-1" });
    expect(repo.run("rev-parse", "HEAD").trim()).toBe(c[1]);
    const backupRef = graphCodeRewindBackupRef(run.id, "rewind-1");
    expect(repo.run("rev-parse", backupRef).trim()).toBe(c[2]);
    expect(result.rewind).toMatchObject({
      id: "rewind-1",
      kind: "rewind-code",
      nodeId: "fix",
      activation: fix.key,
      code: {
        headRef: c[1],
        from: c[2],
        backupRef,
        upstream: "origin/main",
        upstreamCommitsDropped: 1,
      },
    });
    expect(result.rewind.code?.pending).toBeUndefined();
    expect(result.run.status).toBe("running");
    // The next push of the branch forces with lease, once (item 207).
    expect(graphForcePushRewind(result.run.rewinds, new Set())).toEqual({
      rewindId: "rewind-1",
      upstream: "origin/main",
    });
    expect(result.rewind.superseded.activations).toEqual([fix.key, latest(run, "verify").key]);
    // Repeating it changes nothing, with or without the id.
    expect(
      await h.service.rewindCode(run.id, fix.key, c[2], { requestId: "rewind-1" }),
    ).toMatchObject({ repeated: true, rewind: { id: "rewind-1" } });
    expect(await h.service.rewindCode(run.id, fix.key, c[2])).toMatchObject({ repeated: true });
    const done = await finish(h, run.id);
    expect(done.status).toBe("complete");
    expect(states(done, "fix")).toEqual(["1.1:superseded", "1.2:complete"]);
    expect(states(done, "build")).toEqual(["1.1:complete"]);
  });

  test("refusals: a running run, a dirty worktree, a moved branch, independent commits", async () => {
    const { h, repo, run, c } = await codeRun({ docs: true });
    const fix = latest(run, "fix");
    // docs reported c2 but does not depend on fix: the reset would drop its work.
    const independent = await h.service.previewCodeRewind(run.id, fix.key);
    expect(independent.blocked).toContain("node docs");
    expect((await refusal(h.service.rewindCode(run.id, fix.key, c[2]))).message).toContain(
      "node docs",
    );
    // Rewinding to build's own input commit drops docs' commit too.
    expect((await h.service.previewCodeRewind(run.id, latest(run, "build").key)).blocked).toContain(
      "node docs",
    );

    await fs.writeFile(path.join(repo.dir, "scratch.txt"), "work in progress\n");
    const dirty = await h.service.previewCodeRewind(run.id, fix.key);
    expect(dirty.uncommittedPaths).toEqual(["scratch.txt"]);
    expect(dirty.blocked).toContain("uncommitted changes");
    await fs.rm(path.join(repo.dir, "scratch.txt"));

    const moved = await refusal(h.service.rewindCode(run.id, fix.key, c[1]));
    expect(moved.code).toBe("invalid-state");
    expect(moved.message).toContain("moved since the rewind was previewed");
    expect(repo.run("rev-parse", "HEAD").trim()).toBe(c[2]);

    // A running run must be paused first.
    const reopened = await h.service.restart(run.id, latest(run, "verify").key);
    expect(reopened.run.status).toBe("running");
    const running = await h.service.previewCodeRewind(run.id, fix.key);
    expect(running.blocked).toContain("Pause the run first");
    expect((await refusal(h.service.rewindCode(run.id, fix.key, c[2]))).message).toContain(
      "Pause the run first",
    );
    // Nothing was reset.
    expect(repo.run("rev-parse", "HEAD").trim()).toBe(c[2]);
  });

  test("a reset interrupted after the journal is finished before the run plans again", async () => {
    let failReset = true;
    const { h, repo, run, c } = await codeRun({
      git: (repo) => async (environmentId, args) => {
        if (args[0] === "reset" && failReset) {
          failReset = false;
          throw new Error("simulated crash");
        }
        return repo.git(environmentId, args);
      },
    });
    const fix = latest(run, "fix");
    const interrupted = await refusal(
      h.service.rewindCode(run.id, fix.key, c[2], { requestId: "rewind-2" }),
    );
    expect(interrupted.message).toContain("reset did not finish");
    const journaled = (await h.service.get(run.id))!;
    expect(journaled.rewinds.at(-1)?.code).toMatchObject({ headRef: c[1], pending: true });
    expect(repo.run("rev-parse", "HEAD").trim()).toBe(c[2]);
    // The next pass finishes the reset first, then reruns fix.
    h.time.jump(3_000);
    const resumed = (await h.service.advanceNow(run.id))!;
    expect(repo.run("rev-parse", "HEAD").trim()).toBe(c[1]);
    expect(resumed.rewinds.at(-1)?.code?.pending).toBeUndefined();
    expect(latest(resumed, "fix").attempt).toBe(2);
    expect((await finish(h, run.id)).status).toBe("complete");
  });

  test("code rewinds are unavailable without Git and refused for a node without an input commit", async () => {
    const h = await harness();
    const done = await finish(h, (await launch(h, compiledPlan(chainTemplate()))).id);
    const fix = latest(done, "fix");
    expect((await refusal(h.service.rewindCode(done.id, fix.key, "c".repeat(40)))).code).toBe(
      "unavailable",
    );
    expect((await h.service.previewCodeRewind(done.id, fix.key)).blocked).toContain(
      "not available",
    );
    const repo = await repository();
    const head = repo.commit("base");
    const withGit = await harness({ environmentGit: repo.git });
    const plan = compiledPlan(
      template(
        "no-input-commit",
        [agent("note", "none", [], [NOTES])],
        [],
        [{ ...NOTES, from: { node: "note", port: "notes" } }],
      ),
    );
    const noted = await finish(withGit, (await launch(withGit, plan)).id);
    const refused = await refusal(
      withGit.service.rewindCode(noted.id, latest(noted, "note").key, head),
    );
    expect(refused.message).toContain("no input commit");
  });
});

// ---------------------------------------------------------------- commands

describe("commands", () => {
  test("graph_run_restart and the code-rewind commands validate and delegate", async () => {
    const { registerGraphRunRewindCommands } = await import("./commands-registry-graph-runs.js");
    const handlers = new Map<
      string,
      (args: Record<string, unknown>, context: unknown) => unknown
    >();
    registerGraphRunRewindCommands(((name: string, handler: never) =>
      handlers.set(name, handler)) as never);
    const call = (name: string, args: Record<string, unknown>, context: unknown) =>
      Promise.resolve().then(() => handlers.get(name)!(args, context));
    const { h, run, c } = await codeRun();
    const context = { graphRuns: h.service };
    const fix = latest(run, "fix");

    expect((await refusal(call("graph_run_restart", { runId: run.id }, context))).code).toBe(
      "invalid-request",
    );
    expect(
      (
        await refusal(
          call("graph_run_restart", { runId: run.id, activationKey: fix.key, x: 1 }, context),
        )
      ).message,
    ).toContain("Unknown arguments");
    expect(
      (
        await refusal(
          call(
            "graph_run_rewind_code",
            { runId: run.id, activationKey: fix.key, expectedHead: "HEAD" },
            context,
          ),
        )
      ).message,
    ).toContain("expectedHead");
    expect(
      (await refusal(call("graph_run_restart", { runId: run.id, activationKey: fix.key }, {})))
        .code,
    ).toBe("unavailable");

    const preview = (await call(
      "graph_run_rewind_code_preview",
      { runId: run.id, activationKey: fix.key },
      context,
    )) as { head: string; targetCommit: string };
    expect(preview).toMatchObject({ head: c[2], targetCommit: c[1] });
    const rewound = (await call(
      "graph_run_rewind_code",
      { runId: run.id, activationKey: fix.key, expectedHead: preview.head, requestId: "ui-1" },
      context,
    )) as { rewind: GraphRewind; repeated: boolean };
    expect(rewound).toMatchObject({ repeated: false, rewind: { id: "ui-1", requestedBy: "user" } });
    const rerun = await finish(h, run.id);
    const restarted = (await call(
      "graph_run_restart",
      { runId: run.id, activationKey: latest(rerun, "verify").key, requestId: "ui-2" },
      context,
    )) as { rewind: GraphRewind; run: GraphRun };
    expect(restarted.rewind).toMatchObject({ id: "ui-2", kind: "restart", nodeId: "verify" });
    expect(restarted.run.status).toBe("running");
  });
});
