import type {
  PublicActionName,
  PublicConnectionIdentity,
  PublicReceipt,
} from "@orkestrator/protocol/public-api";
import type { CliConfigStore } from "./config.js";
import type { ClientIo } from "./io.js";
import type { ClientSession } from "./session.js";

export type OptionKind = "string" | "boolean" | "integer" | "duration" | "list";

export interface OptionSpec {
  /** Long name without dashes, e.g. `project`. */
  name: string;
  kind: OptionKind;
  description: string;
  valueName?: string;
  /** Accept `--no-<name>` as an explicit false. Only for booleans. */
  negatable?: boolean;
  short?: string;
}

export interface PositionalSpec {
  name: string;
  required: boolean;
  description?: string;
  /** Consumes every remaining positional. */
  variadic?: boolean;
}

export interface ParsedCommand {
  spec: CommandSpec;
  positionals: Record<string, string | string[] | undefined>;
  options: Record<string, unknown>;
  /** Arguments after `--`, only for commands that accept them. */
  rest: string[];
}

/** What a command produced; the output layer renders it for the chosen mode. */
export interface CommandOutcome {
  action: string;
  result: unknown;
  receipt?: PublicReceipt;
  warnings?: string[];
  connection?: PublicConnectionIdentity;
  /** Printed alone in `--output id` mode; lists print one per line. */
  ids?: string[];
  /** Human-readable lines for the default mode. */
  human?: string[];
  /** Non-zero exit for a completed-but-unsuccessful observation. */
  failure?: import("./errors.js").CliError;
  /**
   * Explicit child exit-code passthrough (`environment exec --exit-code`).
   * The envelope still reports `ok: true`, which is how a script tells a
   * child's status apart from a client failure.
   */
  exitCodeOverride?: number;
}

export interface CommandContext {
  io: ClientIo;
  global: GlobalOptions;
  /** Lazily connects to the selected backend. */
  session(): Promise<ClientSession>;
  /** Abort signal fired by SIGINT/SIGTERM. */
  signal: AbortSignal;
  version: string;
  configStore: CliConfigStore;
}

export interface GlobalOptions {
  connection?: string;
  profile?: string;
  /** `--node`: a leaf node ID, or `all` for an aggregate read. */
  node?: string;
  output: "human" | "json" | "id" | "jsonl";
  help: boolean;
  version: boolean;
  requestTimeoutMs?: number;
}

export interface CommandSpec {
  path: string[];
  /**
   * The public action this command runs. Declarative only: `run()` still
   * builds the request. `command-actions.test.ts` checks every action has a
   * command, and Control MCP's `describe_action` names the first one.
   */
  action?: PublicActionName;
  /**
   * Options and positionals whose names are not the camelCase of the action
   * input property they fill, mapped to that property; `null` marks one that
   * never reaches the input (an observer or output switch).
   */
  inputFields?: Readonly<Record<string, string | null>>;
  summary: string;
  description?: string;
  positionals: PositionalSpec[];
  options: OptionSpec[];
  /** Accepts `-- <argv…>`. */
  acceptsRest?: boolean;
  /** Does not contact a backend (help, version, local connection edits). */
  local?: boolean;
  /** Supports `--output id`. */
  idOutput?: string;
  /** Supports `--jsonl` following output. */
  jsonl?: boolean;
  examples?: string[];
  run(context: CommandContext, parsed: ParsedCommand): Promise<CommandOutcome>;
}

/**
 * Flag and positional names every command uses for the same input property.
 * A command's own `inputFields` take precedence.
 */
export const SHARED_INPUT_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  project: "projectId",
  environment: "environmentId",
  session: "sessionId",
  operation: "operationId",
  interaction: "interactionId",
  "prompt-file": "prompt",
  "prompt-stdin": "prompt",
  "text-file": "text",
  "text-stdin": "text",
  "patch-file": "set",
  "patch-stdin": "set",
  fast: "fastMode",
  network: "networkAccessMode",
  "expect-run": "expectedOperationId",
});
