import path from "node:path";
import process from "node:process";
import {
  defaultRunGroup,
  finalizeTestLogs,
  pruneExpiredTestLogDirectories,
  type TestGroup,
} from "./test-all";

function usage(): never {
  console.error("Usage: bun run test:logged -- --name <label> -- <command> [args...]");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
let name = "validation";
if (args[0] === "--name") {
  name = args[1]?.trim() || usage();
  args.splice(0, 2);
}
if (args[0] === "--") args.shift();
const command = args.shift();
if (!command) usage();

await pruneExpiredTestLogDirectories().catch(() => undefined);
const group: TestGroup = { name, command, args };
const startedAt = Date.now();
const result = await defaultRunGroup(group, process.env);
const elapsedMs = Date.now() - startedAt;
const status = result.status ?? 1;
const logDirectory = result.logPath ? path.dirname(result.logPath) : undefined;
const artifacts = await finalizeTestLogs(
  logDirectory,
  [{ group, result, elapsedMs }],
  status === 0,
);

console.log(`${status === 0 ? "PASS" : "FAIL"} ${name} (${(elapsedMs / 1_000).toFixed(1)}s, ${result.outputBytes ?? 0} output bytes)`);
if (status !== 0 && result.output) console.error(result.output);
if (status !== 0 && artifacts) console.error(`Failure artifacts: ${artifacts}`);
process.exitCode = status;
