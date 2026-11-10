import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeClaudeLinuxSandbox } from "@orkestrator/protocol/node/claude-linux-sandbox";
import { PINNED_TOOLCHAIN_VERSIONS } from "../../../../packages/toolchain/src/manifest.js";
import {
  PLATFORM_SANDBOX_EXPECTATIONS,
  providerSandboxLiveGate,
  RESULT_SENTINEL,
  type SandboxObservation,
  type SandboxReport,
} from "./claude-provider-sandbox.live-probe.js";

// Runs the real bridge and the pinned Claude CLI (no credentials, a scripted
// loopback model) and proves the provider sandbox holds: a command cannot
// write outside the workspace or reach an unlisted host, and neither raises an
// approval card (to-do 0001 task 9). macOS (Seatbelt) and Linux (bubblewrap,
// where the host can nest the CLI's user namespace; the uncached probe
// decides, since the test preload pins the cached answer). Run it with
// `mise run verify:claude:sandbox-live`; also runs in the slow tier
// (`mise run test:slow`).
const PROBE_TIMEOUT_MS = 600_000;
const GATE = providerSandboxLiveGate(process.platform, () => probeClaudeLinuxSandbox());
const EXPECT = PLATFORM_SANDBOX_EXPECTATIONS[process.platform];

async function runProbe(): Promise<SandboxReport> {
  // sandbox-exec matches canonical paths; macOS /var is a symlink.
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-provider-sandbox-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all(
    [join(home, ".claude"), join(home, "gh"), workspace, outside].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  try {
    const probe = Bun.spawn(
      [process.execPath, join(import.meta.dir, "claude-provider-sandbox.live-probe.ts")],
      {
        cwd: join(import.meta.dir, "..", ".."),
        // A clean environment: no ambient login, key or Claude home reaches the CLI.
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          GH_CONFIG_DIR: join(home, "gh"),
          CWD: workspace,
          SANDBOX_PROBE_OUTSIDE: outside,
          ANTHROPIC_API_KEY: "fixture-only-not-a-key",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
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
      return JSON.parse(line.slice(RESULT_SENTINEL.length)) as SandboxReport;
    } finally {
      clearTimeout(deadline);
      if (probe.exitCode === null) probe.kill();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function observation(report: SandboxReport, name: string): SandboxObservation {
  const found = report.observations.find((entry) => entry.name === name);
  if (!found) throw new Error(`No observation for ${name}`);
  // Every turn reached the tool, got its result back and settled.
  expect(found.toolResult, name).not.toBeNull();
  expect(found.activity, name).toBe("idle");
  expect(found.questions, name).toBe(0);
  return found;
}

(GATE.run && EXPECT ? test : test.skip)(
  `the pinned Claude CLI enforces the provider sandbox the bridge asks for (${
    GATE.run ? (process.platform === "darwin" ? "macOS Seatbelt" : "Linux bubblewrap") : GATE.reason
  })`,
  async () => {
    const expected = EXPECT!;
    const report = await runProbe();
    expect(report.platform).toBe(process.platform);
    // The SDK's bundled CLI is the pinned toolchain version; a drift fails here.
    expect(report.cliVersion).toBe(PINNED_TOOLCHAIN_VERSIONS.claude);

    // Controls: the commands work, and the same request is reached or asked
    // about when the policy allows it, so each refusal below is the sandbox's.
    const unsandboxed = observation(report, "control-unsandboxed");
    expect(unsandboxed.wrote).toBe(true);
    expect(unsandboxed.unlistedHits).toBe(1);
    expect(unsandboxed.approvals).toEqual([]);
    const inside = observation(report, "control-workspace-write");
    expect(inside.wrote).toBe(true);
    expect(inside.toolResult!.isError).toBe(false);
    expect(inside.approvals).toEqual([]);
    const proxied = observation(report, "control-proxy-full");
    expect(proxied.unlistedHits).toBe(1);
    expect(proxied.approvals).toEqual([]);
    // `allowLocalBinding` is macOS-only. On Linux each command has its own
    // network namespace, so loopback is reached only through the proxy.
    const direct = observation(report, "control-direct-full");
    expect(direct.unlistedHits).toBe(expected.directLoopbackWithFullNetwork ? 1 : 0);
    expect(direct.toolResult!.isError).toBe(!expected.directLoopbackWithFullNetwork);
    expect(direct.approvals).toEqual([]);
    // Without `strictAllowlist` an asking turn gets a card for the host.
    const fullAsk = observation(report, "control-proxy-full-ask");
    expect(fullAsk.unlistedHits).toBe(1);
    expect(fullAsk.approvals).toEqual([
      { kind: "command-approval", toolName: "Bash" },
      { kind: "permission", toolName: "SandboxNetworkAccess" },
    ]);

    // A write outside the workspace fails, with or without an escape request,
    // and no approval card is raised for it.
    for (const name of ["write-outside", "write-outside-escape"]) {
      const write = observation(report, name);
      expect(write.wrote, name).toBe(false);
      expect(write.toolResult!.isError, name).toBe(true);
      expect(write.toolResult!.excerpt, name).toContain(expected.outsideWriteRefusal);
      expect(write.approvals, name).toEqual([]);
    }

    // An asking policy may escape, but only with a visible approval. The
    // command has not written while parked; acceptance permits it and denial
    // prevents it. This also distinguishes a real escape from a sandboxed write.
    for (const action of ["accept", "decline"] as const) {
      const name = `write-outside-escape-ask-${action}`;
      const escape = observation(report, name);
      expect(escape.approvals, name).toEqual([{ kind: "command-approval", toolName: "Bash" }]);
      expect(escape.writesBeforeApproval, name).toEqual([false]);
      expect(escape.wrote, name).toBe(action === "accept");
      expect(escape.toolResult!.isError, name).toBe(action === "decline");
      expect(escape.unlistedHits, name).toBe(0);
    }

    // A request to an unlisted host never arrives, whether it connects
    // directly (Seatbelt's network rule, or bubblewrap's empty network
    // namespace) or through the sandbox proxy
    // (`strictAllowlist`), and no approval card is raised for it.
    for (const name of [
      "network-direct",
      "network-direct-escape",
      "network-proxy",
      "network-proxy-escape",
    ]) {
      const network = observation(report, name);
      expect(network.unlistedHits, name).toBe(0);
      expect(network.toolResult!.isError, name).toBe(true);
      expect(network.approvals, name).toEqual([]);
    }
    for (const name of ["network-proxy", "network-proxy-escape"]) {
      expect(observation(report, name).toolResult!.excerpt, name).toContain(
        "not on the allow list",
      );
    }
    // Under `ask` the Bash call is the one card; the unlisted host adds none.
    const asked = observation(report, "network-proxy-ask");
    expect(asked.unlistedHits).toBe(0);
    expect(asked.toolResult!.isError).toBe(true);
    expect(asked.approvals).toEqual([{ kind: "command-approval", toolName: "Bash" }]);
  },
  PROBE_TIMEOUT_MS,
);
