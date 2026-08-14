import process from "node:process";
import { parseDevArguments } from "./dev/arguments.js";
import { resetProfile } from "./dev/lifecycle.js";

try {
  process.exitCode = await resetProfile(parseDevArguments(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
