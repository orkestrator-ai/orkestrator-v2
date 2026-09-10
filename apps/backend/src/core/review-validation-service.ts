import { withContainerRuntimeCredential } from "./commands-runtime-state.js";
import {
  isReviewValidationRun,
  newReviewValidationRun,
  REVIEW_VALIDATION_OUTPUT_MAX_BYTES,
  type ReviewValidationOutput,
  type ReviewValidationOutputStream,
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

/**
 * Reads a bounded tail from the environment-owned evidence files. The script
 * derives both filenames from the authoritative worker state; renderer-provided
 * paths never cross this boundary.
 */
const REVIEW_VALIDATION_OUTPUT_READER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString());
const root = fs.realpathSync(input.root);
const directory = path.join(root, ".orkestrator", "review-artifacts", input.runId);
let current = root;
for (const part of path.relative(root, directory).split(path.sep)) {
  current = path.join(current, part);
  const info = fs.lstatSync(current);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(current) !== current) {
    throw new Error("Validation artifact directory is not confined");
  }
}
const statePath = path.join(directory, "state.json");
const stateInfo = fs.lstatSync(statePath);
if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.size > 1024 * 1024) {
  throw new Error("Invalid validation state file");
}
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (!state.run || state.run.id !== input.runId || !Array.isArray(state.run.results)) {
  throw new Error("Validation identity changed");
}
const index = state.run.results.findIndex(result => result && result.id === input.resultId);
if (index < 0) throw new Error("Validation command is unavailable");
const result = state.run.results[index];
const ordinal = String(index + 1).padStart(2, "0");
function readStream(name) {
  const relative = result[name + "Path"];
  if (relative === null || relative === undefined) return null;
  const expected = path.relative(root, path.join(directory, "validation-" + ordinal + "." + name + ".txt")).split(path.sep).join("/");
  if (relative !== expected) throw new Error("Validation artifact identity changed");
  const target = path.join(root, relative);
  if (fs.realpathSync(target) !== target) throw new Error("Validation artifact is not confined");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Invalid validation artifact");
    const length = Math.min(info.size, input.maxBytes);
    const startOffset = info.size - length;
    const content = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, content, offset, length - offset, startOffset + offset);
      if (read === 0) break;
      offset += read;
    }
    return { contentBase64: content.subarray(0, offset).toString("base64"), totalBytes: info.size, startOffset };
  } finally { fs.closeSync(fd); }
}
process.stdout.write(JSON.stringify({
  resultId: result.id,
  status: result.status,
  stdout: readStream("stdout"),
  stderr: readStream("stderr"),
}));
`;

function validationIdentity(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

/** Authoritative, bounded output snapshot used by the validation log modal. */
export async function readReviewValidationOutput(
  environmentId: string,
  runIdValue: string,
  resultIdValue: string,
  context: CommandContext,
): Promise<ReviewValidationOutput> {
  const runId = validationIdentity(runIdValue, "review validation run ID");
  const resultId = validationIdentity(resultIdValue, "review validation result ID");
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error("Review validation environment is unavailable");
  const root = environment.environmentType === "local" ? environment.worktreePath : "/workspace";
  if (!root) throw new Error("Review validation workspace is unavailable");
  if (environment.environmentType !== "local" && !environment.containerId) {
    throw new Error("Review validation container is unavailable");
  }
  const payload = Buffer.from(
    JSON.stringify({ root, runId, resultId, maxBytes: REVIEW_VALIDATION_OUTPUT_MAX_BYTES }),
  ).toString("base64");
  const args = ["-e", REVIEW_VALIDATION_OUTPUT_READER, payload];
  const { stdout } =
    environment.environmentType === "local"
      ? await runCommand(resolveBunBinary(context), args, {
          cwd: "/",
          timeoutMs: 20_000,
          redactValues: [payload, REVIEW_VALIDATION_OUTPUT_READER],
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
            redactValues: [payload, REVIEW_VALIDATION_OUTPUT_READER],
          },
        );
  const parsed: unknown = JSON.parse(stdout);
  const validStream = (stream: unknown): stream is ReviewValidationOutputStream | null => {
    if (stream === null) return true;
    if (!stream || typeof stream !== "object" || Array.isArray(stream)) return false;
    const candidate = stream as Record<string, unknown>;
    if (
      typeof candidate.contentBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        candidate.contentBase64,
      ) ||
      !Number.isSafeInteger(candidate.totalBytes) ||
      (candidate.totalBytes as number) < 0 ||
      !Number.isSafeInteger(candidate.startOffset) ||
      (candidate.startOffset as number) < 0 ||
      (candidate.startOffset as number) > (candidate.totalBytes as number)
    ) {
      return false;
    }
    const decodedBytes = Buffer.from(candidate.contentBase64, "base64").byteLength;
    return (
      decodedBytes <= REVIEW_VALIDATION_OUTPUT_MAX_BYTES &&
      (candidate.startOffset as number) + decodedBytes <= (candidate.totalBytes as number)
    );
  };
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("resultId" in parsed) ||
    !("status" in parsed) ||
    !("stdout" in parsed) ||
    !("stderr" in parsed) ||
    typeof parsed.resultId !== "string" ||
    typeof parsed.status !== "string" ||
    parsed.resultId !== resultId ||
    !["pending", "queued", "running", "passed", "failed", "skipped", "incomplete"].includes(
      parsed.status,
    ) ||
    !validStream(parsed.stdout) ||
    !validStream(parsed.stderr)
  ) {
    throw new Error("Review validation returned invalid output");
  }
  return parsed as ReviewValidationOutput;
}

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
      if (
        r.status !== "passed" &&
        r.status !== "failed" &&
        r.status !== "skipped" &&
        r.status !== "incomplete"
      )
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
