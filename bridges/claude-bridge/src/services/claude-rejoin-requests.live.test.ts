import { expect, test } from "bun:test";
import { join } from "node:path";
import { REJOIN_RESULT_SENTINEL } from "./claude-rejoin-requests.live-probe.js";

// Runs the pinned Claude CLI for real (no credentials, a loopback model) and
// qualifies an actual rejoin: a prompt joining a CLI that outlived its turn
// re-reads what that CLI still waits on (`recoverClaudeRequestsOnRejoin`).
// A tab remount never reaches the CLI and is covered by
// `session-manager-rejoin-requests.test.ts`. Runs in the slow tier
// (`mise run test:slow`) and CI. Recheck on every Claude CLI or SDK bump.
test("a rejoin recovers a permission only the live CLI still holds, once", async () => {
  const packageRoot = join(import.meta.dir, "..", "..");
  const probePath = join(import.meta.dir, "claude-rejoin-requests.live-probe.ts");
  // The session-manager suites mock the SDK module-wide, so the probe runs
  // in a clean process. It handles SIGTERM itself so a timeout closes its CLI.
  const probe = Bun.spawn([process.execPath, probePath], {
    cwd: packageRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => probe.kill(), 90_000);
  let stdout = "";
  let stderr = "";
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
  } finally {
    clearTimeout(deadline);
    if (probe.exitCode === null) probe.kill();
  }
  expect(exitCode, stderr).toBe(0);
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(REJOIN_RESULT_SENTINEL));
  if (!line) throw new Error(`Probe stdout had no ${REJOIN_RESULT_SENTINEL} line:\n${stdout}`);
  const result = JSON.parse(line.slice(REJOIN_RESULT_SENTINEL.length));

  expect(result).toEqual({
    bridgeRejoined: true,
    recoveredBridgeQuestion: true,
    liveBackgroundHookSurvived: true,
    elicitationDeliveries: 1,
    sdkReplayedElicitation: false,
    cliListedPendingElicitation: false,
    sdkReturnedElicitationInventory: false,
    // A request whose frame was lost is listed by the CLI's initialize answer,
    // redelivered once, and the answer given on that card reaches the CLI.
    dropped: true,
    recoveredOnce: true,
    recoveredToolUseId: "toolu_fixture_0",
    answerReachedCli: true,
    firstInventoryListedDropped: true,
    // A card still open when the re-read lists it is not delivered again, and
    // an answered request is no longer listed.
    overlapOutcome: "read",
    secondDeliveries: 1,
    secondAnswerReachedCli: true,
    afterAnswer: "read",
    answeredStillListed: false,
    totalDeliveries: 3,
    // A card whose CLI died is withdrawn; nothing is accepted after the end.
    deadCardWithdrawn: true,
    afterEnd: "process-ended",
    // The SDK hands the caller none of the lists, so the bridge cannot read
    // the elicitation inventory (which this CLI did not list either): it
    // stays unknown. When either changes, wire elicitations into
    // `recoverClaudeRequestsOnRejoin` and update 0007 task 4.
    callerSeesInventory: false,
    cliListsElicitations: false,
    cliListsPermissions: true,
  });
}, 120_000);
