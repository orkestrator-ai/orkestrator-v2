/**
 * The run view's commands (item 211): list, the revisioned snapshot, the
 * run-wide and activation actions, and the bounded artifact and transcript
 * reads, over a real store and hand-driven scheduler passes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  GRAPH_RUN_VIEW_BOUNDS,
  type GraphRunArtifactView,
  type GraphRunGetResult,
  type GraphRunSummary,
  type GraphRunTranscriptView,
} from "@orkestrator/protocol/graphs/run-view";
import type { GraphArtifact, GraphRun } from "@orkestrator/protocol/graphs/run";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { GraphRunWorld } from "./graph-run-executor-test-support.js";
import {
  advanceUntil,
  failingPlan,
  harness,
  latest,
  launch,
  type Harness,
} from "./graph-run-view-test-support.js";

const commands = createCommandRegistry();
const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

function contextOf(h: Harness, storage: unknown = h.world.storage): CommandContext {
  return { storage, graphRuns: h.service } as unknown as CommandContext;
}

async function call<T>(
  context: CommandContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const handler = commands.get(name);
  if (!handler) throw new Error(`Not registered: ${name}`);
  return (await handler(args, context)) as T;
}

async function refused(
  context: CommandContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    await call(context, name, args);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error(`${name} was not refused`);
}

/** A live run: `build` held running (with a session), `slow` held. */
async function liveRun(h: Harness): Promise<GraphRun> {
  h.world.fakes.withSessions = true;
  h.world.fakes.held.add("build");
  h.world.fakes.held.add("slow");
  const launched = await launch(h, failingPlan({ onFailure: "skip" }));
  return advanceUntil(h, launched.id, (run) => latest(run, "build")?.state === "running");
}

