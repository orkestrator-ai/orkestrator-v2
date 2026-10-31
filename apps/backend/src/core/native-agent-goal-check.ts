import { randomUUID } from "node:crypto";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  input: { goalId: string; command: string; timeoutMs: number },
): Promise<GoalCheckRun> {
  const operationId = `goal-check-${input.goalId}-${randomUUID()}`;
  const directory = execDirectory(environment, operationId, context);
  const startedAt = Date.now();
  let root: string;
  try {
    root = workspaceRoot(environment);
  } catch (error) {
    return { kind: "unavailable", detail: errorMessage(error) };
  }
  let state: ExecState;
  try {
    state = (await control(environment, context, {
      action: "start",
      operationId,
      directory,
      root,
      argv: ["bash", "-lc", input.command],
      cwd: root,
      env: {},
      timeoutMs: input.timeoutMs,
      maxOutputBytes: CHECK_OUTPUT_LIMIT_BYTES,
    })) as ExecState;
  } catch (error) {
    return { kind: "unavailable", detail: errorMessage(error) };
  }
  const deadline = startedAt + input.timeoutMs + 60_000;
  while (state.status === "starting" || state.status === "running") {
    if (Date.now() > deadline) {
      return { kind: "unavailable", detail: "The check did not report a result." };
    }
    await sleep(CHECK_POLL_MS);
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
  if (state.spawnError) return { kind: "unavailable", detail: state.spawnError };
  const output = await readTail(environment, context, operationId, directory);
  return {
    kind: "finished",
    exitCode: state.exitCode ?? null,
    timedOut: state.timedOut === true,
    durationMs: Date.now() - startedAt,
    outputTail: output,
  };
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
    "{ git rev-parse HEAD; git status --porcelain=v1 --untracked-files=all; git diff HEAD; } 2>/dev/null | git hash-object --stdin";
  const root = workspaceRoot(environment);
  try {
    const { stdout } =
      environment.environmentType === "local"
        ? await runCommand("bash", ["-c", `git rev-parse --git-dir >/dev/null && ${script}`], {
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
              withContainerRuntimeCredential(
                ["bash", "-c", `git rev-parse --git-dir >/dev/null && ${script}`]
                  .map(quoteShell)
                  .join(" "),
              ),
            ],
            { timeoutMs: 30_000 },
          );
    const digest = stdout.trim();
    return digest.length > 0 ? digest : undefined;
  } catch {
    return undefined;
  }
}
