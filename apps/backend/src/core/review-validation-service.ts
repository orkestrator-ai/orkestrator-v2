import { withContainerRuntimeCredential } from "./commands-runtime-state.js";
import {
  isReviewValidationRun,
  newReviewValidationRun,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import type { CommandContext } from "./commands-context.js";
import {
  createEnvironmentCommandRunner,
  ensureReviewPackageIsGitExcluded,
} from "./commands-review.js";
import { quoteShell, resolveBunBinary } from "./commands-agent-support.js";
import { runCommand } from "./commands-dependencies.js";
import { REVIEW_VALIDATION_CONTROL, REVIEW_VALIDATION_WORKER } from "./review-validation-worker.js";
import type { ReviewPreparationResult } from "./looped-review-prompts.js";

/** All requests are short control operations; command execution lives in the environment. */
export async function controlReviewValidation(
  environmentId: string,
  value: unknown,
  action: "start" | "status" | "cancel",
  context: CommandContext,
): Promise<ReviewValidationRun> {
  if (!isReviewValidationRun(value)) throw new Error("Invalid review validation run");
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error("Review validation environment is unavailable");
  if (action === "start" && (environment.status !== "running" || environment.deletionRequestedAt))
    throw new Error("Review validation requires a running environment");
  const runner = createEnvironmentCommandRunner(environment);
  if (action === "start")
    await ensureReviewPackageIsGitExcluded(
      environment,
      runner,
      `.orkestrator/review-artifacts/${value.id}/state.json`,
    );
  const root = environment.environmentType === "local" ? environment.worktreePath : "/workspace";
  if (!root) throw new Error("Review validation workspace is unavailable");
  // Compact transport only: neither command output nor file contents return here.
  const payload = Buffer.from(
    JSON.stringify({
      root,
      run: { ...newReviewValidationRun(value.id, value.plan), startedAt: value.startedAt },
      action,
    }),
  ).toString("base64");
  const args = ["-e", REVIEW_VALIDATION_CONTROL, payload, REVIEW_VALIDATION_WORKER];
  const { stdout } =
    environment.environmentType === "local"
      ? await runCommand(resolveBunBinary(context), args, {
          cwd: "/",
          timeoutMs: 20_000,
          redactValues: [payload, REVIEW_VALIDATION_CONTROL, REVIEW_VALIDATION_WORKER],
        })
      : await runCommand(
          "docker",
          [
            "exec",
            "--workdir",
            "/",
            environment.containerId!,
            "bash",
            "-lc",
            withContainerRuntimeCredential(["bun", ...args].map(quoteShell).join(" ")),
          ],
          {
            timeoutMs: 20_000,
            redactValues: [payload, REVIEW_VALIDATION_CONTROL, REVIEW_VALIDATION_WORKER],
          },
        );
  const next: unknown = JSON.parse(stdout);
  if (
    !isReviewValidationRun(next) ||
    next.id !== value.id ||
    JSON.stringify(next.plan) !== JSON.stringify(value.plan)
  ) {
    throw new Error("Review validation returned an invalid or mismatched snapshot");
  }
  return {
    ...next,
    ...(value.discoveryDurationMs === undefined
      ? {}
      : { discoveryDurationMs: value.discoveryDurationMs }),
  };
}

export function validationPreparation(run: ReviewValidationRun): ReviewPreparationResult {
  if (run.status !== "completed")
    throw new Error(run.error ?? "Review validation has not completed");
  return {
    validation: run.results.map((r) => {
      if (r.status !== "passed" && r.status !== "failed" && r.status !== "skipped")
        throw new Error("Validation command is unsettled");
      return {
        command: `cd ${quoteShell(run.plan.commands.find((cmd) => cmd.id === r.id)!.cwd)} && ${r.command}`,
        status: r.status,
        exitCode: r.exitCode,
        stdoutPath: r.stdoutPath,
        stderrPath: r.stderrPath,
        durationMs: r.durationMs,
        limitation: r.limitation,
        stdoutSha256: r.stdoutSha256,
        stderrSha256: r.stderrSha256,
      };
    }),
    uncommittedFiles: [],
    limitations: run.plan.limitations,
  };
}

/** Explicit environment stop/delete drains workers before removing their workspace. */
export async function stopEnvironmentReviewValidation(
  environmentId: string,
  context: CommandContext,
): Promise<void> {
  const [reviews, pipelines] = await Promise.all([
    context.storage.listMultiReviewWorkflows(environmentId),
    context.storage.listAllBuildPipelines(),
  ]);
  for (const record of [...reviews, ...pipelines]) {
    if (
      record.environmentId !== environmentId ||
      !record.snapshot ||
      typeof record.snapshot !== "object"
    )
      continue;
    const snapshot = record.snapshot as { validationRun?: unknown };
    if (!isReviewValidationRun(snapshot.validationRun)) continue;
    if (!["planned", "running"].includes(snapshot.validationRun.status)) continue;
    await controlReviewValidation(environmentId, snapshot.validationRun, "cancel", context);
  }
}
