import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PINNED_TOOLCHAIN_VERSIONS } from "../../../../packages/toolchain/src/manifest.js";
import {
  RESULT_SENTINEL,
  type HardenedGitObservation,
  type HardenedGitReport,
} from "./read-only-hardened-git.live-probe.js";

// Runs the pinned Claude CLI (no credentials, a scripted loopback model) with
// a read-only reviewer's options and no command sandbox, and proves that the
// CLI runs the Git command the read-only hook rewrote through a decision-less
// `updatedInput`: a checkout's configured diff helper must not run, and the
// tool result must be Git's own diff. A control turn without the hook shows
// the helper is live. Runs in the slow tier (`mise run test:slow`); recheck on
// every Claude CLI or SDK bump (docs/development/upgrade-agents.md).
const PROBE_TIMEOUT_MS = 600_000;

async function runProbe(): Promise<HardenedGitReport> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-hardened-git-")));
  const home = join(root, "home");
  await Promise.all(
    [join(home, ".claude"), join(home, "tmp")].map((path) => mkdir(path, { recursive: true })),
  );
  try {
    const probe = Bun.spawn(
      [process.execPath, join(import.meta.dir, "read-only-hardened-git.live-probe.ts")],
      {
        cwd: join(import.meta.dir, "..", ".."),
        // A clean environment: no ambient login, key or Claude home reaches the CLI.
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          CLAUDE_CODE_TMPDIR: join(home, "tmp"),
          CWD: root,
          ANTHROPIC_API_KEY: "fixture-only-not-a-key",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          ...(process.env.ORKESTRATOR_POLICY_CLAUDE_PATH
            ? { ORKESTRATOR_POLICY_CLAUDE_PATH: process.env.ORKESTRATOR_POLICY_CLAUDE_PATH }
            : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => probe.kill(), PROBE_TIMEOUT_MS - 10_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
        probe.exited,
      ]);
      expect(exitCode, stderr.slice(-4_000)).toBe(0);
      const line = stdout.split("\n").find((candidate) => candidate.startsWith(RESULT_SENTINEL));
      if (!line) throw new Error(`Probe stdout had no ${RESULT_SENTINEL} line`);
      return JSON.parse(line.slice(RESULT_SENTINEL.length)) as HardenedGitReport;
    } finally {
      clearTimeout(deadline);
      if (probe.exitCode === null) probe.kill();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "the pinned Claude CLI runs the hook's hardened Git rewrite, not the model's command",
  async () => {
    const report = await runProbe();
    if (!process.env.ORKESTRATOR_POLICY_CLAUDE_PATH) {
      expect(report.cliVersion).toBe(PINNED_TOOLCHAIN_VERSIONS.claude);
    }
    const byName = new Map<string, HardenedGitObservation>(
      report.observations.map((observation) => [observation.name, observation]),
    );
    for (const name of ["hardened-diff", "hardened-log-pipe"]) {
      const observation = byName.get(name)!;
      // The hook rewrote it (no decision), and what ran was the rewrite.
      expect(observation.hookCommand, name).toContain("--no-ext-diff --no-textconv");
      expect(observation.toolResult, name).not.toBeNull();
      expect(observation.toolResult!.isError, name).toBe(false);
      expect(observation.toolResult!.excerpt, name).toContain("diff --git");
      expect(observation.toolResult!.excerpt, name).toContain("+two");
      expect(observation.helperRan, name).toBe(false);
    }
    // The fixture's helper is live: the same command without the hook runs it.
    const control = byName.get("unhooked-control")!;
    expect(control.hookCommand).toBeNull();
    expect(control.toolResult).not.toBeNull();
    expect(control.helperRan).toBe(true);
  },
  PROBE_TIMEOUT_MS,
);
