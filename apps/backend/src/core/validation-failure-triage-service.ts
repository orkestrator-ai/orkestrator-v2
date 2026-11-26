/**
 * Runs the failure classifier against a sealed validation run, inside the
 * environment that ran it, and adds the evidence only the backend holds:
 * failures other pipelines recorded on the same merge-base, and a bounded
 * rerun of the failing Bun test files on a throwaway checkout of the merge
 * base (`validation-merge-base-rerun.ts`).
 *
 * The triage is evidence for review, never a gate on producing the package:
 * any failure here becomes a package limitation and the package is sealed
 * without it, exactly as before triage existed. The reviewed worktree is
 * never touched. See `@orkestrator/protocol/validation-failure-triage`.
 */
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createHostTestScheduler } from "@orkestrator/protocol/node/host-test-scheduler";
import { parseGitHubRepositoryRemote } from "@orkestrator/protocol/github-repository";
import { isReviewPackageReference } from "@orkestrator/protocol/review-workflow";
import {
  failuresSharedOnBase,
  MAX_TRIAGE_LIMITATIONS,
  isValidationFailureSummary,
  isValidationFailureTriage,
  validationFailureId,
  type TriagedValidationFailure,
  type ValidationFailureSummary,
  type ValidationFailureTriage,
} from "@orkestrator/protocol/validation-failure-triage";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { CommandContext, EnvironmentCommandRunner } from "./commands/index.js";
import { quoteShell, resolveBunBinary } from "./commands/agent-support.js";
import { withContainerRuntimeCredential } from "./containers/index.js";
import { environmentIsolationVariables, withEnvironmentIsolation } from "./environments/index.js";
import { gitHubCli, gitHubCliEnv } from "./git/index.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";
import { mergeBaseRerunExec, type MergeBaseRerunExec } from "./validation-merge-base-process.js";
import { rerunFailuresOnMergeBase, needsMergeBaseRerun } from "./validation-merge-base-rerun.js";
import {
  VALIDATION_FAILURE_CLASSIFIER_SCRIPT,
  type ValidationFailureClassifierCommand,
  type ValidationFailureClassifierInput,
} from "./validation-failure-classifier.js";

const log = createLogger("review");

/**
 * The base64 input travels as one argument of `bash -lc` inside a container,
 * where Linux caps a single argument at 128 KiB alongside the script itself.
 */
export const MAX_TRIAGE_PAYLOAD_BASE64_BYTES = 48_000;
const CLASSIFIER_BUDGET_MS = 45_000;
const CLASSIFIER_TIMEOUT_MS = 90_000;

export interface ValidationFailureTriageOutcome {
  triage?: ValidationFailureTriage;
  /** Why no triage was produced, for the package's limitations. */
  limitation?: string;
}

export interface TriageValidationFailuresOptions {
  environment: Environment;
  runner: EnvironmentCommandRunner;
  context: CommandContext;
  /** Immutable comparison used to generate the review diff. */
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  resources?: string[];
  commands: ValidationFailureClassifierCommand[];
  /** Replaces the environment exec, for tests. */
  execute?: (script: string, payload: string, env: NodeJS.ProcessEnv) => Promise<string>;
  /**
   * Replaces the merge-base rerun's exec, for tests. `false` skips the rerun
   * (its unit tests drive it directly).
   */
  mergeBaseExec?: MergeBaseRerunExec | false;
}

const BASELINE_QUEUE_TIMEOUT_MS = 30_000;

type BaselineScheduler = Pick<
  ReturnType<typeof createHostTestScheduler>,
  "capacity" | "enqueue" | "poll" | "release"
>;

export async function withMergeBaseAdmission<T>(
  scheduler: BaselineScheduler,
  owner: string,
  run: () => Promise<T>,
  queueTimeoutMs = BASELINE_QUEUE_TIMEOUT_MS,
  resources: string[] = [],
): Promise<T | undefined> {
  const capacity = scheduler.capacity();
  const ticket = scheduler.enqueue({
    owner,
    workers: 1,
    memoryMiB: Math.min(2_048, capacity.memoryMiB),
    resources,
  });
  const deadline = performance.now() + queueTimeoutMs;
  try {
    while (performance.now() < deadline) {
      if (scheduler.poll(ticket).state === "running") return await run();
      await Bun.sleep(Math.min(100, Math.max(0, deadline - performance.now())));
    }
  } finally {
    scheduler.release(ticket);
  }
}

/** A new, unique directory outside the reviewed worktree. */
function mergeBaseCheckoutDir(environment: Pick<Environment, "environmentType">): string {
  const name = `orkestrator-merge-base-${randomUUID()}`;
  return environment.environmentType === "local"
    ? path.join(os.tmpdir(), name)
    : path.posix.join("/tmp", name);
}

