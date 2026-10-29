import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import { graphBuiltInType, validateGraphArtifactValue } from "@orkestrator/protocol/graphs/types";
import type { GraphActivationReport } from "./graph-run-executors.js";
import { graphValidationRunId } from "./graph-system-validation.js";
import { systemWorld, type SystemWorld } from "./graph-system-test-support.js";

const worlds: SystemWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

async function world(): Promise<SystemWorld> {
  const created = await systemWorld();
  worlds.push(created);
  return created;
}

/** A poll wait of 5 ms that a stop cuts short. */
const slowSleep = (_ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

function outputsOf(report: GraphActivationReport): Record<string, string> {
  if (report.state !== "complete")
    throw new Error(`expected complete, got ${JSON.stringify(report)}`);
  return report.outputs;
}

async function valueOf(w: SystemWorld, id: string): Promise<unknown> {
  const artifact = await w.artifacts.requireVerified(w.run.id, id);
  return "value" in artifact.body ? artifact.body.value : undefined;
}

describe("run-validation", () => {
  test("runs the plan through the validation worker and reports the failures", async () => {
    const w = await world();
    w.commands.validationOutcome = { typecheck: "passed", test: "failed" };
    w.commands.validationReadsToSettle = 2;
    const outputs = outputsOf(await w.executor().start(w.context(w.activation("validate"))));
    const results = (await valueOf(w, outputs.results!)) as {
      state: string;
      failures: Array<{ id: string; output: string; summary: string; command: string }>;
    };
    expect(results).toMatchObject({ headRef: w.head, state: "failed", total: 2, passed: 1 });
    expect(results.failures).toHaveLength(1);
    expect(results.failures[0]).toMatchObject({
      id: "test",
      command: "cd . && bun test src/reports",
      state: "failed",
      exitCode: 1,
      summary: "Exited with code 1",
    });
    // The tail of stdout then stderr, bounded by the default 8 KiB.
    expect(results.failures[0]!.output.endsWith("expected 3 rows, received 2")).toBe(true);
    expect(Buffer.byteLength(results.failures[0]!.output)).toBeLessThanOrEqual(8_192);
    expect(validateGraphArtifactValue(graphBuiltInType("validation-results@1")!, results)).toEqual(
      [],
    );
    expect(await valueOf(w, outputs.code!)).toEqual({
      branch: "feature/csv",
      headRef: w.head,
      baseRef: null,
    });
    // One worker run, started once and read until it settled.
    expect(w.commands.validations.size).toBe(1);
    expect(w.commands.count("start_review_validation")).toBe(1);
  });

  test("a retry or restart reads the same validation run instead of running the commands again", async () => {
    const w = await world();
    const first = outputsOf(await w.executor().start(w.context(w.activation("validate"))));
    const second = outputsOf(
      await w
        .executor({ owner: "process-2" })
        .recover(w.context(w.activation("validate", { attempt: 2 }))),
    );
    expect(w.commands.validations.size).toBe(1);
    expect(w.commands.count("start_review_validation")).toBe(1);
    expect(await valueOf(w, second.results!)).toEqual(await valueOf(w, first.results!));
  });

  test("a crash while the commands ran joins the same worker run", async () => {
    const w = await world();
    w.commands.validationReadsToSettle = 5;
    const crashed = w.executor({ inlineWaitMs: 1, sleep: slowSleep });
    expect((await crashed.start(w.context(w.activation("validate")))).state).toBe("running");
    crashed.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 10));
    outputsOf(
      await w.executor({ owner: "process-2" }).recover(w.context(w.activation("validate"))),
    );
    expect(w.commands.validations.size).toBe(1);
  });

  test("a cancelled validation is started afresh on the next attempt", async () => {
    const w = await world();
    w.commands.cancelValidations = true;
    const failed = await w.executor().start(w.context(w.activation("validate")));
    expect(failed).toMatchObject({ state: "failed" });
    w.commands.cancelValidations = false;
    outputsOf(await w.executor().start(w.context(w.activation("validate", { attempt: 2 }))));
    const ids = [...w.commands.validations.keys()];
    expect(ids).toEqual([
      graphValidationRunId("run-1", "validate#iter=1", planDigest(w), 1),
      graphValidationRunId("run-1", "validate#iter=1", planDigest(w), 2),
    ]);
  });

  test("cancelling the node stops the worker's run", async () => {
    const w = await world();
    w.commands.validationReadsToSettle = 100;
    const executor = w.executor({ inlineWaitMs: 1, sleep: slowSleep });
    const activation = w.activation("validate");
    await executor.start(w.context(activation));
    const running = { ...activation, state: "running" as const };
    expect((await executor.cancel(w.context(running), "timeout")).state).toBe("unchanged");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await executor.cancel(w.context(running), "timeout")).toEqual({ state: "cancelled" });
    expect(w.commands.count("cancel_review_validation")).toBe(1);
    expect([...w.commands.validations.values()][0]!.status).toBe("cancelled");
  });

  test("a plan for another commit, or an environment that moved, is refused", async () => {
    const w = await world();
    w.shell.head = "f".repeat(40);
    const report = await w.executor().start(w.context(w.activation("validate")));
    expect(report).toMatchObject({ state: "failed", cause: "system-error" });
    expect((report as { error: string }).error).toContain("not the commit to validate");
    expect(w.commands.validations.size).toBe(0);
  });

  test("a plan for an ancestor runs on the later commit a repair loop carries", async () => {
    const w = await world();
    const fixed = "a".repeat(40);
    w.shell.head = fixed;
    w.shell.commits.add(fixed);
    w.shell.ancestry.add(`${w.head}>${fixed}`);
    const code = await w.artifacts.putValue({
      runId: w.run.id,
      type: "workspace@1",
      producer: { nodeId: "fix", activation: "fix#iter=1#attempt=1", port: "code" },
      value: { branch: "feature/csv", headRef: fixed, baseRef: null },
    });
    const activation = w.activation("validate", { iteration: 2 });
    activation.inputs = { ...activation.inputs, code: code.id };
    const outputs = outputsOf(await w.executor().start(w.context(activation)));
    // The worker ran the same commands, on the fixed commit.
    const start = w.commands.calls.find((call) => call.command === "start_review_validation")!;
    expect((start.args.run as { plan: { headRef: string } }).plan.headRef).toBe(fixed);
    expect(await valueOf(w, outputs.results!)).toMatchObject({ headRef: fixed });
    expect(await valueOf(w, outputs.code!)).toMatchObject({ headRef: fixed });
  });

  test("a plan for a commit outside the workspace's history is refused", async () => {
    const w = await world();
    const other = "b".repeat(40);
    w.shell.head = other;
    w.shell.commits.add(other);
    const code = await w.artifacts.putValue({
      runId: w.run.id,
      type: "workspace@1",
      producer: { nodeId: "fix", activation: "fix#iter=1#attempt=1", port: "code" },
      value: { branch: "feature/csv", headRef: other, baseRef: null },
    });
    const activation = w.activation("validate", { iteration: 2 });
    activation.inputs = { ...activation.inputs, code: code.id };
    const report = await w.executor().start(w.context(activation));
    expect(report).toMatchObject({ state: "failed", cause: "system-error" });
    expect((report as { error: string }).error).toContain("or one of its ancestors");
    expect(w.commands.validations.size).toBe(0);
  });
});

