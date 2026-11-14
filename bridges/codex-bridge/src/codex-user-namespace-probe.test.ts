import { afterEach, describe, expect, test } from "bun:test";

import { codexReadOnlyCommandSandboxOff } from "./codex-read-only-sandbox.js";
import {
  BWRAP_PROBE_ARGS,
  CODEX_SANDBOX_PROBE_ARGS,
  CODEX_USER_NAMESPACE_PROBE_TTL_MS,
  CODEX_USER_NAMESPACE_PROBE_UNKNOWN_TTL_MS,
  type CodexUserNamespaceProbeAnswer,
  type CodexUserNamespaceProbeDependencies,
  type CodexUserNamespaceProbeRun,
  classifyCodexUserNamespaceRun,
  codexUserNamespaceRefusal,
  probeCodexUserNamespace,
  resetCodexUserNamespaceProbeForTests,
  UNSHARE_PROBE_ARGS,
} from "./codex-user-namespace-probe.js";

afterEach(() => resetCodexUserNamespaceProbeForTests());

const exited = (status: number, stderr = ""): CodexUserNamespaceProbeRun => ({
  status,
  signal: null,
  stderr,
});
const BWRAP_REFUSAL = "bwrap: No permissions to create a new namespace";
const UNSHARE_REFUSAL = "unshare: write failed /proc/self/uid_map: Operation not permitted";

/** A probe whose helpers answer from `answers`, recording what it ran. */
function fakeHost(
  answers: Record<string, CodexUserNamespaceProbeRun>,
  options: { codex?: boolean; onPath?: readonly string[] } = {},
): { dependencies: CodexUserNamespaceProbeDependencies; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    dependencies: {
      codexExecutable: () => (options.codex === false ? undefined : "/opt/codex/bin/codex"),
      onPath: (name) => (options.onPath ?? Object.keys(answers)).includes(name),
      run: (command, args) => {
        calls.push([command, ...args]);
        const name = command.split("/").at(-1) ?? command;
        const answer = answers[name];
        if (!answer) throw new Error(`unexpected probe command ${command}`);
        return answer;
      },
    },
  };
}

describe("classifyCodexUserNamespaceRun", () => {
  test("only a non-zero exit naming a namespace operation is a refusal", () => {
    for (const stderr of [
      BWRAP_REFUSAL,
      "bwrap: Creating new namespace failed: Operation not permitted",
      "bwrap: setting up uid map: Permission denied",
      UNSHARE_REFUSAL,
      "unshare: unshare failed: Operation not permitted",
      // Observed from Codex 0.166.0's `codex sandbox -- true` and util-linux
      // `unshare` on an Arch host whose user namespaces were refused.
      "bwrap: Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)",
      "unshare: unshare failed: No space left on device",
      "error: sandbox failed\nbwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.",
    ]) {
      const answer = classifyCodexUserNamespaceRun(exited(1, stderr));
      expect(answer.outcome).toBe("refused");
    }
  });

  test("the refusal's detail is its namespace line, not the first line", () => {
    expect(
      classifyCodexUserNamespaceRun(exited(1, `\nwarning: something else\n${BWRAP_REFUSAL}\nmore`)),
    ).toEqual({ outcome: "refused", detail: BWRAP_REFUSAL });
  });

  test("a clean exit means the namespace was created", () => {
    expect(classifyCodexUserNamespaceRun(exited(0))).toEqual({ outcome: "allowed" });
  });

  test("a spawn error, a timeout or a signal exit is unknown, never a refusal", () => {
    for (const run of [
      { status: null, error: "spawnSync bwrap ENOENT", stderr: "" },
      { status: null, signal: "SIGKILL", error: "spawnSync bwrap ETIMEDOUT", stderr: "" },
      { status: null, signal: "SIGSEGV", stderr: BWRAP_REFUSAL },
      // An error that names a refusal still does not count without an exit status.
      { status: 1, error: "spawnSync bwrap EPIPE", stderr: BWRAP_REFUSAL },
    ] satisfies CodexUserNamespaceProbeRun[]) {
      expect(classifyCodexUserNamespaceRun(run)).toEqual({ outcome: "unknown" });
    }
  });

  test("a failure after the namespace was created is unknown", () => {
    for (const stderr of [
      "bwrap: execvp true: No such file or directory",
      "Error: failed to load configuration",
      // Codex 0.166.0 with a read-only temporary directory panics (exit 101).
      "thread 'main' panicked at linux-sandbox/src/linux_run_main.rs:935:13:\nfailed to open synthetic bubblewrap mount registry lock /tmp/codex-bwrap-synthetic-mount-targets-1000/lock: Read-only file system (os error 30)",
      "",
    ]) {
      expect(classifyCodexUserNamespaceRun(exited(1, stderr))).toEqual({ outcome: "unknown" });
    }
  });
});

