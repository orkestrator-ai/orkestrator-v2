import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_LINUX_SANDBOX_PROGRAMS,
  CLAUDE_LINUX_SANDBOX_PROBE_TTL_MS,
  claudeLinuxSandboxStatus,
  executableOnPath,
  probeClaudeLinuxSandbox,
  setClaudeLinuxSandboxStatusForTests,
  type ClaudeLinuxSandboxProbeResult,
} from "./claude-linux-sandbox.js";

/** What the pinned CLI printed on Ubuntu 26.04's runner (todo 0030, run 40195484352). */
const NESTED_DENIED = "unshare: write failed /proc/self/setgroups: Permission denied\n";

function recordingRunner(answers: { nested: boolean; outer?: boolean; stderr?: string }) {
  const calls: string[][] = [];
  const run = (command: string, args: readonly string[]): ClaudeLinuxSandboxProbeResult => {
    calls.push([command, ...args]);
    const nestedCall = args.includes("unshare");
    const ok = nestedCall ? answers.nested : (answers.outer ?? true);
    return { ok, stderr: ok ? "" : (answers.stderr ?? NESTED_DENIED) };
  };
  return { calls, run };
}

const everything = () => true;
/** What `tests/setup-node.ts` pins for every suite. */
const PRELOAD_STATUS = { available: true } as const;

