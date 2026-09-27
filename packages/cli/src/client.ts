/**
 * Entry bundle for the published `orkestrator` launcher (bin/orkestrator.js).
 *
 * It decides — before the backend is ever imported — whether an invocation
 * runs the foreground service or a client command. Client commands, help and
 * version never import `dist/main.js`, never create a data directory, and
 * never start a listener, bridge, or backend child.
 */
import {
  isServerFlag,
  SERVER_BOOLEAN_FLAGS,
  SERVER_VALUE_FLAGS,
  validateServerArguments,
} from "../../../apps/backend/src/server-flags.js";
import { GLOBAL_OPTIONS } from "./client/argv.js";
import { COMMAND_TREE, runClient, runClientProcess } from "./client/main.js";

export type Invocation =
  | { mode: "serve"; args: string[] }
  | { mode: "client"; argv: string[] }
  | { mode: "error"; message: string };

const CLIENT_WORDS = new Set([
  ...COMMAND_TREE.commands.map((command) => command.path[0]!),
  "help",
  "version",
]);
const CLIENT_FLAGS = new Set(
  GLOBAL_OPTIONS.flatMap((option) => [
    `--${option.name}`,
    ...(option.short ? [`-${option.short}`] : []),
  ]),
);
const CLIENT_VALUE_FLAGS = new Set(
  GLOBAL_OPTIONS.filter((option) => option.kind !== "boolean").map((option) => `--${option.name}`),
);
const SAFE_WORD = /^[a-z][a-z0-9-]{0,39}$/;

function flagName(token: string): string {
  const equals = token.indexOf("=");
  return equals < 0 ? token : token.slice(0, equals);
}

export function classifyInvocation(argv: readonly string[]): Invocation {
  if (argv.length === 0) return { mode: "serve", args: [] };
  const first = argv[0]!;
  if (first === "serve") {
    const rest = argv.slice(1);
    if (rest.includes("--help") || rest.includes("-h"))
      return { mode: "client", argv: ["help", "serve"] };
    const error = validateServerArguments(rest);
    return error ? { mode: "error", message: error } : { mode: "serve", args: rest };
  }
  if (first.startsWith("-")) {
    // The first real word decides: option values (of service flags or of
    // client global options) are skipped, so `--json connection add NAME
    // --data-dir DIR` is a client command even though `--data-dir` is also a
    // service flag.
    let firstWord: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index]!;
      if (token === "--") break;
      if (token.startsWith("-")) {
        const name = flagName(token);
        if (
          !token.includes("=") &&
          (SERVER_VALUE_FLAGS.includes(name) || CLIENT_VALUE_FLAGS.has(name))
        )
          index += 1;
        continue;
      }
      firstWord = token;
      break;
    }
    if (firstWord !== undefined && CLIENT_WORDS.has(firstWord))
      return { mode: "client", argv: [...argv] };
    const serverError = validateServerArguments(argv);
    if (serverError === null) return { mode: "serve", args: [...argv] };
    const tokens = argv.filter((token) => token.startsWith("-")).map(flagName);
    const hasServer = tokens.some(isServerFlag);
    const hasClient = tokens.some((token) => CLIENT_FLAGS.has(token));
    if (hasServer && hasClient) {
      return {
        mode: "error",
        message:
          "Service options cannot be combined with client options; use `orkestrator serve …` or a client command",
      };
    }
    if (hasClient && firstWord === undefined) return { mode: "client", argv: [...argv] };
    return { mode: "error", message: serverError };
  }
  if (CLIENT_WORDS.has(first)) return { mode: "client", argv: [...argv] };
  return {
    mode: "error",
    message: `Unknown command ${SAFE_WORD.test(first) ? `'${first}'` : "argument"}; run \`orkestrator help\``,
  };
}

export { runClient, runClientProcess, SERVER_BOOLEAN_FLAGS, SERVER_VALUE_FLAGS };

/** Render a launcher-level classification error in the requested mode. */
export function renderInvocationError(argv: readonly string[], message: string): number {
  const json = argv.includes("--json") || argv.includes("--output=json");
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        action: "cli",
        ok: false,
        error: { code: "invalid-input", message, exitCode: 2 },
      })}\n`,
    );
  } else {
    process.stderr.write(`error [invalid-input]: ${message}\n`);
  }
  return 2;
}
