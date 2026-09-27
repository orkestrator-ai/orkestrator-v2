import path from "node:path";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import type { PublicExecOutputWindow } from "@orkestrator/protocol/public-api-resources";
import { requireEnvironment } from "./actions-discovery.js";
import { loadOperation } from "./actions-runs.js";
import { assertReadyForAgents } from "./actions-sessions.js";
import { boundedMessage, PublicActionError } from "./errors.js";
import {
  control,
  ENV_KEY,
  execDirectory,
  executionFromState,
  workspaceRoot,
  type ExecState,
} from "./exec-control.js";
import {
  invalid,
  oneOf,
  onlyKeys,
  optionalInteger,
  optionalString,
  requiredId,
  requiredString,
} from "./input.js";
import type { PublicOperationRecord } from "./operation-ledger.js";
import { registerReconciler } from "./reconciler.js";
import type {
  MutationActionHandler,
  OperationPatch,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * `environment.exec`: one argv-preserving, non-PTY command in the selected
 * environment's workspace, supervised by an environment-side worker that
 * outlives both the CLI and the backend. The result is the process's own exit
 * status, persisted by the worker before completion is reported — never a
 * terminal marker or scraped output. Nothing is ever re-run automatically.
 */

const inFlight = new Map<string, Promise<OperationPatch | null>>();

async function reconcileExec(
  record: PublicOperationRecord,
  context: PublicActionContext,
): Promise<OperationPatch | null> {
  const existing = inFlight.get(record.operationId);
  if (existing) return existing;
  const evaluation = (async (): Promise<OperationPatch | null> => {
    const environment = record.resources.environmentId
      ? await context.command.storage.getEnvironment(record.resources.environmentId)
      : null;
    if (!environment) {
      return {
        state: "interrupted",
        execution: {
          state: "interrupted",
          evidence: "none",
          reason: "The environment was deleted",
        },
        error: {
          code: "run-interrupted",
          message: "The environment was deleted while the command ran",
        },
      };
    }
    // The request that is starting the worker owns it until the start returns.
    if (
      (record.stage === "admitted" || record.stage === "starting") &&
      record.generation === context.generation
    ) {
      return null;
    }
    let state: ExecState;
    try {
      state = (await control(environment, context.command, {
        action: "status",
        operationId: record.operationId,
        directory: execDirectory(environment, record.operationId, context.command),
      })) as ExecState;
    } catch {
      if (environment.status !== "running") {
        return {
          state: "interrupted",
          execution: {
            state: "interrupted",
            evidence: "none",
            reason: "The environment stopped; the command's outcome is unknown",
          },
          error: {
            code: "run-interrupted",
            message: "The environment stopped while the command ran",
          },
        };
      }
      return null;
    }
    const { patch } = executionFromState(state);
    if (!patch.state && JSON.stringify(patch.execution) === JSON.stringify(record.execution))
      return null;
    return patch;
  })().finally(() => inFlight.delete(record.operationId));
  inFlight.set(record.operationId, evaluation);
  return evaluation;
}

registerReconciler("environment.exec", reconcileExec);

interface ExecInput {
  environmentId: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdinBase64?: string;
  timeoutMs: number;
}

const environmentExec: MutationActionHandler<ExecInput> = {
  kind: "mutation",
  action: "environment.exec",
  parse(input) {
    onlyKeys(input, ["environmentId", "argv", "cwd", "env", "stdinBase64", "timeoutMs"]);
    const environmentId = requiredId(input, "environmentId");
    const argv = input.argv;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.length > PUBLIC_API_LIMITS.execArgvMaxItems ||
      !argv.every((arg) => typeof arg === "string" && !arg.includes("\0"))
    ) {
      throw invalid("argv must be a non-empty array of strings");
    }
    if (Buffer.byteLength(JSON.stringify(argv)) > PUBLIC_API_LIMITS.execArgvMaxBytes) {
      throw new PublicActionError("input-too-large", "argv is too large");
    }
    if (!(argv[0] as string).trim()) throw invalid("argv[0] must name a program");
    const rawCwd = optionalString(input, "cwd", 1024) ?? ".";
    const cwd = path.posix.normalize(rawCwd);
    if (cwd.startsWith("/") || cwd === ".." || cwd.startsWith("../")) {
      throw invalid("cwd must be relative to the workspace and stay inside it");
    }
    const env: Record<string, string> = {};
    if (input.env !== undefined) {
      if (!input.env || typeof input.env !== "object" || Array.isArray(input.env))
        throw invalid("env must be an object");
      const entries = Object.entries(input.env as Record<string, unknown>);
      if (entries.length > PUBLIC_API_LIMITS.execEnvMaxEntries)
        throw new PublicActionError("input-too-large", "Too many env entries");
      for (const [key, value] of entries) {
        if (
          !ENV_KEY.test(key) ||
          key.startsWith("ORKESTRATOR_") ||
          typeof value !== "string" ||
          value.includes("\0") ||
          value.length > 32_768
        ) {
          throw invalid("env entries must be NAME=value strings (ORKESTRATOR_* is reserved)");
        }
        env[key] = value;
      }
    }
    const stdinBase64 = optionalString(
      input,
      "stdinBase64",
      Math.ceil((PUBLIC_API_LIMITS.execStdinMaxBytes * 4) / 3) + 4,
    );
    if (stdinBase64 !== undefined && !/^[A-Za-z0-9+/]*={0,2}$/.test(stdinBase64))
      throw invalid("stdinBase64 is not base64");
    const timeoutMs =
      optionalInteger(input, "timeoutMs", 1_000, PUBLIC_API_LIMITS.execTimeoutMaxMs) ??
      PUBLIC_API_LIMITS.execTimeoutDefaultMs;
    const value: ExecInput = {
      environmentId,
      argv: argv as string[],
      cwd,
      env,
      ...(stdinBase64 ? { stdinBase64 } : {}),
      timeoutMs,
    };
    return { value, scope: `environment:${environmentId}`, intent: value };
  },
  async prepare(input, context) {
    const environment = await requireEnvironment(context, input.environmentId);
    assertReadyForAgents(environment);
    const root = workspaceRoot(environment);
    const active = (await context.command.storage.listActivePublicOperations()).filter(
      (record) =>
        record.action === "environment.exec" && record.resources.environmentId === environment.id,
    );
    if (active.length >= PUBLIC_API_LIMITS.execConcurrencyPerEnvironment) {
      throw new PublicActionError(
        "busy",
        `At most ${PUBLIC_API_LIMITS.execConcurrencyPerEnvironment} commands may run per environment`,
        {
          retryable: true,
        },
      );
    }
    return {
      resources: { environmentId: environment.id, projectId: environment.projectId },
      async execute(operation) {
        const directory = execDirectory(environment, operation.operationId, context.command);
        await operation.update({ stage: "starting" });
        let state: ExecState;
        try {
          state = (await control(environment, context.command, {
            action: "start",
            operationId: operation.operationId,
            directory,
            root,
            argv: input.argv,
            cwd: input.cwd === "." ? root : path.posix.join(root, input.cwd),
            env: input.env,
            ...(input.stdinBase64 ? { stdinBase64: input.stdinBase64 } : {}),
            timeoutMs: input.timeoutMs,
            maxOutputBytes: PUBLIC_API_LIMITS.execOutputMaxBytes,
          })) as ExecState;
        } catch (error) {
          // The control may have claimed and started the worker before its
          // response was lost; never start a second one. Reconcile instead.
          return {
            state: "running",
            stage: "executing",
            result: { operationId: operation.operationId, launch: "unconfirmed" },
            execution: { state: "pending", reason: boundedMessage(error) },
          };
        }
        const { patch, terminal } = executionFromState(state);
        if (terminal) {
          const outcomeState = patch.state as "succeeded" | "failed" | "cancelled" | "interrupted";
          if (outcomeState === "succeeded") {
            return {
              state: "succeeded",
              stage: "completed",
              result: { operationId: operation.operationId },
              execution: patch.execution,
            };
          }
          return {
            state: outcomeState === "interrupted" ? "failed" : outcomeState,
            stage: "completed",
            result: { operationId: operation.operationId },
            ...(patch.execution ? { execution: patch.execution } : {}),
            error: patch.error ?? { code: "exec-failed", message: "The command failed" },
          };
        }
        return {
          state: "running",
          stage: "executing",
          result: { operationId: operation.operationId },
          execution: patch.execution ?? { state: "running" },
        };
      },
    };
  },
};