describe("probeCodexUserNamespace", () => {
  test("asks Codex's own sandbox first and stops when it runs a command", () => {
    const host = fakeHost({ codex: exited(0), bwrap: exited(1, BWRAP_REFUSAL) });
    expect(probeCodexUserNamespace(host.dependencies)).toEqual({ outcome: "allowed" });
    expect(host.calls).toEqual([["/opt/codex/bin/codex", ...CODEX_SANDBOX_PROBE_ARGS]]);
  });

  test("Codex's sandbox refusing is a refusal even where the system bwrap is allowed", () => {
    // Ubuntu's AppArmor profile permits /usr/bin/bwrap but not Codex's helper.
    const host = fakeHost({ codex: exited(1, BWRAP_REFUSAL), bwrap: exited(0) });
    expect(probeCodexUserNamespace(host.dependencies)).toEqual({
      outcome: "refused",
      detail: BWRAP_REFUSAL,
    });
    expect(host.calls).toHaveLength(1);
  });

  test("an unknown Codex answer falls back to the system bwrap, whose refusal counts", () => {
    const host = fakeHost({
      codex: { status: null, signal: "SIGKILL", error: "spawnSync codex ETIMEDOUT", stderr: "" },
      bwrap: exited(1, BWRAP_REFUSAL),
    });
    expect(probeCodexUserNamespace(host.dependencies)).toEqual({
      outcome: "refused",
      detail: BWRAP_REFUSAL,
    });
    expect(host.calls.map(([command]) => command)).toEqual(["/opt/codex/bin/codex", "bwrap"]);
    expect(host.calls[1]?.slice(1)).toEqual([...BWRAP_PROBE_ARGS]);
  });

  test("the system bwrap succeeding proves nothing about Codex's helper", () => {
    const host = fakeHost(
      { bwrap: exited(0), unshare: exited(1, UNSHARE_REFUSAL) },
      { codex: false },
    );
    expect(probeCodexUserNamespace(host.dependencies)).toEqual({ outcome: "unknown" });
    expect(host.calls.map(([command]) => command)).toEqual(["bwrap"]);
  });

  test("without Codex or bwrap it falls back to unshare, whose refusal counts", () => {
    const host = fakeHost({ unshare: exited(1, UNSHARE_REFUSAL) }, { codex: false });
    expect(probeCodexUserNamespace(host.dependencies)).toEqual({
      outcome: "refused",
      detail: UNSHARE_REFUSAL,
    });
    expect(host.calls).toEqual([["unshare", ...UNSHARE_PROBE_ARGS]]);
  });

  test("unshare succeeding is unknown too", () => {
    const host = fakeHost({ unshare: exited(0) }, { codex: false });
    expect(probeCodexUserNamespace(host.dependencies)).toEqual({ outcome: "unknown" });
  });

  test("with no program to ask the answer is unknown and nothing runs", () => {
    const host = fakeHost({}, { codex: false });
    expect(probeCodexUserNamespace(host.dependencies)).toEqual({ outcome: "unknown" });
    expect(host.calls).toEqual([]);
  });

  test("inconclusive failures keep the sandbox on", () => {
    // Every helper fails without naming a refused namespace operation: the
    // probe must not read any of these as a refusal.
    for (const failure of [
      { status: null, error: "spawnSync bwrap ENOENT", stderr: "" },
      { status: null, signal: "SIGKILL", error: "spawnSync bwrap ETIMEDOUT", stderr: "" },
      { status: null, signal: "SIGTERM", stderr: "" },
      exited(1, "bwrap: execvp true: No such file or directory"),
    ] satisfies CodexUserNamespaceProbeRun[]) {
      const host = fakeHost({ codex: failure, bwrap: failure, unshare: failure });
      const answer = probeCodexUserNamespace(host.dependencies);
      expect(answer).toEqual({ outcome: "unknown" });
      resetCodexUserNamespaceProbeForTests();
      const refusal = codexUserNamespaceRefusal(0, () => answer);
      expect(refusal).toBeUndefined();
      expect(
        codexReadOnlyCommandSandboxOff({
          platform: "linux",
          inContainer: () => false,
          userNamespaceRefusal: () => refusal,
        }),
      ).toBeUndefined();
    }
  });
});

