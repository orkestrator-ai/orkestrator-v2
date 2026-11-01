/**
 * Automatic switching's resend across a real bridge replacement: real bridges and
 * the pinned CLIs, with the provider's servers scripted, so no turn is billed and no
 * real login is read. See `account-switch-stack.ts` for what this can and cannot say.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { policyQualificationCli } from "../../../tests/conformance/execution-policy/vendor-cli";
import {
  createStackPaths,
  removeStackPaths,
  STACK_EVIDENCE_PREFIX,
  stackEnvironment,
  type StackEvidence,
  type StackPlatform,
  type StackScenario,
} from "./account-switch-stack";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const SCENARIO_TIMEOUT_MS = 240_000;

const CLIS: Record<StackPlatform, string | undefined> = {
  claude: policyQualificationCli("claude"),
  codex: existsSync(path.join(repositoryRoot, "binaries", "codex"))
    ? path.join(repositoryRoot, "binaries", "codex")
    : undefined,
};

function newestSource(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSource(entryPath));
    else if (!entry.name.includes(".test.")) newest = Math.max(newest, statSync(entryPath).mtimeMs);
  }
  return newest;
}

/** A backend runs a bridge's `dist`, which an edit to its source does not rebuild. */
function buildBridgeIfStale(platform: StackPlatform): void {
  const bridge = path.join(repositoryRoot, "bridges", `${platform}-bridge`);
  const output = path.join(bridge, "dist", "index.js");
  if (existsSync(output) && statSync(output).mtimeMs >= newestSource(path.join(bridge, "src"))) {
    return;
  }
  const build = Bun.spawnSync([process.execPath, "run", "build"], { cwd: bridge, stderr: "pipe" });
  if (build.exitCode !== 0) {
    throw new Error(`Building ${platform}-bridge failed: ${build.stderr.toString().slice(-2_000)}`);
  }
}

async function runScenario(
  platform: StackPlatform,
  scenario: StackScenario,
): Promise<StackEvidence> {
  const paths = await createStackPaths(platform, CLIS[platform]!);
  try {
    const host = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "account-switch-stack-host.ts"),
        platform,
        scenario,
      ],
      {
        cwd: repositoryRoot,
        env: stackEnvironment(paths),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => host.kill("SIGKILL"), SCENARIO_TIMEOUT_MS - 5_000);
    const [stdout, stderr, status] = await Promise.all([
      new Response(host.stdout).text(),
      new Response(host.stderr).text(),
      host.exited,
    ]);
    clearTimeout(timer);
    if (status !== 0) {
      throw new Error(`The scenario exited ${status}:\n${(stdout + stderr).slice(-4_000)}`);
    }
    const line = stdout.split("\n").find((text) => text.startsWith(STACK_EVIDENCE_PREFIX));
    if (!line) throw new Error(`The scenario printed no evidence:\n${stdout.slice(-4_000)}`);
    return JSON.parse(line.slice(STACK_EVIDENCE_PREFIX.length)) as StackEvidence;
  } finally {
    await removeStackPaths(paths);
  }
}

/** One refused call on the first account, and the turn that continued it on the next. */
function expectContinuedOnNewAccount(evidence: StackEvidence, expectedResends = 1): void {
  expect(evidence.active).toBe("later");
  expect(evidence.lastSwitchReason).toBe("limit");
  expect(evidence.pinned).toBe(false);
  expect(evidence.loginsUnchanged).toBe(true);
  // The process that took the refusal is gone, and a new one served the resend.
  expect(evidence.bridgePids.length).toBeGreaterThanOrEqual(2);
  const refused = evidence.calls.filter((call) => call.refused);
  expect(refused.length).toBeGreaterThanOrEqual(1);
  expect(refused.every((call) => call.account === "soonest")).toBe(true);
  const resent = evidence.calls.filter((call) => call.resendTurn);
  expect(resent).toHaveLength(expectedResends);
  for (const call of resent) {
    expect(call.account).toBe("later");
    expect(call.refused).toBe(false);
    // Read back from the shared transcript exactly once: continued, not run twice.
    expect(call.stoppedPromptCopies).toBe(1);
  }
}

function expectOneModeAcrossTheMove(evidence: StackEvidence): void {
  const modes = new Set(evidence.launches.map((launch) => launch.permissionMode));
  expect(modes.size).toBe(1);
}

describe.each(["claude", "codex"] as const)("automatic switching on the pinned %s", (platform) => {
  const scenarioTest = CLIS[platform] ? test : test.skip;

  beforeAll(() => {
    if (CLIS[platform]) buildBridgeIfStale(platform);
  });

  scenarioTest(
    "a native tab continues on the new account after a real bridge replacement",
    async () => {
      const evidence = await runScenario(platform, "native-build");
      expectContinuedOnNewAccount(evidence);
      expectOneModeAcrossTheMove(evidence);
    },
    SCENARIO_TIMEOUT_MS,
  );

  scenarioTest(
    "a planning turn stays a planning turn when it is resent",
    async () => {
      const evidence = await runScenario(platform, "native-plan-turn");
      expectContinuedOnNewAccount(evidence);
      const resent = evidence.calls.find((call) => call.resendTurn)!;
      if (platform === "claude") {
        expect(evidence.launches.at(-1)).toMatchObject({
          account: "later",
          permissionMode: "plan",
          resumed: true,
        });
      } else {
        expect(resent.plan).toBe(true);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  scenarioTest(
    "two tabs stopped together each continue once",
    async () => {
      const evidence = await runScenario(platform, "native-two-tabs");
      expectContinuedOnNewAccount(evidence, 2);
    },
    SCENARIO_TIMEOUT_MS,
  );

  scenarioTest(
    "another limit moves nothing and resends nothing",
    async () => {
      const evidence = await runScenario(platform, "native-other-limit");
      expect(evidence.active).toBe("soonest");
      expect(evidence.lastSwitchReason).toBeUndefined();
      expect(evidence.bridgePids).toHaveLength(1);
      expect(evidence.calls).toHaveLength(1);
      // It looked, rather than moving or staying on the error's words alone.
      expect(evidence.usageReadsAfterRefusal).toBeGreaterThanOrEqual(1);
    },
    SCENARIO_TIMEOUT_MS,
  );

  scenarioTest(
    "with every account out, one resend is refused and nothing more happens",
    async () => {
      const evidence = await runScenario(platform, "native-all-out");
      expect(evidence.calls.map((call) => [call.account, call.refused])).toEqual([
        ["soonest", true],
        ["later", true],
      ]);
      expect(evidence.calls.filter((call) => call.resendTurn)).toHaveLength(1);
      expect(evidence.loginsUnchanged).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );

  scenarioTest(
    "two reviewers on one bridge each continue once, still read-only",
    async () => {
      const evidence = await runScenario(platform, "graph-panel");
      expectContinuedOnNewAccount(evidence, 2);
      expect(evidence.bridgePids).toHaveLength(2);
      expectOneModeAcrossTheMove(evidence);
      if (platform === "claude") expect(evidence.launches[0]?.permissionMode).toBe("dontAsk");
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const scenario of ["multi-review", "build-pipeline", "graph-run"] as const) {
    scenarioTest(
      `a ${scenario} continues on the new account after a real bridge replacement`,
      async () => {
        const evidence = await runScenario(platform, scenario);
        expectContinuedOnNewAccount(evidence);
        expectOneModeAcrossTheMove(evidence);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }
});