async function execTarget(context: PublicActionContext, operationId: string) {
  const record = await loadOperation(context, operationId);
  if (record.action !== "environment.exec") {
    throw new PublicActionError(
      "unsupported",
      "Only environment.exec operations have a worker to cancel or read",
    );
  }
  const environment = record.resources.environmentId
    ? await context.command.storage.getEnvironment(record.resources.environmentId)
    : null;
  return { record, environment };
}

const runCancel: MutationActionHandler<{ operationId: string }> = {
  kind: "mutation",
  action: "run.cancel",
  parse(input) {
    onlyKeys(input, ["operationId"]);
    const operationId = requiredString(input, "operationId", 100);
    return { value: { operationId }, scope: `operation:${operationId}`, intent: {} };
  },
  async prepare(input, context) {
    const { record, environment } = await execTarget(context, input.operationId);
    if (!["admitted", "running", "unknown"].includes(record.state)) {
      throw new PublicActionError("conflict", `The command already finished (${record.state})`);
    }
    if (!environment)
      throw new PublicActionError("not-found", "The command's environment no longer exists");
    return {
      resources: { environmentId: environment.id },
      async execute(operation) {
        await operation.update({ stage: "cancelling" });
        const state = (await control(environment, context.command, {
          action: "cancel",
          operationId: record.operationId,
          directory: execDirectory(environment, record.operationId, context.command),
        })) as ExecState;
        const { patch, terminal } = executionFromState(state);
        if (terminal) {
          await context.command.storage.updatePublicOperation(record.operationId, (current) =>
            ["admitted", "running", "unknown"].includes(current.state)
              ? { ...current, ...patch, completedAt: new Date(context.now()).toISOString() }
              : null,
          );
          return {
            state: "succeeded",
            result: { operationId: record.operationId, outcome: patch.state ?? "finished" },
          };
        }
        // Unknown cancellation is not success.
        return {
          state: "unknown",
          error: {
            code: "run-unknown",
            message: "Cancellation was requested but the command has not stopped yet",
          },
          result: { operationId: record.operationId },
        };
      },
    };
  },
};

