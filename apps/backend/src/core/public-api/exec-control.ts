import path from "node:path";
import type { PublicExecutionState } from "@orkestrator/protocol/public-api";
import type { CommandContext } from "../commands-context.js";
import { quoteShell, resolveBunBinary } from "../commands-agent-support.js";
import { runCommand } from "../commands-dependencies.js";
import { withContainerRuntimeCredential } from "../commands-runtime-state.js";
import type { Environment } from "../models.js";
import { boundedMessage, PublicActionError } from "./errors.js";
import { EXEC_CONTROL, EXEC_WORKER } from "./exec-worker.js";
import type { OperationPatch } from "./types.js";

/**
 * Control primitives for environment exec workers, kept free of the action
 * layer so environment stop/delete/recreate can drain workers without an
 * import cycle.
 */

export const CONTAINER_EXEC_ROOT = "/tmp/orkestrator-exec";
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface ExecState {
  operationId?: string;
  status: "starting" | "running" | "exited" | "lost" | "missing";
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  outputLimited?: boolean;
  cancelled?: boolean;
  descendantsKilled?: boolean;
  spawnError?: string | null;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
}

export function workspaceRoot(environment: Environment): string {
  if (environment.environmentType === "local") {
    if (!environment.worktreePath)
      throw new PublicActionError("not-ready", "The environment has no workspace yet");
    return environment.worktreePath;
  }
  if (!environment.containerId)
    throw new PublicActionError("not-ready", "The environment has no container");
  return "/workspace";
}

export function execDirectory(
  environment: Environment,
  operationId: string,
  context: CommandContext,
): string {
  return environment.environmentType === "local"
    ? path.join(context.storage.getDataDir(), "exec-runs", operationId)
    : path.posix.join(CONTAINER_EXEC_ROOT, operationId);
}

export async function control(
  environment: Environment,
  context: CommandContext,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const args = ["-e", EXEC_CONTROL, encoded, EXEC_WORKER];
  // Arguments, environment values and stdin travel only in the payload,
  // which is redacted from any error; routine logs never see them.
  const redactValues = [encoded, EXEC_CONTROL, EXEC_WORKER];
  const { stdout } =
    environment.environmentType === "local"
      ? await runCommand(resolveBunBinary(context), args, {
          cwd: "/",
          timeoutMs: 30_000,
          redactValues,
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
          { timeoutMs: 30_000, redactValues },
        );
  return JSON.parse(stdout);
}

export function executionFromState(state: ExecState): { patch: OperationPatch; terminal: boolean } {
  const base: PublicExecutionState = {
    state: "running",
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
  };
  if (state.status === "starting" || state.status === "running") {
    return { patch: { execution: base, stage: "executing" }, terminal: false };
  }
  if (state.status === "lost" || state.status === "missing") {
    return {
      patch: {
        state: "interrupted",
        stage: "completed",
        execution: {
          ...base,
          state: "interrupted",
          evidence: "none",
          reason:
            "The command's worker stopped reporting; its outcome is unknown and it will not be re-run",
        },
        error: {
          code: "run-interrupted",
          message: "The command's worker was lost; it will not be re-run",
        },
      },
      terminal: true,
    };
  }
  const execution: PublicExecutionState = {
    ...base,
    evidence: "process-exit",
    exitCode: state.exitCode ?? null,
    signal: state.signal ?? null,
    timedOut: state.timedOut === true,
    outputLimited: state.outputLimited === true,
  };
  if (state.cancelled) {
    return {
      patch: {
        state: "cancelled",
        stage: "completed",
        execution: { ...execution, state: "cancelled", reason: "Cancelled by request" },
        error: { code: "run-cancelled", message: "The command was cancelled" },
      },
      terminal: true,
    };
  }
  const reason = state.spawnError
    ? `The command could not start (${state.spawnError})`
    : state.timedOut
      ? "The command exceeded its execution timeout"
      : state.outputLimited
        ? "The command exceeded the output limit"
        : state.exitCode === 0
          ? undefined
          : state.signal
            ? `The command was terminated by ${state.signal}`
            : `The command exited with ${state.exitCode}`;
  if (!reason && state.exitCode === 0) {
    return {
      patch: {
        state: "succeeded",
        stage: "completed",
        execution: { ...execution, state: "completed" },
      },
      terminal: true,
    };
  }
  return {
    patch: {
      state: "failed",
      stage: "completed",
      execution: { ...execution, state: "failed", reason },
      error: { code: "exec-failed", message: reason ?? "The command failed" },
    },
    terminal: true,
  };
}

/**
 * Stop/delete drain: cancel this environment's active command workers
 * before its workspace or container is changed, so no command keeps
 * modifying a directory that is about to disappear.
 */
export async function stopEnvironmentExecWorkers(
  environmentId: string,
  context: CommandContext,
): Promise<void> {
  // Partial storage adapters (compatibility fixtures) have no operation store.
  if (typeof context.storage.listActivePublicOperations !== "function") return;
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) return;
  let active: Awaited<ReturnType<typeof context.storage.listActivePublicOperations>>;
  try {
    active = (await context.storage.listActivePublicOperations()).filter(
      (record) =>
        record.action === "environment.exec" && record.resources.environmentId === environmentId,
    );
  } catch (error) {
    // Never block a stop/delete on the receipt store; workers still die with
    // their workspace and reconcile as interrupted.
    console.warn(`[public-api] Could not list exec workers: ${boundedMessage(error)}`);
    return;
  }
  for (const record of active) {
    try {
      const state = (await control(environment, context, {
        action: "cancel",
        operationId: record.operationId,
        directory: execDirectory(environment, record.operationId, context),
      })) as ExecState;
      const { patch, terminal } = executionFromState(state);
      if (!terminal) continue;
      await context.storage.updatePublicOperation(record.operationId, (current) =>
        ["admitted", "running", "unknown"].includes(current.state)
          ? { ...current, ...patch, completedAt: new Date().toISOString() }
          : null,
      );
    } catch (error) {
      console.warn(
        `[public-api] Could not cancel exec ${record.operationId}: ${boundedMessage(error)}`,
      );
    }
  }
}
