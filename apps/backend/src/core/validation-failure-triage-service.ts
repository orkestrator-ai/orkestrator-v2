/**
 * Runs the failure classifier against a sealed validation run, inside the
 * environment that ran it, and adds the evidence only the backend holds:
 * failures other pipelines recorded on the same merge-base.
 *
 * The triage is evidence for review, never a gate on producing the package:
 * any failure here becomes a package limitation and the package is sealed
 * without it, exactly as before triage existed. Nothing here runs a test.
 * See `@orkestrator/protocol/validation-failure-triage`.
 */
import { parseGitHubRepositoryRemote } from "@orkestrator/protocol/github-repository";
import { isReviewPackageReference } from "@orkestrator/protocol/review-workflow";
import {
  failuresSharedOnBase,
  isValidationFailureSummary,
  isValidationFailureTriage,
  validationFailureId,
  type ValidationFailureSummary,
  type ValidationFailureTriage,
} from "@orkestrator/protocol/validation-failure-triage";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { CommandContext } from "./commands-context.js";
import type { EnvironmentCommandRunner } from "./commands-review.js";
import { quoteShell, resolveBunBinary } from "./commands-agent-support.js";
import { withContainerRuntimeCredential } from "./container-scripts.js";
import { gitHubCli } from "./github-cli-binary.js";
import { gitHubCliEnv } from "./github-credentials.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";
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
  /** `origin/<target branch>`. */
  targetRef: string;
  changedFiles: string[];
  commands: ValidationFailureClassifierCommand[];
  /** Replaces the environment exec, for tests. */
  execute?: (script: string, payload: string, env: NodeJS.ProcessEnv) => Promise<string>;
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
        await runner("git", ["merge-base", "HEAD", options.targetRef], 30_000)
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
      ci: repository ? { repository, gh: local ? gitHubCli() : "gh" } : null,
      budgetMs: CLASSIFIER_BUDGET_MS,
    });
    const env = local ? await gitHubCliEnv(context.storage).catch(() => process.env) : process.env;
    const execute =
      options.execute ??
      ((script, data, environmentVariables) =>
        executeInEnvironment(environment, context, script, data, environmentVariables));
    const stdout = await execute(VALIDATION_FAILURE_CLASSIFIER_SCRIPT, payload, env);
    const parsed: unknown = JSON.parse(stdout);
    if (!isValidationFailureTriage(parsed)) {
      return {
        limitation: "Failure triage was skipped: the classifier returned an invalid result",
      };
    }
    const triage = applySharedBaseEvidence(
      parsed,
      await sharedFailureSummaries(context, environment).catch(() => []),
    );
    return { triage };
  } catch (error) {
    log.warn("failure-triage.failed", {
      environmentId: environment.id,
      error: formatLogError(error),
    });
    return { limitation: "Failure triage was skipped: the classifier could not run" };
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