describe("codexUserNamespaceRefusal", () => {
  function countingProbe(answers: CodexUserNamespaceProbeAnswer[]) {
    let runs = 0;
    return {
      runs: () => runs,
      probe: () => answers[Math.min(runs++, answers.length - 1)] ?? { outcome: "unknown" as const },
    };
  }
  const refused = { outcome: "refused", detail: BWRAP_REFUSAL } as const;
  const allowed = { outcome: "allowed" } as const;

  test("a definite answer is shared until the TTL passes, then probed afresh", () => {
    const counter = countingProbe([refused, allowed]);
    expect(codexUserNamespaceRefusal(1_000, counter.probe)).toBe(BWRAP_REFUSAL);
    expect(
      codexUserNamespaceRefusal(1_000 + CODEX_USER_NAMESPACE_PROBE_TTL_MS - 1, counter.probe),
    ).toBe(BWRAP_REFUSAL);
    expect(counter.runs()).toBe(1);
    expect(
      codexUserNamespaceRefusal(1_000 + CODEX_USER_NAMESPACE_PROBE_TTL_MS, counter.probe),
    ).toBeUndefined();
    expect(counter.runs()).toBe(2);
  });

  test("an allowed answer is cached for the full TTL", () => {
    const counter = countingProbe([allowed, refused]);
    expect(codexUserNamespaceRefusal(0, counter.probe)).toBeUndefined();
    expect(
      codexUserNamespaceRefusal(CODEX_USER_NAMESPACE_PROBE_TTL_MS - 1, counter.probe),
    ).toBeUndefined();
    expect(counter.runs()).toBe(1);
  });

  test("an unknown answer is cached, but only for the shorter unknown TTL", () => {
    const counter = countingProbe([{ outcome: "unknown" }, refused]);
    expect(codexUserNamespaceRefusal(0, counter.probe)).toBeUndefined();
    expect(
      codexUserNamespaceRefusal(CODEX_USER_NAMESPACE_PROBE_UNKNOWN_TTL_MS - 1, counter.probe),
    ).toBeUndefined();
    expect(counter.runs()).toBe(1);
    expect(
      codexUserNamespaceRefusal(CODEX_USER_NAMESPACE_PROBE_UNKNOWN_TTL_MS, counter.probe),
    ).toBe(BWRAP_REFUSAL);
    expect(counter.runs()).toBe(2);
  });

  test("a clock that moved backwards probes again", () => {
    const counter = countingProbe([allowed, refused]);
    expect(codexUserNamespaceRefusal(10_000, counter.probe)).toBeUndefined();
    expect(codexUserNamespaceRefusal(9_999, counter.probe)).toBe(BWRAP_REFUSAL);
    expect(counter.runs()).toBe(2);
  });
});