const runOutput: ReadActionHandler<{
  operationId: string;
  stream: "stdout" | "stderr";
  offset?: number;
  tailBytes?: number;
  maxBytes: number;
}> = {
  kind: "read",
  action: "run.output",
  parse(input) {
    onlyKeys(input, ["operationId", "stream", "offset", "tailBytes", "maxBytes"]);
    const offset = optionalInteger(input, "offset", 0, Number.MAX_SAFE_INTEGER);
    const tailBytes = optionalInteger(
      input,
      "tailBytes",
      1,
      PUBLIC_API_LIMITS.execOutputPageMaxBytes,
    );
    if (offset !== undefined && tailBytes !== undefined)
      throw invalid("offset and tailBytes are mutually exclusive");
    return {
      operationId: requiredString(input, "operationId", 100),
      stream: oneOf(input, "stream", ["stdout", "stderr"] as const) ?? "stdout",
      ...(offset !== undefined ? { offset } : {}),
      ...(tailBytes !== undefined ? { tailBytes } : {}),
      maxBytes:
        optionalInteger(input, "maxBytes", 1, PUBLIC_API_LIMITS.execOutputPageMaxBytes) ??
        PUBLIC_API_LIMITS.execOutputPageMaxBytes,
    };
  },
  async run(input, context) {
    const { record, environment } = await execTarget(context, input.operationId);
    if (!environment)
      throw new PublicActionError("not-found", "The command's environment no longer exists");
    const response = (await control(environment, context.command, {
      action: "output",
      operationId: record.operationId,
      directory: execDirectory(environment, record.operationId, context.command),
      stream: input.stream,
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.tailBytes !== undefined ? { tailBytes: input.tailBytes } : {}),
      maxBytes: input.maxBytes,
    })) as { state?: ExecState; window?: { base64: string; offset: number; totalBytes: number } };
    if (!response.window)
      throw new PublicActionError("not-found", "The command's output is no longer available");
    const bytes = Buffer.from(response.window.base64, "base64");
    const result: PublicExecOutputWindow = {
      stream: input.stream,
      text: bytes.toString("utf8"),
      base64: response.window.base64,
      offset: response.window.offset,
      totalBytes: response.window.totalBytes,
      truncatedHead: response.window.offset > 0,
      complete:
        response.state?.status === "exited" &&
        response.window.offset + bytes.byteLength >= response.window.totalBytes,
    };
    return { result };
  },
};

export const EXEC_HANDLERS: PublicActionHandler[] = [environmentExec, runCancel, runOutput];