/**
 * Builds the classifier input, cutting the changed-file list when it would
 * not fit the transport. The classifier then stops calling anything
 * unrelated on import evidence alone (`changedFilesTruncated`).
 */
export function classifierPayload(input: ValidationFailureClassifierInput): string {
  const encode = (value: ValidationFailureClassifierInput) =>
    Buffer.from(JSON.stringify(value)).toString("base64");
  let payload = encode(input);
  if (payload.length <= MAX_TRIAGE_PAYLOAD_BASE64_BYTES) return payload;
  const kept: string[] = [];
  const base = encode({ ...input, changedFiles: [], changedFilesTruncated: true }).length;
  let size = base;
  for (const file of input.changedFiles) {
    // JSON string plus comma, base64-expanded.
    const cost = Math.ceil(((JSON.stringify(file).length + 1) * 4) / 3);
    if (size + cost > MAX_TRIAGE_PAYLOAD_BASE64_BYTES) break;
    kept.push(file);
    size += cost;
  }
  payload = encode({ ...input, changedFiles: kept, changedFilesTruncated: true });
  if (payload.length > MAX_TRIAGE_PAYLOAD_BASE64_BYTES) {
    throw new Error("Failure triage input does not fit the environment transport");
  }
  return payload;
}

/** Summaries other pipelines in the project recorded, from their current and archived runs. */
export async function sharedFailureSummaries(
  context: Pick<CommandContext, "storage">,
  environment: Pick<Environment, "id" | "projectId">,
): Promise<ValidationFailureSummary[]> {
  const summaries: ValidationFailureSummary[] = [];
  for (const record of await context.storage.listAllBuildPipelines()) {
    if (record.environmentId === environment.id || record.projectId !== environment.projectId) {
      continue;
    }
    const snapshot = record.snapshot as
      { reviewPackage?: unknown; validationHistory?: Array<{ failures?: unknown }> } | undefined;
    if (!snapshot || typeof snapshot !== "object") continue;
    if (
      isReviewPackageReference(snapshot.reviewPackage) &&
      isValidationFailureSummary(snapshot.reviewPackage.failureSummary)
    ) {
      summaries.push(snapshot.reviewPackage.failureSummary);
    }
    for (const entry of Array.isArray(snapshot.validationHistory)
      ? snapshot.validationHistory
      : []) {
      if (isValidationFailureSummary(entry?.failures)) summaries.push(entry.failures);
    }
  }
  return summaries;
}

/** Marks failures another pipeline on the same merge-base also recorded as unrelated. */
export function applySharedBaseEvidence(
  triage: ValidationFailureTriage,
  summaries: Iterable<ValidationFailureSummary>,
): ValidationFailureTriage {
  if (!triage.mergeBase) return triage;
  const shared = failuresSharedOnBase(triage.mergeBase, summaries);
  if (shared.size === 0) return triage;
  return {
    ...triage,
    commands: triage.commands.map((command) => ({
      ...command,
      failures: command.failures.map((failure) =>
        failure.verdict !== "undetermined" || !shared.has(validationFailureId(failure.key))
          ? failure
          : {
              ...failure,
              verdict: "unrelated" as const,
              reasons: [...failure.reasons, "failed-on-same-base" as const],
            },
      ),
    })),
  };
}

async function gitHubRepository(
  context: Pick<CommandContext, "storage">,
  environment: Pick<Environment, "projectId">,
): Promise<string | null> {
  const project = await context.storage.getProject(environment.projectId);
  if (!project) return null;
  const parsed = parseGitHubRepositoryRemote(project.gitUrl);
  return parsed.ok ? `${parsed.repository.owner}/${parsed.repository.name}` : null;
}

