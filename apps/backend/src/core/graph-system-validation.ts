/**
 * `run-validation` and `run-validation-and-seal` (plan P2.7, report §6.6,
 * §9.4): the review validation service with no agent.
 *
 * Both run the `validation-plan@1`'s commands against the `workspace@1`
 * commit through the environment-owned validation worker
 * (`start_review_validation` / `status_review_validation`, the commands the
 * Build Pipeline and Multi Review drive), after checking that the plan names
 * that commit and that it is the environment's HEAD. `run-validation` also
 * accepts a plan made for an ancestor of that commit and runs it on the
 * commit itself: a repair loop (report §9.4) carries the fixer's new commit
 * into the next iteration with the plan the run started with. Sealing stays
 * exact, because the package names the commit its plan was made for. The worker is
 * idempotent per validation run id, and the id is derived from the run,
 * the activation slot, the plan and a generation, so a retry, a restart or a
 * second backend process joins the same validation run instead of running the
 * commands twice; a run that ended cancelled or failed is started afresh with
 * the next generation (effect `<action>:<slot>:validation:<plan digest>`).
 *
 * - `run-validation` reports `validation-results@1`: the outcome and each
 *   failing or unfinished command with a bounded tail of its output, and
 *   passes the validated `workspace@1` through.
 * - `run-validation-and-seal` then seals one review package with
 *   `generate_review_package` (once: effect `…:seal:<plan digest>`) and
 *   stores it as a `review-package@2` reference artifact, the package file
 *   copied into the run's artifact directory and hash-verified there.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import type { GraphValidationResultsV1 } from "@orkestrator/protocol/graphs/types";
import {
  newReviewValidationRun,
  parseReviewValidationPlan,
  type ReviewPackageReference,
  type ReviewValidationOutput,
  type ReviewValidationPlan,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import {
  GraphSystemActionError,
  type GraphSystemActionContext,
  type GraphSystemActionHandler,
} from "./graph-system-action.js";
import type { GraphWorkspaceValue } from "./graph-system-push.js";
import type { Environment } from "./models.js";
import { parseReviewPackageReference } from "./review-package.js";
import { validationPreparation } from "./review-validation-service.js";

/** How often a validation job reads the worker's state while commands run. */
export const GRAPH_VALIDATION_POLL_MS = 3_000;
/** Output kept across all failures of one `validation-results@1` (its byte cap is 384 KiB). */
const RESULTS_OUTPUT_BUDGET = 300 * 1024;
const MAX_LIMITATIONS = 32;
const MAX_LIMITATION_CHARS = 2_000;

interface ValidationInputs {
  plan: ReviewValidationPlan;
  workspace: GraphWorkspaceValue;
  environment: Environment;
  digest: string;
}

function digestOf(plan: ReviewValidationPlan): string {
  return createHash("sha256").update(canonicalJson(plan, 64)).digest("hex").slice(0, 16);
}

/** The worker's run id: `graph-validation-<hash>`, within `[A-Za-z0-9_-]{1,200}`. */
export function graphValidationRunId(
  runId: string,
  slot: string,
  digest: string,
  generation: number,
): string {
  const hash = createHash("sha256")
    .update(`${runId}\0${slot}\0${digest}\0${generation}`)
    .digest("hex")
    .slice(0, 32);
  return `graph-validation-${hash}`;
}

