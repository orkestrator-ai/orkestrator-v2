import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { isolatedProfileArguments, runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

installFatalRejectionGuard({ label: "[isolated-browser]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
const design = args[0] === "--design";
// Everything else is forwarded to the profile's `dev:test`, validated up front
// so a typo fails before a profile is created.
const profileArgs = args.slice(design ? 1 : 0).filter((argument) => argument !== "--");
try {
  isolatedProfileArguments(profileArgs);
} catch (error) {
  throw new Error(
    `Usage: test-agent-browser-isolated.ts [--design] [--credential-source <name>]… [--agent-platforms <list>] [--no-agent-credentials] [--use-dev-worktree-folder]\n${error instanceof Error ? error.message : error}`,
  );
}

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    process.exitCode = await runIsolatedBrowser({
      design,
      profileArgs,
      signal: owner.signal,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Isolated browser validation failed");
    process.exitCode = 1;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
