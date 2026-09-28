import process from "node:process";
import { parsePruneArguments } from "./dev/arguments.js";
import { formatPruneOutcome, pruneProfiles } from "./dev/profile-cleanup.js";

try {
  const args = parsePruneArguments(process.argv.slice(2));
  const outcomes = await pruneProfiles(args);
  if (args.json) console.log(JSON.stringify(outcomes, null, 2));
  else if (outcomes.length === 0) console.log("No development profiles found.");
  else for (const outcome of outcomes) console.log(formatPruneOutcome(outcome));
  process.exitCode = outcomes.some((outcome) => outcome.action === "failed") ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
