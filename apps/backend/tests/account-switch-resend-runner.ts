/**
 * Runs one `account-switch-stack` scenario in its own host process, for the
 * per-platform `account-switch-*-live.test.ts` files. Every run has its own temp root,
 * HOME, data directory, loopback port (`port: 0`) and host process, so runs of one
 * platform may overlap; the only thing they share is the bridge's `dist`, which
 * `buildBridgeIfStale` makes once per file. Kept free of `bun:test` imports: it is a
 * support module, and the suite that asserts on the evidence lives in
 * `account-switch-resend-suite.ts`.
 */
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

/** Each scenario waits out a 20 s settle window, so the budget covers boot plus that. */
export const SCENARIO_TIMEOUT_MS = 240_000;

export const CLIS: Record<StackPlatform, string | undefined> = {
  claude: policyQualificationCli("claude"),
  codex:
    policyQualificationCli("codex") ??
    (existsSync(path.join(repositoryRoot, "binaries", "codex"))
      ? path.join(repositoryRoot, "binaries", "codex")
      : undefined),
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
export function buildBridgeIfStale(platform: StackPlatform): void {
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

export async function runScenario(
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
    const evidence = JSON.parse(line.slice(STACK_EVIDENCE_PREFIX.length)) as StackEvidence;
    // --only-failures suppresses passing tests; keep the bounded runner informed
    // that this multi-scenario suite is progressing without printing call content.
    process.stderr.write(`Completed account-switch scenario: ${platform}/${scenario}\n`);
    return evidence;
  } finally {
    await removeStackPaths(paths);
  }
}
