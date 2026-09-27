import {
  exitCodeForError,
  PUBLIC_API_SCHEMA_VERSION,
  type PublicConnectionIdentity,
  type PublicErrorEnvelope,
  type PublicReceipt,
  type PublicSuccessEnvelope,
} from "@orkestrator/protocol/public-api";
import { CliError } from "./errors.js";
import type { ClientIo } from "./io.js";
import type { CommandOutcome, GlobalOptions } from "./spec.js";

/**
 * Renders results for the selected output mode.
 *
 * - `json`: exactly one envelope on stdout, success or failure.
 * - `id`: only the documented ID(s) on stdout on success; nothing on failure.
 * - `jsonl`: records were already streamed; the final envelope is one more line.
 * - `human`: free-form text on stdout, errors on stderr. May change between releases.
 */
export class OutputWriter {
  constructor(
    private readonly io: ClientIo,
    private readonly mode: GlobalOptions["output"],
  ) {}

  /** One JSONL record while following. */
  record(value: unknown): void {
    this.io.stdout(`${JSON.stringify(value)}\n`);
  }

  /** Progress and hints; always stderr, suppressed in machine modes except errors. */
  note(message: string): void {
    if (this.mode === "human") this.io.stderr(`${message}\n`);
  }

  success(outcome: CommandOutcome): number {
    if (outcome.failure) return this.failure(outcome.failure, outcome);
    if (this.mode === "json" || this.mode === "jsonl") {
      const envelope: PublicSuccessEnvelope = {
        schemaVersion: PUBLIC_API_SCHEMA_VERSION,
        action: outcome.action,
        ok: true,
        ...(outcome.connection ? { connection: outcome.connection } : {}),
        result: outcome.result ?? null,
        ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
        ...(outcome.warnings && outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      };
      this.io.stdout(`${JSON.stringify(envelope)}\n`);
      return outcome.exitCodeOverride ?? 0;
    }
    if (this.mode === "id") {
      for (const id of outcome.ids ?? []) this.io.stdout(`${id}\n`);
      for (const warning of outcome.warnings ?? []) this.io.stderr(`warning: ${warning}\n`);
      return outcome.exitCodeOverride ?? 0;
    }
    for (const line of outcome.human ?? defaultHuman(outcome.result)) this.io.stdout(`${line}\n`);
    for (const warning of outcome.warnings ?? []) this.io.stderr(`warning: ${warning}\n`);
    if (outcome.receipt) this.io.stderr(`${receiptHint(outcome.receipt)}\n`);
    return outcome.exitCodeOverride ?? 0;
  }

  failure(error: unknown, context: Partial<CommandOutcome> = {}): number {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError(
            "internal-error",
            error instanceof Error ? boundMessage(error.message) : "Unexpected client failure",
          );
    const exitCode = exitCodeForError(cliError.code);
    const receipt = cliError.receipt ?? context.receipt;
    if (this.mode === "json" || this.mode === "jsonl") {
      const envelope: PublicErrorEnvelope = {
        schemaVersion: PUBLIC_API_SCHEMA_VERSION,
        action: cliError.action ?? context.action ?? "cli",
        ok: false,
        ...(context.connection ? { connection: context.connection } : {}),
        error: {
          code: cliError.code,
          message: cliError.message,
          exitCode,
          ...(cliError.retryable !== undefined ? { retryable: cliError.retryable } : {}),
          ...(cliError.details ? { details: cliError.details } : {}),
        },
        ...(receipt ? { receipt } : {}),
      };
      this.io.stdout(`${JSON.stringify(envelope)}\n`);
      return exitCode;
    }
    this.io.stderr(`error [${cliError.code}]: ${cliError.message}\n`);
    if (receipt) this.io.stderr(`${receiptHint(receipt)}\n`);
    return exitCode;
  }

  /** Exit status after a signal stopped observation; the receipt stays usable. */
  interrupted(
    signal: "SIGINT" | "SIGTERM",
    context: { action: string; receipt?: PublicReceipt; connection?: PublicConnectionIdentity },
  ): number {
    const code = signal === "SIGINT" ? 130 : 143;
    const message = `Observation stopped by ${signal}; the operation continues in the backend.`;
    if (this.mode === "json" || this.mode === "jsonl") {
      this.io.stdout(
        `${JSON.stringify({
          schemaVersion: PUBLIC_API_SCHEMA_VERSION,
          action: context.action,
          ok: false,
          ...(context.connection ? { connection: context.connection } : {}),
          error: { code: "observation-interrupted", message, exitCode: code, details: { signal } },
          ...(context.receipt ? { receipt: context.receipt } : {}),
        })}\n`,
      );
      return code;
    }
    this.io.stderr(`${message}\n`);
    if (context.receipt) this.io.stderr(`${receiptHint(context.receipt)}\n`);
    return code;
  }
}

export function receiptHint(receipt: PublicReceipt): string {
  return `operation ${receipt.operationId} (${receipt.action}) is ${receipt.state}; inspect with \`orkestrator run get ${receipt.operationId}\``;
}

export function boundMessage(message: string, max = 500): string {
  const single = message.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function defaultHuman(result: unknown): string[] {
  if (result === null || result === undefined) return ["ok"];
  if (typeof result !== "object") return [String(result)];
  return JSON.stringify(result, null, 2).split("\n");
}
