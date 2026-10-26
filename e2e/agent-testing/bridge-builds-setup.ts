import { checkProfileBridgeBuilds } from "../../apps/desktop/scripts/dev/bridge-builds";

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

/**
 * Fails the run before its first test when the profile's bridges no longer
 * match the checkout: the backend runs from source, but every bridge runs the
 * `dist` built when the profile started, and a live turn on an old build
 * spends real tokens proving nothing.
 */
export default async function globalSetup(): Promise<void> {
  const check = await checkProfileBridgeBuilds({ profile });
  if (check.state === "allowed") {
    console.warn(
      [
        `Running against stale bridge builds in profile ${profile}:`,
        ...check.problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
  } else if (check.state === "unrecorded") {
    console.warn(
      `Profile ${profile} has no bridge build record, so its bridge builds cannot be checked; restart it with mise run dev:test to record them.`,
    );
  }
}