describe("graph run view commands", () => {
  test("are registered", () => {
    for (const name of [
      "graph_runs_list",
      "graph_run_get",
      "graph_run_cancel",
      "graph_run_pause",
      "graph_run_resume",
      "graph_run_retry",
      "graph_run_skip",
      "graph_run_artifact",
      "graph_run_transcript",
      "graph_run_answer",
    ]) {
      expect(commands.has(name)).toBe(true);
    }
  });

  test("list summarises an environment's runs, newest first", async () => {
    const h = await harness(worlds);
    const context = contextOf(h);
    const first = await liveRun(h);
    const second = await launch(h, failingPlan({ onFailure: "skip" }));
    const listed = await call<GraphRunSummary[]>(context, "graph_runs_list", {
      environmentId: "e1",
    });
    expect(listed.map((summary) => summary.id).sort()).toEqual([first.id, second.id].sort());
    const summary = listed.find((entry) => entry.id === first.id)!;
    expect(summary).toMatchObject({ name: "Retryable", status: "running", mock: false });
    expect(summary.activations.running).toBeGreaterThanOrEqual(1);
    expect("plan" in summary).toBe(false);
    expect(await call(context, "graph_runs_list", { environmentId: "e2" })).toEqual([]);
    expect(await refused(context, "graph_runs_list", {})).toBe("invalid-request");
    expect(await refused(context, "graph_runs_list", { environmentId: "e1", x: 1 })).toBe(
      "invalid-request",
    );
  });

  test("get returns the snapshot, or unchanged at the known revision", async () => {
    const h = await harness(worlds);
    const context = contextOf(h);
    const run = await liveRun(h);
    const got = await call<GraphRunGetResult>(context, "graph_run_get", { runId: run.id });
    if (got.status !== "changed") throw new Error("expected a snapshot");
    expect(got.run.revision).toBe(run.revision);
    expect(
      await call<GraphRunGetResult>(context, "graph_run_get", {
        runId: run.id,
        knownRevision: run.revision,
      }),
    ).toEqual({ status: "unchanged", revision: run.revision });
    expect(
      (
        await call<GraphRunGetResult>(context, "graph_run_get", {
          runId: run.id,
          knownRevision: run.revision - 1,
        })
      ).status,
    ).toBe("changed");
    expect(await refused(context, "graph_run_get", { runId: "missing" })).toBe("not-found");
    expect(await refused(context, "graph_run_get", { runId: "" })).toBe("invalid-request");
    expect(await refused(context, "graph_run_get", { runId: run.id, knownRevision: -1 })).toBe(
      "invalid-request",
    );
    expect(
      await refused({ storage: h.world.storage } as never, "graph_run_get", {
        runId: run.id,
      }),
    ).toBe("disabled");
  });

  test("the snapshot leaves out the runtime's own prompts", async () => {
    const h = await harness(worlds);
    const context = contextOf(h);
    const run = await liveRun(h);
    const build = latest(run, "build")!;
    const saved = await h.world.storage.graphRuns.saveGraphRun(
      {
        ...run,
        activations: run.activations.map((activation) =>
          activation.key === build.key
            ? {
                ...activation,
                session: { ...activation.session!, repairPrompt: "secret repair prompt" },
              }
            : activation,
        ),
      },
      run.revision,
    );
    const got = await call<GraphRunGetResult>(context, "graph_run_get", { runId: saved.id });
    if (got.status !== "changed") throw new Error("expected a snapshot");
    const session = latest(got.run, "build")!.session!;
    expect(session.repairPrompt).toBeUndefined();
    expect(session.requestId).toBe(build.session!.requestId);
  });

  test("pause, resume, cancel, retry and skip return the changed snapshot", async () => {
    const h = await harness(worlds);
    const context = contextOf(h);
    const run = await liveRun(h);
    const paused = await call<GraphRunGetResult>(context, "graph_run_pause", { runId: run.id });
    expect(paused).toMatchObject({ status: "changed", run: { status: "paused" } });
    const resumed = await call<GraphRunGetResult>(context, "graph_run_resume", { runId: run.id });
    expect(resumed).toMatchObject({ status: "changed", run: { status: "running" } });
    expect(
      await refused(context, "graph_run_retry", {
        runId: run.id,
        activationKey: latest(run, "build")!.key,
      }),
    ).toBe("invalid-state");
    expect(
      await refused(context, "graph_run_skip", {
        runId: run.id,
        activationKey: latest(run, "build")!.key,
      }),
    ).toBe("invalid-state");
    expect(await refused(context, "graph_run_skip", { runId: run.id })).toBe("invalid-request");
    const cancelled = await call<GraphRunGetResult>(context, "graph_run_cancel", {
      runId: run.id,
    });
    expect(cancelled).toMatchObject({ status: "changed", run: { status: "cancelling" } });
    expect(await refused(context, "graph_run_cancel", { runId: run.id, extra: true })).toBe(
      "invalid-request",
    );
  });

  test("an artifact read returns its value within the bound", async () => {
    const h = await harness(worlds);
    const context = contextOf(h);
    const run = await liveRun(h);
    const inputId = run.bindings.inputs.target!;
    const view = await call<GraphRunArtifactView>(context, "graph_run_artifact", {
      runId: run.id,
      artifactId: inputId,
    });
    expect(view.artifact).toMatchObject({ id: inputId, type: "workspace@1", runId: run.id });
    expect("body" in view.artifact).toBe(false);
    expect(view.value).toMatchObject({ headRef: expect.any(String) });
    expect(view.valueOmitted).toBeUndefined();
    expect(
      await refused(context, "graph_run_artifact", { runId: run.id, artifactId: "nope" }),
    ).toBe("not-found");
  });

  test("an oversized value is omitted; a reference artifact gives its file's metadata only", async () => {
    const h = await harness(worlds);
    const run = await liveRun(h);
    const stored = (await h.world.storage.graphRuns.getGraphArtifact(
      run.id,
      run.bindings.inputs.target!,
    ))!;
    const fakes: Record<string, GraphArtifact> = {
      big: {
        ...stored,
        id: "big",
        body: { value: { text: "x".repeat(GRAPH_RUN_VIEW_BOUNDS.maxArtifactViewBytes + 1) } },
      },
      ref: {
        ...stored,
        id: "ref",
        type: "review-package@2",
        body: {
          file: {
            path: `.orkestrator/graph-artifacts/${run.id}/${"c".repeat(64)}`,
            sha256: "c".repeat(64),
            bytes: 10,
          },
          value: { descriptor: true },
        },
      },
      foreign: { ...stored, id: "foreign", runId: "other-run" },
    };
    const storage = new Proxy(h.world.storage, {
      get(target, property, receiver) {
        if (property !== "graphRuns") return Reflect.get(target, property, receiver);
        return new Proxy(target.graphRuns, {
          get(runs, name, inner) {
            if (name !== "getGraphArtifact") return Reflect.get(runs, name, inner);
            return async (_runId: string, id: string) => fakes[id] ?? null;
          },
        });
      },
    });
    const context = contextOf(h, storage);
    const big = await call<GraphRunArtifactView>(context, "graph_run_artifact", {
      runId: run.id,
      artifactId: "big",
    });
    expect(big.value).toBeUndefined();
    expect(big.valueOmitted).toBe("too-large");
    const ref = await call<GraphRunArtifactView>(context, "graph_run_artifact", {
      runId: run.id,
      artifactId: "ref",
    });
    expect(ref.file).toEqual({
      path: `.orkestrator/graph-artifacts/${run.id}/${"c".repeat(64)}`,
      sha256: "c".repeat(64),
      bytes: 10,
    });
    expect(ref.value).toEqual({ descriptor: true });
    expect(
      await refused(context, "graph_run_artifact", { runId: run.id, artifactId: "foreign" }),
    ).toBe("not-found");
  });

  test("a transcript read: none before capture, then the stored window", async () => {
    const h = await harness(worlds);
    const context = contextOf(h);
    let run = await liveRun(h);
    const build = latest(run, "build")!;
    expect(
      await call<GraphRunTranscriptView>(context, "graph_run_transcript", {
        runId: run.id,
        activationKey: build.key,
      }),
    ).toEqual({ status: "none" });
    const messages = [
      { id: "m1", role: "user", text: "Do build." },
      { id: "m2", role: "assistant", text: "Done." },
    ];
    const reference = await h.world.storage.commitGraphRunTranscript({
      runId: run.id,
      activationKey: build.key,
      sdkSessionId: "provider-session",
      messages,
      revision: 1,
      fingerprint: "fp-1",
    });
    expect(reference).not.toBeNull();
    run = await h.world.storage.graphRuns.saveGraphRun(
      {
        ...run,
        activations: run.activations.map((activation) =>
          activation.key === build.key
            ? { ...activation, session: { ...activation.session!, transcript: reference! } }
            : activation,
        ),
      },
      run.revision,
    );
    const found = await call<GraphRunTranscriptView>(context, "graph_run_transcript", {
      runId: run.id,
      activationKey: build.key,
    });
    expect(found).toMatchObject({
      status: "found",
      messages,
      startIndex: 0,
      messageCount: 2,
      revision: 1,
      complete: true,
    });
    const window = await call<GraphRunTranscriptView>(context, "graph_run_transcript", {
      runId: run.id,
      activationKey: build.key,
      fromIndex: 1,
      maxBytes: 10 * GRAPH_RUN_VIEW_BOUNDS.maxTranscriptReadBytes,
    });
    expect(window).toMatchObject({ status: "found", messages: [messages[1]], startIndex: 1 });
    expect(
      await refused(context, "graph_run_transcript", {
        runId: run.id,
        activationKey: "nope#iter=1#attempt=1",
      }),
    ).toBe("not-found");
    expect(
      await refused(context, "graph_run_transcript", {
        runId: run.id,
        activationKey: build.key,
        fromIndex: -2,
      }),
    ).toBe("invalid-request");
  });
});