function planDigest(w: SystemWorld): string {
  const plan = { ...(graphBuiltInType("validation-plan@1")!.example as object), headRef: w.head };
  return createHash("sha256").update(canonicalJson(plan, 64)).digest("hex").slice(0, 16);
}

describe("run-validation-and-seal", () => {
  test("validates, seals one package and stores it as a hash-verified reference artifact", async () => {
    const w = await world();
    const outputs = outputsOf(await w.executor().start(w.context(w.activation("seal"))));
    const artifact = await w.artifacts.requireVerified(w.run.id, outputs.package!);
    expect(artifact.type).toBe("review-package@2");
    expect("file" in artifact.body).toBe(true);
    const body = artifact.body as {
      file: { path: string; sha256: string };
      value: Record<string, unknown>;
    };
    expect(body.value).toMatchObject({
      kind: "file",
      round: 1,
      targetBranch: "main",
      headRef: w.head,
    });
    expect(body.value).not.toHaveProperty("diffCharacters");
    const sealed = await fs.readFile(path.join(w.worktree, body.file.path));
    expect(createHash("sha256").update(sealed).digest("hex")).toBe(body.file.sha256);
    expect(w.commands.packages).toHaveLength(1);

    // A retry replays the validation and the seal.
    outputsOf(await w.executor().start(w.context(w.activation("seal", { attempt: 2 }))));
    expect(w.commands.packages).toHaveLength(1);
    expect(w.commands.count("start_review_validation")).toBe(1);
    const generate = w.commands.calls.find((call) => call.command === "generate_review_package")!;
    expect(generate.args).toMatchObject({ expectedHead: w.head, round: 1, targetBranch: "main" });
  });

  test("sealing refuses a plan made for an ancestor: the package names the plan's commit", async () => {
    const w = await world();
    const fixed = "a".repeat(40);
    w.shell.head = fixed;
    w.shell.commits.add(fixed);
    w.shell.ancestry.add(`${w.head}>${fixed}`);
    const code = await w.artifacts.putValue({
      runId: w.run.id,
      type: "workspace@1",
      producer: { nodeId: "fix", activation: "fix#iter=1#attempt=1", port: "code" },
      value: { branch: "feature/csv", headRef: fixed, baseRef: null },
    });
    const activation = w.activation("seal");
    activation.inputs = { ...activation.inputs, code: code.id };
    const report = await w.executor().start(w.context(activation));
    expect(report).toMatchObject({ state: "failed", cause: "system-error" });
    expect((report as { error: string }).error).toContain("the workspace is at");
    expect(w.commands.validations.size).toBe(0);
    expect(w.commands.packages).toHaveLength(0);
  });
});
