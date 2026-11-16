import {
  exitCodeForError,
  PUBLIC_API_SCHEMA_VERSION,
  type PublicConnectionIdentity,
  type PublicErrorEnvelope,
  type PublicReceipt,
  type PublicNodeTag,
  type PublicSuccessEnvelope,
} from "@orkestrator/protocol/public-api";
import { CliError } from "./errors.js";
import type { ClientIo } from "./io.js";
import type { CommandOutcome, GlobalOptions } from "./spec.js";

/** `type` of the stderr record a `--wait` client writes when it starts observing. */
export const OBSERVING_RECORD_TYPE = "observing";

/**
 * The machine-readable progress record a `--wait` command writes on stderr
 * once the backend has answered its submission and it holds the operation's
 * receipt. From that line on, an interruption stops only observation and the
 * final envelope carries the receipt. Content-free: the action and operation
 * ID only, never input, prompt or result. Documented in
 * docs/architecture/public-cli.md, "Output and exit codes".
 */
export interface ObservingRecord {
  type: typeof OBSERVING_RECORD_TYPE;
  action: string;
  operationId: string;
}

/**
 * Writes {@link ObservingRecord} on stderr in `--json` and `--jsonl` modes.
 * stdout keeps its one envelope (or record stream) unchanged; human and `id`
 * output are unchanged.
 */
export function writeObservingRecord(
  io: ClientIo,
  mode: GlobalOptions["output"],
  action: string,
  operationId: string,
): void {
  if (mode !== "json" && mode !== "jsonl") return;
  const record: ObservingRecord = { type: OBSERVING_RECORD_TYPE, action, operationId };
  io.stderr(`${JSON.stringify(record)}\n`);
}

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
        ...(outcome.node ? { node: outcome.node } : {}),
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
    if (outcome.receipt) this.io.stderr(`${receiptHint(outcome.receipt, outcome.node)}\n`);
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
    const node = cliError.node ?? context.node;
    if (this.mode === "json" || this.mode === "jsonl") {
      const envelope: PublicErrorEnvelope = {
        schemaVersion: PUBLIC_API_SCHEMA_VERSION,
        action: cliError.action ?? context.action ?? "cli",
        ok: false,
        ...(context.connection ? { connection: context.connection } : {}),
        ...(node ? { node } : {}),
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
    if (typeof cliError.details?.recovery === "string")
      this.io.stderr(`recover with \`${cliError.details.recovery}\`\n`);
    if (receipt) this.io.stderr(`${receiptHint(receipt, node)}\n`);
    return exitCode;
  }

  /** Exit status after a signal stopped observation; the receipt stays usable. */
  interrupted(
    signal: "SIGINT" | "SIGTERM",
    context: {
      action: string;
      receipt?: PublicReceipt;
      connection?: PublicConnectionIdentity;
      details?: Record<string, unknown>;
      node?: PublicNodeTag;
    },
  ): number {
    const code = signal === "SIGINT" ? 130 : 143;
    const message = `Observation stopped by ${signal}; the operation continues in the backend.`;
    if (this.mode === "json" || this.mode === "jsonl") {
      this.io.stdout(
        `${JSON.stringify({
          schemaVersion: PUBLIC_API_SCHEMA_VERSION,
          action: context.action,
          ...(context.node ? { node: context.node } : {}),
          ok: false,
          ...(context.connection ? { connection: context.connection } : {}),
          error: {
            code: "observation-interrupted",
            message,
            exitCode: code,
            details: { ...context.details, signal },
          },
          ...(context.receipt ? { receipt: context.receipt } : {}),
        })}\n`,
      );
      return code;
    }
    this.io.stderr(`${message}\n`);
    if (context.receipt) this.io.stderr(`${receiptHint(context.receipt, context.node)}\n`);
    return code;
  }
}

export function receiptHint(receipt: PublicReceipt, node?: PublicNodeTag): string {
  return `operation ${receipt.operationId} (${receipt.action}) is ${receipt.state}; inspect with \`orkestrator run get ${receipt.operationId}${node ? ` --node ${node.nodeId}` : ""}\``;
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
