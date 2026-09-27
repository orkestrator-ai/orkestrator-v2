import {
  PUBLIC_API_LIMITS,
  type PublicActionName,
  type PublicExecutionState,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import type { PublicEnvironmentSummary } from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import type { ClientSession } from "../session.js";
import type { CommandContext, CommandOutcome, OptionSpec } from "../spec.js";
import { observe, ObservationStopped, signalName } from "../wait.js";

export const REQUEST_ID_OPTION: OptionSpec = {
  name: "request-id",
  kind: "string",
  valueName: "KEY",
  description:
    "Idempotency key. Reusing it returns the original operation; reusing it with a different intent conflicts. Generated and saved locally when omitted.",
};

export const TIMEOUT_OPTION: OptionSpec = {
  name: "timeout",
  kind: "duration",
  valueName: "DURATION",
  description: "How long to observe before exiting 5 (the operation keeps running). Default 10m.",
};

export const PROMPT_OPTIONS: OptionSpec[] = [
  {
    name: "prompt-file",
    kind: "string",
    valueName: "PATH",
    description: "Read the prompt from a local file.",
  },
  { name: "prompt-stdin", kind: "boolean", description: "Read the prompt from stdin." },
  {
    name: "prompt",
    kind: "string",
    valueName: "TEXT",
    description: "Inline prompt (prefer a file for long text).",
  },
];

export const DEFAULT_WAIT_MS = 10 * 60 * 1000;

export function stringOption(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError("invalid-input", `${label} is required`);
  }
  if (value.length > PUBLIC_API_LIMITS.pathMaxChars) {
    throw new CliError("input-too-large", `${label} is too long`);
  }
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CliError("invalid-input", `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function optionalBoolean(
  options: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = options[name];
  return typeof value === "boolean" ? value : undefined;
}

/** Submit a mutation and shape the common part of its outcome. */
export async function submit<T>(
  context: CommandContext,
  action: PublicActionName,
  input: Record<string, unknown>,
  options: Record<string, unknown>,
): Promise<{ session: ClientSession; result: T; receipt?: PublicReceipt; warnings?: string[] }> {
  const session = await context.session();
  const outcome = await session.mutate<T>(action, input, stringOption(options, "request-id"));
  return { session, ...outcome };
}

/** Read `run.get` for one operation; returns its receipt. */
export async function readOperation(
  session: ClientSession,
  operationId: string,
): Promise<PublicReceipt> {
  const { receipt } = await session.readWithReceipt("run.get", { operationId });
  if (!receipt) throw new CliError("response-invalid", "run.get returned no receipt");
  return receipt;
}

export function isTerminalReceipt(receipt: PublicReceipt): boolean {
  return !["admitted", "running", "unknown"].includes(receipt.state);
}

function stoppedError(
  error: ObservationStopped,
  action: string,
  receipt: PublicReceipt | undefined,
  what: string,
): CliError {
  if (error.reason === "signal") {
    return new CliError(
      "observation-interrupted",
      `Stopped observing ${what}; it continues in the backend`,
      {
        action,
        ...(receipt ? { receipt } : {}),
        details: { signal: error.signalName ?? "SIGINT" },
      },
    );
  }
  return new CliError(
    "deadline-exceeded",
    `Timed out observing ${what}; it continues in the backend`,
    {
      action,
      ...(receipt ? { receipt } : {}),
    },
  );
}

/** Map a terminal receipt to success or a structured failure. */
export function receiptFailure(receipt: PublicReceipt): CliError | undefined {
  if (receipt.state === "succeeded") return undefined;
  const message = receipt.error?.message ?? `Operation ended ${receipt.state}`;
  const code =
    receipt.state === "partial"
      ? "partial-failure"
      : receipt.state === "cancelled"
        ? "run-cancelled"
        : receipt.state === "interrupted"
          ? "run-interrupted"
          : receipt.state === "unknown"
            ? "run-unknown"
            : (receipt.error?.code ?? "operation-failed");
  return new CliError(code, message, { receipt, action: receipt.action });
}

/**
 * Observe an operation until it is terminal. Interaction-required and
 * unknown execution states return early unless the caller opts to keep
 * waiting for another client to answer.
 */
export async function waitForOperation(
  context: CommandContext,
  session: ClientSession,
  initial: PublicReceipt,
  timeoutMs: number,
  options: { continueOnInteraction?: boolean } = {},
): Promise<PublicReceipt> {
  let latest = initial;
  try {
    return await observe<PublicReceipt>(
      async () => {
        latest = await readOperation(session, initial.operationId);
        if (isTerminalReceipt(latest)) return { done: true as const, value: latest };
        const execution: PublicExecutionState | undefined = latest.execution;
        if (execution?.state === "waiting-for-input" && !options.continueOnInteraction) {
          throw new CliError(
            "interaction-required",
            "The run is waiting for an answer to a pending interaction",
            {
              receipt: latest,
              action: latest.action,
              details: { interactions: execution.interactions ?? [] },
            },
          );
        }
        if (latest.state === "unknown" && latest.dispatch?.state === "unknown") {
          throw new CliError(
            "dispatch-unknown",
            "The provider may or may not have received the prompt; use `run retry` (same key) or `run discard`",
            { receipt: latest, action: latest.action, retryable: true },
          );
        }
        if (latest.state === "unknown") {
          // The backend concluded it cannot prove the outcome; waiting longer
          // would not change that.
          throw new CliError(
            "run-unknown",
            latest.error?.message ?? "The outcome of this run is not known",
            {
              receipt: latest,
              action: latest.action,
            },
          );
        }
        if (execution?.state === "unsupported") {
          throw new CliError(
            "capability-unavailable",
            execution.reason ?? "Completion of this run cannot be observed for its provider",
            { receipt: latest, action: latest.action },
          );
        }
        return { done: false };
      },
      { timeoutMs, signal: context.signal },
    );
  } catch (error) {
    if (error instanceof ObservationStopped) {
      throw stoppedError(error, latest.action, latest, "the operation");
    }
    throw error;
  }
}

export type EnvironmentCondition = "running" | "ready" | "stopped" | "deleted";

/**
 * Wait for an environment condition caused by `receipt`'s operation. The
 * operation must first become terminal-successful, so an unrelated earlier
 * transition can never satisfy the wait; then the environment snapshot must
 * show the condition. Setup failure fails the wait with its recorded reason.
 */
export async function waitForEnvironment(
  context: CommandContext,
  session: ClientSession,
  environmentId: string,
  condition: EnvironmentCondition,
  receipt: PublicReceipt | undefined,
  timeoutMs: number,
): Promise<{ environment: PublicEnvironmentSummary | null; receipt?: PublicReceipt }> {
  let latestReceipt = receipt;
  const conditionMet = (environment: PublicEnvironmentSummary | null): boolean => {
    if (condition === "deleted") return environment === null;
    if (!environment) return false;
    if (condition === "running") return environment.status === "running";
    if (condition === "stopped") return environment.status === "stopped";
    return environment.ready;
  };
  try {
    return await observe<{ environment: PublicEnvironmentSummary | null; receipt?: PublicReceipt }>(
      async () => {
        if (latestReceipt && !isTerminalReceipt(latestReceipt)) {
          latestReceipt = await readOperation(session, latestReceipt.operationId);
        }
        if (latestReceipt && isTerminalReceipt(latestReceipt)) {
          const failure = receiptFailure(latestReceipt);
          if (failure) throw failure;
        }
        let environment: PublicEnvironmentSummary | null;
        try {
          environment = await session.read<PublicEnvironmentSummary>("environment.get", {
            environmentId,
          });
        } catch (error) {
          if (error instanceof CliError && error.code === "not-found") environment = null;
          else throw error;
        }
        if (condition !== "deleted" && !environment) {
          throw new CliError(
            "not-found",
            "The environment no longer exists",
            latestReceipt ? { receipt: latestReceipt } : {},
          );
        }
        if (environment && (condition === "ready" || condition === "running")) {
          if (environment.setup.phase === "failed" || environment.status === "error") {
            throw new CliError(
              "setup-failed",
              environment.lifecycle.error ?? "Environment setup failed",
              { ...(latestReceipt ? { receipt: latestReceipt } : {}), details: { environmentId } },
            );
          }
        }
        // A start operation stays active through setup; `running` only needs
        // it to have got past provisioning.
        const operationSettled =
          !latestReceipt ||
          isTerminalReceipt(latestReceipt) ||
          (condition === "running" && latestReceipt.stage === "setup");
        if (operationSettled && conditionMet(environment)) {
          return {
            done: true,
            value: { environment, ...(latestReceipt ? { receipt: latestReceipt } : {}) },
          };
        }
        return { done: false };
      },
      { timeoutMs, signal: context.signal },
    );
  } catch (error) {
    if (error instanceof ObservationStopped) {
      throw stoppedError(
        error,
        latestReceipt?.action ?? "environment.get",
        latestReceipt,
        `the environment (${condition})`,
      );
    }
    throw error;
  }
}

export function withConnection(
  context: CommandContext,
  outcome: CommandOutcome,
  session?: ClientSession,
): CommandOutcome {
  return session ? { ...outcome, connection: session.identity } : outcome;
}

export { signalName };
