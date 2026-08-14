import process from "node:process";
import { parseDevArguments } from "./dev/arguments.js";
import { stopProfile } from "./dev/lifecycle.js";

try {
  process.exitCode = await stopProfile(parseDevArguments(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