export async function triageValidationFailures(
  options: TriageValidationFailuresOptions,
): Promise<ValidationFailureTriageOutcome> {
  const { environment, runner, context, commands } = options;
  if (commands.length === 0) return {};
  try {
    const root = environment.environmentType === "local" ? environment.worktreePath : "/workspace";
    if (!root) return { limitation: "Failure triage was skipped: the workspace is unavailable" };
    let mergeBase: string | null = null;
    try {
      const output = (
        await runner("git", ["merge-base", options.headRef, options.baseRef], 30_000)
      ).trim();
      mergeBase = /^[a-f0-9]{40}$/.test(output) ? output : null;
    } catch {
      mergeBase = null;
    }
    const repository = await gitHubRepository(context, environment).catch(() => null);
    const local = environment.environmentType === "local";
    const payload = classifierPayload({
      root,
      commands,
      changedFiles: options.changedFiles,
      mergeBase,
      ci: repository
        ? { repository, gh: local ? gitHubCli(context.runtime.gitHubCli) : "gh" }
        : null,
      budgetMs: CLASSIFIER_BUDGET_MS,
      includeBaselineFingerprints: true,
    });
    const env = local ? await gitHubCliEnv(context.storage).catch(() => process.env) : process.env;
    const execute =
      options.execute ??
      ((script, data, environmentVariables) =>
        executeInEnvironment(environment, context, script, data, environmentVariables));
    const stdout = await execute(VALIDATION_FAILURE_CLASSIFIER_SCRIPT, payload, env);
    const parsed: unknown = JSON.parse(stdout);
    const result = parsed as { triage?: unknown; fingerprints?: unknown };
    const report = result?.triage ?? parsed;
    if (!isValidationFailureTriage(report) || report.mergeBase !== mergeBase) {
      return {
        limitation: "Failure triage was skipped: the classifier returned an invalid result",
      };
    }
    const rows = result?.fingerprints;
    const fingerprints = new Map<TriagedValidationFailure, string>();
    if (Array.isArray(rows)) {
      report.commands.forEach((command, commandIndex) => {
        const row: unknown = rows[commandIndex];
        if (!Array.isArray(row)) return;
        command.failures.forEach((failure, index) => {
          const digest: unknown = row[index];
          if (typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)) {
            fingerprints.set(failure, digest);
          }
        });
      });
    }
    const shared = applySharedBaseEvidence(
      report,
      await sharedFailureSummaries(context, environment).catch(() => []),
    );
    return { triage: await runMergeBaseTriage(options, shared, fingerprints) };
  } catch (error) {
    log.warn("failure-triage.failed", {
      environmentId: environment.id,
      error: formatLogError(error),
    });
    return { limitation: "Failure triage was skipped: the classifier could not run" };
  }
}

async function runMergeBaseTriage(
  options: TriageValidationFailuresOptions,
  triage: ValidationFailureTriage,
  fingerprints: ReadonlyMap<TriagedValidationFailure, string>,
): Promise<ValidationFailureTriage> {
  const { environment, runner, context, changedFiles, mergeBaseExec } = options;
  if (mergeBaseExec === false || !needsMergeBaseRerun(triage, changedFiles)) return triage;
  const checkoutDir = mergeBaseCheckoutDir(environment);
  const run = (exec: MergeBaseRerunExec) =>
    rerunFailuresOnMergeBase({ triage, changedFiles, fingerprints, exec, checkoutDir });
  if (mergeBaseExec) return run(mergeBaseExec);
  const unavailable = (reason: string): ValidationFailureTriage => ({
    ...triage,
    limitations: [...triage.limitations.slice(0, MAX_TRIAGE_LIMITATIONS - 1), reason],
  });
  try {
    const scheduler = createHostTestScheduler();
    try {
      const owner =
        environment.environmentType === "local"
          ? scheduler.owner(environment.worktreePath!)
          : createHash("sha256").update(environment.id).digest("hex");
      const resources = scheduler.resources(owner, ["workspace:*", ...(options.resources ?? [])]);
      return (
        (await withMergeBaseAdmission(
          scheduler,
          owner,
          async () => {
            if (environment.environmentType !== "local") return run(mergeBaseRerunExec(runner));
            const id = randomUUID();
            const reservation =
              await context.storage.environmentIsolation.reserveTemporaryPortBase(id);
            if (!reservation)
              return unavailable("The merge-base rerun could not reserve isolated local ports");
            try {
              return await run(
                mergeBaseRerunExec(runner, {
                  bun: resolveBunBinary(context),
                  env: withEnvironmentIsolation(
                    process.env,
                    environmentIsolationVariables(id, reservation.base),
                  ),
                }),
              );
            } finally {
              reservation.release();
            }
          },
          BASELINE_QUEUE_TIMEOUT_MS,
          resources,
        )) ?? unavailable("The merge-base rerun timed out waiting for host validation capacity")
      );
    } finally {
      scheduler.close();
    }
  } catch {
    return unavailable(
      "The merge-base rerun could not acquire validation capacity or local isolation",
    );
  }
}

async function executeInEnvironment(
  environment: Environment,
  context: CommandContext,
  script: string,
  payload: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const args = ["-e", script, payload];
  if (environment.environmentType === "local") {
    const { stdout } = await runCommand(resolveBunBinary(context), args, {
      cwd: "/",
      env,
      timeoutMs: CLASSIFIER_TIMEOUT_MS,
      redactValues: [payload, script],
    });
    return stdout;
  }
  if (!environment.containerId) throw new Error("Review validation container is unavailable");
  const { stdout } = await runCommand(
    "docker",
    [
      "exec",
      "--workdir",
      "/",
      environment.containerId,
      "bash",
      "-lc",
      withContainerRuntimeCredential(["bun", ...args].map(quoteShell).join(" ")),
    ],
    { timeoutMs: CLASSIFIER_TIMEOUT_MS, redactValues: [payload, script] },
  );
  return stdout;
}
