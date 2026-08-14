import process from "node:process";
import { parseDevArguments } from "./dev/arguments.js";
import { startDevelopment } from "./dev/lifecycle.js";

try {
  await startDevelopment(parseDevArguments(process.argv.slice(2)), "agent-test");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