describe("Claude Linux sandbox probe", () => {
  test("a host whose bubblewrap nests a user namespace can sandbox", () => {
    const { calls, run } = recordingRunner({ nested: true });
    expect(probeClaudeLinuxSandbox({ onPath: everything, run })).toEqual({ available: true });
    // One run on a working host: bubblewrap with the nested namespace inside it.
    expect(calls).toHaveLength(1);
    const [command, ...args] = calls[0]!;
    expect(command).toBe("bwrap");
    expect(args).toEqual(expect.arrayContaining(["--unshare-user", "--unshare-pid", "--proc"]));
    const nested = args.slice(args.indexOf("--") + 1);
    expect(nested).toEqual(expect.arrayContaining(["unshare", "--user", "--map-root-user"]));
    expect(nested.at(-1)).toBe("true");
  });

  test("AppArmor's bwrap profile is named when the nested namespace is refused", () => {
    const { calls, run } = recordingRunner({ nested: false });
    const status = probeClaudeLinuxSandbox({
      onPath: everything,
      run,
      appArmorBwrapProfile: () => true,
    });
    expect(status).toMatchObject({ available: false, failure: "nested-user-namespace" });
    if (status.available) throw new Error("expected a failure");
    expect(status.reason).toContain("bwrap-userns-restrict");
    expect(status.reason).toContain("write failed /proc/self/setgroups: Permission denied");
    expect(status.reason).toContain("does not change AppArmor policy");
    // The second run told the stages apart: bubblewrap alone worked.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at(-1)).toBe("true");
    expect(calls[1]).not.toContain("unshare");
  });

  test("a nested refusal without AppArmor says so instead of blaming it", () => {
    const { run } = recordingRunner({ nested: false, stderr: "unshare failed: No space left\n" });
    const status = probeClaudeLinuxSandbox({
      onPath: everything,
      run,
      appArmorBwrapProfile: () => false,
    });
    expect(status).toMatchObject({ available: false, failure: "nested-user-namespace" });
    if (status.available) throw new Error("expected a failure");
    expect(status.reason).not.toContain("AppArmor");
    expect(status.reason).toContain("unshare failed: No space left");
    expect(status.reason).toContain("container");
  });

  test("bubblewrap that cannot create its own namespace is its own failure", () => {
    const { run } = recordingRunner({
      nested: false,
      outer: false,
      stderr: "bwrap: setting up uid map: Permission denied\n",
    });
    const status = probeClaudeLinuxSandbox({
      onPath: everything,
      run,
      appArmorBwrapProfile: () => true,
    });
    expect(status).toMatchObject({ available: false, failure: "user-namespace" });
    if (status.available) throw new Error("expected a failure");
    expect(status.reason).toContain("bwrap: setting up uid map: Permission denied");
    expect(status.reason).toContain("kernel.apparmor_restrict_unprivileged_userns");
  });

  test("missing programs fail before anything runs", () => {
    for (const missing of CLAUDE_LINUX_SANDBOX_PROGRAMS) {
      const { calls, run } = recordingRunner({ nested: true });
      const status = probeClaudeLinuxSandbox({ onPath: (name) => name !== missing, run });
      expect(status).toMatchObject({ available: false, failure: "missing-programs" });
      if (status.available) throw new Error("expected a failure");
      expect(status.reason).toContain(`${missing} is missing`);
      expect(calls).toHaveLength(0);
    }
    const status = probeClaudeLinuxSandbox({ onPath: () => false });
    if (status.available) throw new Error("expected a failure");
    expect(status.reason).toContain("bwrap and socat are missing");
  });

  test("without unshare the nested namespace cannot be checked, so the host fails closed", () => {
    const { calls, run } = recordingRunner({ nested: true });
    const status = probeClaudeLinuxSandbox({ onPath: (name) => name !== "unshare", run });
    expect(status).toMatchObject({ available: false, failure: "probe-unavailable" });
    expect(calls).toHaveLength(0);
  });

  test("a long error line is bounded in the reason", () => {
    const { run } = recordingRunner({ nested: false, stderr: `${"x".repeat(5_000)}\nsecond` });
    const status = probeClaudeLinuxSandbox({
      onPath: everything,
      run,
      appArmorBwrapProfile: () => false,
    });
    if (status.available) throw new Error("expected a failure");
    expect(status.reason.length).toBeLessThan(600);
    expect(status.reason).not.toContain("second");
  });

  test("the cached answer is reused within its window and re-read after it", () => {
    setClaudeLinuxSandboxStatusForTests(undefined);
    try {
      const first = claudeLinuxSandboxStatus(1_000);
      expect(claudeLinuxSandboxStatus(1_000 + CLAUDE_LINUX_SANDBOX_PROBE_TTL_MS - 1)).toBe(first);
      expect(claudeLinuxSandboxStatus(1_000 + CLAUDE_LINUX_SANDBOX_PROBE_TTL_MS)).not.toBe(first);
    } finally {
      setClaudeLinuxSandboxStatusForTests(PRELOAD_STATUS);
    }
  });

  test("the PATH lookup finds an executable and ignores a plain file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-sandbox-path-"));
    try {
      await writeFile(join(directory, "bwrap"), "#!/bin/sh\n");
      await chmod(join(directory, "bwrap"), 0o755);
      await writeFile(join(directory, "socat"), "");
      await chmod(join(directory, "socat"), 0o644);
      expect(executableOnPath("bwrap", directory)).toBe(true);
      expect(executableOnPath("socat", directory)).toBe(false);
      expect(executableOnPath("bwrap", "")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// The real probe, where there is a real bubblewrap to run. On macOS and on a
// Linux host without bubblewrap it has nothing to prove.
const linuxWithBwrap =
  process.platform === "linux" &&
  CLAUDE_LINUX_SANDBOX_PROGRAMS.every((name) => executableOnPath(name));

describe.skipIf(!linuxWithBwrap)("Claude Linux sandbox probe on this host", () => {
  test("answers with a reason or not at all, within its bound", () => {
    const started = Date.now();
    const status = probeClaudeLinuxSandbox();
    expect(Date.now() - started).toBeLessThan(15_000);
    if (!status.available) expect(status.reason).toContain("cannot run commands on this host");
  });

  // bubblewrap 0.8 added the option; an older one cannot stage this failure.
  const help = linuxWithBwrap
    ? Bun.spawnSync(["bwrap", "--help"], { stdout: "pipe", stderr: "pipe" })
    : undefined;
  const canDisableUserns = `${help?.stdout.toString()}${help?.stderr.toString()}`.includes(
    "--disable-userns",
  );

  test.skipIf(!canDisableUserns)("a bubblewrap that refuses nested namespaces is caught", () => {
    // `--disable-userns` makes bubblewrap refuse any namespace nested inside
    // its own: the same stage AppArmor's bwrap profile breaks, without
    // changing the host's policy.
    const status = probeClaudeLinuxSandbox({
      run: (command, args) => {
        const separator = args.indexOf("--");
        const disabled = [
          ...args.slice(0, separator),
          "--disable-userns",
          ...args.slice(separator),
        ];
        const result = Bun.spawnSync([command, ...disabled], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          timeout: 5_000,
        });
        return { ok: result.exitCode === 0, stderr: result.stderr.toString() };
      },
      appArmorBwrapProfile: () => false,
    });
    if (probeClaudeLinuxSandbox().available) {
      expect(status).toMatchObject({ available: false, failure: "nested-user-namespace" });
    } else {
      expect(status.available).toBe(false);
    }
  });
});
