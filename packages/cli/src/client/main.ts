import { PUBLIC_API_SCHEMA_VERSION } from "@orkestrator/protocol/public-api";
import {
  findCommand,
  isCommandGroup,
  parseInvocation,
  sniffOutputMode,
  type CommandTree,
} from "./argv.js";
import { connectionCommands } from "./commands/connection.js";
import { environmentCommands } from "./commands/environment.js";
import { projectCommands } from "./commands/project.js";
import { runCommands } from "./commands/run.js";
import { sessionCommands } from "./commands/session.js";
import { CliConfigStore, defaultCliConfigDir } from "./config.js";
import { CliError } from "./errors.js";
import { helpFor, SERVE_HELP } from "./help.js";
import type { ClientIo } from "./io.js";
import { OutputWriter } from "./output.js";
import { LocalReceiptStore } from "./receipts.js";
import { ClientSession } from "./session.js";
import type { CommandContext, CommandOutcome, CommandSpec, GlobalOptions } from "./spec.js";
import { resolveTarget } from "./targets.js";
import type { FetchLike } from "./transport.js";
import { signalName } from "./wait.js";

export const CLIENT_COMMANDS: readonly CommandSpec[] = [
  ...connectionCommands,
  ...projectCommands,
  ...environmentCommands,
  ...sessionCommands,
  ...runCommands,
];

export const COMMAND_TREE: CommandTree = { commands: CLIENT_COMMANDS };

export interface RunClientOptions {
  io: ClientIo;
  version: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

function stripHelpWord(argv: readonly string[]): { argv: string[]; help: boolean } {
  const index = argv.findIndex((token) => !token.startsWith("-"));
  if (index >= 0 && argv[index] === "help") {
    return { argv: [...argv.slice(0, index), ...argv.slice(index + 1), "--help"], help: true };
  }
  return { argv: [...argv], help: false };
}

/**
 * Run one client command. Returns the process exit code; never throws.
 * Nothing here starts, stops, or initializes a backend.
 */
export async function runClient(
  argv: readonly string[],
  options: RunClientOptions,
): Promise<number> {
  const { io } = options;
  const signal = options.signal ?? new AbortController().signal;
  const writer = new OutputWriter(io, sniffOutputMode(argv));
  const stripped = stripHelpWord(argv);
  const firstWord = stripped.argv.find((token) => !token.startsWith("-"));
  if (firstWord === "serve" && stripped.help) {
    return writer.success({ action: "help", result: { help: SERVE_HELP }, human: [SERVE_HELP] });
  }
  if (
    firstWord === "version" &&
    stripped.argv.filter((token) => !token.startsWith("-")).length === 1
  ) {
    return writer.success({
      action: "version",
      result: { version: options.version, schemaVersion: PUBLIC_API_SCHEMA_VERSION },
      human: [`orkestrator ${options.version}`],
    });
  }

  let parsed: ReturnType<typeof parseInvocation>;
  try {
    parsed = parseInvocation(COMMAND_TREE, stripped.argv);
  } catch (error) {
    return writer.failure(error, { action: "cli" });
  }
  const output = new OutputWriter(io, parsed.global.output);
  if (parsed.global.version) {
    return output.success({
      action: "version",
      result: { version: options.version, schemaVersion: PUBLIC_API_SCHEMA_VERSION },
      human: [`orkestrator ${options.version}`],
    });
  }
  if (parsed.global.help || !parsed.command) {
    const text = helpFor(COMMAND_TREE, parsed.path);
    if (parsed.global.help) {
      return output.success({ action: "help", result: { help: text }, human: [text] });
    }
    io.stderr(`${text}\n`);
    return output.failure(
      new CliError(
        "unknown-command",
        parsed.path.length > 0 && isCommandGroup(COMMAND_TREE, parsed.path)
          ? "A subcommand is required"
          : "A command is required",
      ),
      { action: "cli" },
    );
  }

  const command = parsed.command;
  const action = command.spec.path.join(".");
  const configStore = new CliConfigStore(defaultCliConfigDir(io.env));
  let session: ClientSession | null = null;
  const context: CommandContext = {
    io,
    global: parsed.global,
    signal,
    version: options.version,
    configStore,
    async session() {
      if (session) return session;
      const target = await resolveTarget(
        { connection: parsed.global.connection, profile: parsed.global.profile },
        configStore,
        io.env,
      );
      session = new ClientSession(target, new LocalReceiptStore(configStore.receiptsDirectory), {
        fetchImpl: options.fetchImpl,
        requestTimeoutMs: parsed.global.requestTimeoutMs,
        signal,
      });
      return session;
    },
  };
  if (command.spec.local && (parsed.global.connection || parsed.global.profile)) {
    if (!(command.spec.path[0] === "connection" && command.spec.path[1] === "check")) {
      return output.failure(
        new CliError(
          "invalid-input",
          `'${command.spec.path.join(" ")}' does not use --connection or --profile`,
        ),
        { action },
      );
    }
  }

  let outcome: CommandOutcome;
  try {
    outcome = await command.spec.run(context, command);
  } catch (error) {
    const connection = session ? (session as ClientSession).identity : undefined;
    if (
      signal.aborted &&
      !(error instanceof CliError && error.code === "observation-interrupted")
    ) {
      return output.interrupted(signalName(signal), {
        action,
        ...(error instanceof CliError && error.receipt ? { receipt: error.receipt } : {}),
        ...(connection ? { connection } : {}),
      });
    }
    if (error instanceof CliError && error.code === "observation-interrupted") {
      return output.interrupted(signalName(signal), {
        action: error.action ?? action,
        ...(error.receipt ? { receipt: error.receipt } : {}),
        ...(connection ? { connection } : {}),
      });
    }
    return output.failure(error, { action, ...(connection ? { connection } : {}) });
  }
  return output.success(outcome);
}

/** Bind the real process streams and signals. */
export async function runClientProcess(argv: readonly string[], version: string): Promise<number> {
  const controller = new AbortController();
  const onSignal = (name: NodeJS.Signals) => {
    if (controller.signal.aborted) {
      // A second signal means "stop now"; transports are already released.
      process.exit(name === "SIGINT" ? 130 : 143);
    }
    controller.abort(name);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const io: ClientIo = {
    stdout: (text) => process.stdout.write(text),
    stdoutBytes: (bytes) => process.stdout.write(Buffer.from(bytes)),
    stderr: (text) => process.stderr.write(text),
    readStdin: async (maxBytes) => {
      const { readStreamBounded } = await import("./io.js");
      return readStreamBounded(
        Bun.stdin.stream(),
        maxBytes,
        () => new CliError("input-too-large", `stdin is larger than ${maxBytes} bytes`),
      );
    },
    env: process.env,
    cwd: process.cwd(),
    now: () => Date.now(),
    stdinIsTty: Boolean(process.stdin.isTTY),
  };
  try {
    return await runClient(argv, { io, version, signal: controller.signal });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export { findCommand };
export type { GlobalOptions };
