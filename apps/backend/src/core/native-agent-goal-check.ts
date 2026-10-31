import { createHash } from "node:crypto";
import path from "node:path";
import { boundedUtf8Tail, NATIVE_AGENT_GOAL_LIMITS } from "@orkestrator/protocol/native-agent-goal";
import type { CommandContext } from "./commands-context.js";
import { quoteShell } from "./commands-agent-support.js";
import { withContainerRuntimeCredential } from "./container-scripts.js";
import type { Environment } from "./models.js";
import type { GoalCheckRun } from "./native-agent-goal-service.js";
import {
  control,
  execDirectory,
  workspaceRoot,
  type ExecState,
} from "./public-api/exec-control.js";
import { runCommand } from "./shell.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CHECK_POLL_MS = 1_000;
const CHECK_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

/** Stable across backend generations; a goal's next iteration gets a new worker. */
export function goalCheckOperationId(goalId: string, iteration: number): string {
  return `goal-check-${createHash("sha256")
    .update(JSON.stringify([goalId, iteration]))
    .digest("hex")}`;
}

/**
 * Run a goal's check once, on the worker behind `environment.exec`: it limits
 * output, kills descendants at the timeout and behaves the same on a host
 * worktree and in a container. The check is one shell string the user typed, so
 * it runs under `bash -lc`, as their own login shell would.
 */
export async function runGoalCheck(
  environment: Environment,
  context: CommandContext,
  input: {
    goalId: string;
    iteration: number;
    command: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<GoalCheckRun> {
  // A restarted backend adopts the existing worker instead of starting a twin.
  const operationId = goalCheckOperationId(input.goalId, input.iteration);
  const directory = execDirectory(environment, operationId, context);
  const startedAt = Date.now();
  let root: string;
  try {
    root = workspaceRoot(environment);
  } catch (error) {
    return { kind: "unavailable", detail: errorMessage(error) };
  }
  let state: ExecState | undefined;
  try {
    if (input.signal?.aborted) return { kind: "stopped" };
    try {
      state = await context.runtime.environments.enqueueLifecycleOperation(
        environment.id,
        context.environmentLifecycleTasks,
        async () => {
          if (input.signal?.aborted) throw new Error("The check was stopped before launch.");
          const current = await context.storage.getEnvironment(environment.id);
          if (!current || current.status !== "running")
            throw new Error("The check's environment is not running.");
          environment = current;
          root = workspaceRoot(current);
          return (await control(environment, context, {
            action: "start",
            operationId,
            environmentId: environment.id,
            directory,
            root,
            argv: ["bash", "-lc", input.command],
            cwd: root,
            env: {},
            timeoutMs: input.timeoutMs,
            maxOutputBytes: CHECK_OUTPUT_LIMIT_BYTES,
          })) as ExecState;
        },
      );
    } catch (error) {
      return { kind: "unavailable", detail: errorMessage(error) };
    }
    const deadline = startedAt + input.timeoutMs + 60_000;
    while (state.status === "starting" || state.status === "running") {
      if (input.signal?.aborted) return { kind: "stopped" };
      if (Date.now() > deadline) {
        return { kind: "unavailable", detail: "The check did not report a result." };
      }
      await sleep(CHECK_POLL_MS, input.signal);
      if (input.signal?.aborted) return { kind: "stopped" };
      try {
        state = (await control(environment, context, {
          action: "status",
          operationId,
          directory,
        })) as ExecState;
      } catch (error) {
        return { kind: "unavailable", detail: errorMessage(error) };
      }
    }
    if (state.status !== "exited") {
      return { kind: "unavailable", detail: "The check's worker stopped reporting." };
    }
    if (state.cancelled)
      return {
        kind: "unavailable",
        detail: "The check was cancelled because its environment is stopping or changing.",
      };
    if (state.spawnError) return { kind: "unavailable", detail: state.spawnError };
    const output = await readTail(environment, context, operationId, directory);
    return {
      kind: "finished",
      exitCode: state.exitCode ?? null,
      timedOut: state.timedOut === true,
      durationMs: Date.now() - startedAt,
      outputTail: output,
    };
  } finally {
    // Cancellation is explicit: shutdown and lifecycle drains never leave a
    // detached check modifying a workspace. Unknown workers retain evidence.
    try {
      if (!state || state.status === "starting" || state.status === "running") {
        state = (await control(environment, context, {
          action: "cancel",
          operationId,
          directory,
        })) as ExecState;
      }
      if (state.status === "exited")
        await control(environment, context, { action: "cleanup", operationId, directory });
    } catch {
      // Retain the durable directory for recovery and lifecycle drains.
    }
  }
}

async function readTail(
  environment: Environment,
  context: CommandContext,
  operationId: string,
  directory: string,
): Promise<string> {
  const limit = NATIVE_AGENT_GOAL_LIMITS.checkOutputMaxBytes;
  const parts: string[] = [];
  for (const stream of ["stdout", "stderr"] as const) {
    try {
      const response = (await control(environment, context, {
        action: "output",
        operationId,
        directory,
        stream,
        tailBytes: limit,
        maxBytes: limit,
      })) as { window?: { base64: string } };
      const text = response.window
        ? Buffer.from(response.window.base64, "base64").toString("utf8")
        : "";
      if (text) parts.push(text);
    } catch {
      // The exit status is the verdict; missing output only makes it less useful.
    }
  }
  return boundedUtf8Tail(parts.join("\n"), limit);
}

/**
 * A digest of the workspace's commit, status and diff. `undefined` when it is
 * not a git checkout, which the no-progress stop reads as "cannot say".
 */
export async function goalWorkspaceFingerprint(
  environment: Environment,
): Promise<string | undefined> {
  const script =
    'set -eo pipefail; git rev-parse --git-dir >/dev/null; { git rev-parse HEAD; git status --porcelain=v1 --untracked-files=all; git diff HEAD; git ls-files --others --exclude-standard -z | while IFS= read -r -d "" file; do printf "%s\\0" "$file"; if [ -L "$file" ]; then readlink "$file" | git hash-object --stdin; else git hash-object --no-filters -- "$file"; fi; done; } 2>/dev/null | git hash-object --stdin';
  const root = workspaceRoot(environment);
  try {
    const { stdout } =
      environment.environmentType === "local"
        ? await runCommand("bash", ["-c", script], {
            cwd: path.resolve(root),
            timeoutMs: 30_000,
          })
        : await runCommand(
            "docker",
            [
              "exec",
              "--workdir",
              root,
              environment.containerId!,
              "bash",
              "-lc",
              withContainerRuntimeCredential(["bash", "-c", script].map(quoteShell).join(" ")),
            ],
            { timeoutMs: 30_000 },
          );
    const digest = stdout.trim();
    return digest.length > 0 ? digest : undefined;
  } catch {
    return undefined;
  }
}