/** Whether `ancestor` is `descendant` or one of its ancestors; any failure answers no. */
async function isAncestor(
  ctx: GraphSystemActionContext,
  environment: Environment,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await ctx.deps.shell.git(environment, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The plan, the commit to validate and the environment. With
 * `acceptAncestorPlan`, a plan for an ancestor of the workspace commit is
 * rebased onto that commit (its commands run there); otherwise the plan must
 * name the commit exactly.
 */
async function validationInputs(
  ctx: GraphSystemActionContext,
  options: { acceptAncestorPlan: boolean },
): Promise<ValidationInputs> {
  let plan: ReviewValidationPlan;
  try {
    plan = parseReviewValidationPlan(await ctx.requireInput("validation-plan@1"));
  } catch (error) {
    if (error instanceof GraphSystemActionError) throw error;
    throw new GraphSystemActionError("The validation plan is invalid", "invalid-result");
  }
  const workspace = await ctx.requireInput<GraphWorkspaceValue>("workspace@1");
  const environment = await ctx.environment();
  if (plan.headRef !== workspace.headRef) {
    if (
      !options.acceptAncestorPlan ||
      !(await isAncestor(ctx, environment, plan.headRef, workspace.headRef))
    ) {
      throw new GraphSystemActionError(
        options.acceptAncestorPlan
          ? `The validation plan is for commit ${plan.headRef.slice(0, 12)}, which is not the workspace's commit ${workspace.headRef.slice(0, 12)} or one of its ancestors`
          : `The validation plan is for commit ${plan.headRef.slice(0, 12)}, the workspace is at ${workspace.headRef.slice(0, 12)}`,
      );
    }
    plan = { ...plan, headRef: workspace.headRef };
  }
  const head = (
    await ctx.deps.shell.git(environment, ["rev-parse", "--verify", "HEAD^{commit}"])
  ).trim();
  if (head !== workspace.headRef) {
    throw new GraphSystemActionError(
      `The environment's HEAD is ${head.slice(0, 12)}, not the commit to validate (${workspace.headRef.slice(0, 12)})`,
    );
  }
  return { plan, workspace, environment, digest: digestOf(plan) };
}

function isSettled(run: ReviewValidationRun): boolean {
  return run.status !== "planned" && run.status !== "running";
}

/**
 * Runs the plan once per run, slot, plan and generation and returns the
 * worker's final snapshot; a recorded run is read back, not run again.
 */
async function validate(
  ctx: GraphSystemActionContext,
  inputs: ValidationInputs,
): Promise<ReviewValidationRun> {
  const key = ctx.slotKey(`validation:${inputs.digest}`);
  const prior = await ctx.effectRecord(key);
  const priorGeneration = typeof prior?.data?.generation === "number" ? prior.data.generation : 1;
  let generation = prior?.state === "failed" ? priorGeneration + 1 : priorGeneration;
  const startedAt =
    prior?.state !== "failed" && typeof prior?.data?.startedAt === "string"
      ? prior.data.startedAt
      : ctx.now().toISOString();
  let id =
    prior?.state === "done" && typeof prior.data?.validationRunId === "string"
      ? prior.data.validationRunId
      : graphValidationRunId(ctx.run.id, ctx.slot, inputs.digest, generation);
  let planned: ReviewValidationRun = { ...newReviewValidationRun(id, inputs.plan), startedAt };
  const control = (command: "start" | "status") =>
    ctx.deps.invoke<ReviewValidationRun>(`${command}_review_validation`, {
      environmentId: inputs.environment.id,
      run: planned,
    });

  let final: ReviewValidationRun | null = null;
  await ctx.effect(
    key,
    async () => {
      // The worker claims the run once; a second start reads the running one.
      let run = await control("start");
      while (!isSettled(run)) {
        await ctx.sleep(GRAPH_VALIDATION_POLL_MS);
        ctx.throwIfAborted();
        run = await control("status");
      }
      if (run.status !== "completed" && prior?.state === "intended") {
        // The run this intent joined was stopped (the node was cancelled or
        // the backend stopped it): run the commands afresh, once.
        generation += 1;
        id = graphValidationRunId(ctx.run.id, ctx.slot, inputs.digest, generation);
        planned = {
          ...newReviewValidationRun(id, inputs.plan),
          startedAt: ctx.now().toISOString(),
        };
        run = await control("start");
        while (!isSettled(run)) {
          await ctx.sleep(GRAPH_VALIDATION_POLL_MS);
          ctx.throwIfAborted();
          run = await control("status");
        }
      }
      if (run.status !== "completed") {
        throw new GraphSystemActionError(
          run.status === "cancelled"
            ? "Validation was cancelled before every command finished"
            : "The validation worker failed",
        );
      }
      final = run;
      return {
        validationRunId: id,
        generation,
        startedAt: planned.startedAt,
        completedAt: run.completedAt ?? null,
      };
    },
    { data: { validationRunId: id, generation, startedAt } },
  );
  return final ?? (await control("status"));
}

/** The last `bytes` of a validation command's output, stderr after stdout. */
async function outputTail(
  ctx: GraphSystemActionContext,
  environmentId: string,
  run: ReviewValidationRun,
  resultId: string,
  bytes: number,
): Promise<string> {
  let output: ReviewValidationOutput;
  try {
    output = await ctx.deps.invoke<ReviewValidationOutput>("get_review_validation_output", {
      environmentId,
      runId: run.id,
      resultId,
    });
  } catch {
    return "(the command's output could not be read)";
  }
  const decode = (stream: ReviewValidationOutput["stdout"]) =>
    stream ? Buffer.from(stream.contentBase64, "base64") : Buffer.alloc(0);
  const joined = Buffer.concat([decode(output.stdout), Buffer.from("\n"), decode(output.stderr)]);
  const tail = joined.subarray(Math.max(0, joined.length - bytes));
  // Drop a split UTF-8 sequence at the cut.
  return tail.toString("utf8").replace(/^�+/, "").trim();
}

/** `validation-results@1` from a settled validation run. */
export async function graphValidationResults(
  ctx: GraphSystemActionContext,
  environmentId: string,
  run: ReviewValidationRun,
  outputBytes: number,
): Promise<GraphValidationResultsV1> {
  const unfinished = run.results.filter((result) => result.status === "incomplete");
  const failedResults = run.results.filter((result) => result.status === "failed");
  const listed = run.results.filter(
    (result) => result.status === "failed" || result.status === "incomplete",
  );
  const perFailure = Math.max(
    256,
    Math.min(outputBytes, Math.floor(RESULTS_OUTPUT_BUDGET / Math.max(1, listed.length))),
  );
  const failures: GraphValidationResultsV1["failures"] = [];
  for (const result of listed) {
    const command = run.plan.commands.find((entry) => entry.id === result.id);
    failures.push({
      id: result.id,
      command: command ? `cd ${command.cwd} && ${result.command}` : result.command,
      state: result.status === "failed" ? "failed" : "incomplete",
      exitCode: result.exitCode,
      summary:
        result.status === "failed"
          ? result.exitCode === null
            ? (result.limitation ?? "Failed")
            : `Exited with code ${result.exitCode}`
          : (result.limitation ?? "Did not finish"),
      output: await outputTail(ctx, environmentId, run, result.id, perFailure),
    });
  }
  const limitations = [...run.plan.limitations, ...(run.error ? [run.error] : [])]
    .slice(0, MAX_LIMITATIONS)
    .map((limitation) => limitation.slice(0, MAX_LIMITATION_CHARS));
  return {
    headRef: run.plan.headRef,
    state: failedResults.length > 0 ? "failed" : unfinished.length > 0 ? "incomplete" : "passed",
    total: run.results.length,
    passed: run.results.filter((result) => result.status === "passed").length,
    failures,
    limitations,
  };
}

function workspaceFacts(workspace: GraphWorkspaceValue) {
  return {
    headRef: workspace.headRef,
    ...(workspace.baseRef ? { baseRef: workspace.baseRef } : {}),
  };
}

export const runValidationAction: GraphSystemActionHandler = {
  action: "run-validation",
  async run(ctx) {
    const inputs = await validationInputs(ctx, { acceptAncestorPlan: true });
    const run = await validate(ctx, inputs);
    const outputBytes = typeof ctx.params.outputBytes === "number" ? ctx.params.outputBytes : 8_192;
    if (ctx.produces("validation-results@1")) {
      const results = await graphValidationResults(ctx, inputs.environment.id, run, outputBytes);
      await ctx.output("validation-results@1", results, {
        workspace: workspaceFacts(inputs.workspace),
      });
    }
    await ctx.output("workspace@1", inputs.workspace, {
      workspace: workspaceFacts(inputs.workspace),
    });
  },
  cancel: (ctx) => cancelValidation(ctx),
};

export const runValidationAndSealAction: GraphSystemActionHandler = {
  action: "run-validation-and-seal",
  async run(ctx) {
    const inputs = await validationInputs(ctx, { acceptAncestorPlan: false });
    const run = await validate(ctx, inputs);
    const configured = (await ctx.deps.storage.getRepositoryConfig(ctx.run.projectId)).prBaseBranch;
    const targetBranch =
      (typeof ctx.params.targetBranch === "string" ? ctx.params.targetBranch : undefined) ??
      (configured?.trim() || "main");
    const round = ctx.activation.iteration;
    const reference = await ctx.effect<{ reference: ReviewPackageReference }>(
      ctx.slotKey(`seal:${inputs.digest}`),
      async () => {
        const generated = await ctx.deps.invoke<unknown>("generate_review_package", {
          environmentId: inputs.environment.id,
          packageId: run.id,
          round,
          targetBranch,
          preparation: validationPreparation(run),
          expectedHead: inputs.plan.headRef,
          validationPlan: inputs.plan,
        });
        return {
          reference: parseReviewPackageReference(generated, { id: run.id, round, targetBranch }),
        };
      },
    );
    const { diffCharacters: _legacy, ...descriptor } = reference.reference;
    if (!ctx.produces("review-package@2")) return;
    const contents = await ctx.deps.shell.readFile(inputs.environment, descriptor.filePath);
    await ctx.outputFile("review-package@2", contents, descriptor, {
      extension: "json",
      workspace: { headRef: descriptor.headRef, baseRef: descriptor.baseRef },
    });
  },
  cancel: (ctx) => cancelValidation(ctx),
};

/** Stops the activation's validation run, when one is still running in the environment. */
async function cancelValidation(ctx: GraphSystemActionContext): Promise<void> {
  const effects = await ctx.deps.storage.graphEffects.listGraphEffects(ctx.run.id);
  const prefix = ctx.slotKey("validation:");
  for (const effect of effects) {
    // A job stopped mid-run leaves its effect failed; the worker may still run.
    if (!effect.key.startsWith(prefix) || effect.state === "done") continue;
    const id = effect.data?.validationRunId;
    const startedAt = effect.data?.startedAt;
    if (typeof id !== "string" || typeof startedAt !== "string") continue;
    let plan: ReviewValidationPlan;
    try {
      plan = parseReviewValidationPlan(await ctx.requireInput("validation-plan@1"));
    } catch {
      return;
    }
    await ctx.deps.invoke("cancel_review_validation", {
      environmentId: ctx.environmentId,
      run: { ...newReviewValidationRun(id, plan), startedAt },
    });
  }
}
