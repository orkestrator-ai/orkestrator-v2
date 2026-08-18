/**
 * Unit tests for the live-contract binary resolver.
 *
 * These run in the **default** suite: every seam that would need a real Codex
 * install is injected, so the failure paths a developer actually meets (no
 * binary, wrong version, hung probe) are covered even though
 * `live-contract.test.ts` itself is gated behind RUN_LIVE_CODEX_APP_SERVER.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_VERSION_PROBE_TIMEOUT_MS,
  managedBinaryPath,
  parseReportedVersion,
  pinnedVersion,
  resetResolvedCodexBinary,
  resolveCodexBinary,
  resolveCodexBinaryUncached,
  selectCodexBinary,
  type ResolveBinaryOptions,
  type VersionProbeResult,
} from "./live-binary.js";

const VERSION = "0.147.0";

/** Isolates every case from the developer's real environment and filesystem. */
const BASE: ResolveBinaryOptions = {
  env: {},
  platform: "darwin",
  architecture: "arm64",
  homeDirectory: "/home/tester",
  existsImpl: () => false,
};

function probeReturning(result: Partial<VersionProbeResult>) {
  const calls: Array<{ binary: string; timeoutMs: number }> = [];
  const probe = async (binary: string, timeoutMs: number): Promise<VersionProbeResult> => {
    calls.push({ binary, timeoutMs });
    return { stdout: `codex-cli ${VERSION}\n`, stderr: "", exitCode: 0, ...result };
  };
  return { probe, calls };
}

function resolveOptions(overrides: ResolveBinaryOptions = {}): ResolveBinaryOptions {
  return {
    ...BASE,
    readPinnedVersionImpl: async () => VERSION,
    ...overrides,
  };
}

describe("parseReportedVersion", () => {
  test("reads the real `codex --version` output", () => {
    expect(parseReportedVersion(`codex-cli ${VERSION}\n`)).toBe(VERSION);
  });

  test("ignores a trailing update notice instead of picking up its version", () => {
    // The whole point of not using `stdout.trim().split(/\s+/).at(-1)`: that
    // helper would report 9.9.9 and blame the binary for a version mismatch.
    const stdout = `codex-cli ${VERSION}\n\nA new version 9.9.9 is available!\n`;
    expect(parseReportedVersion(stdout)).toBe(VERSION);
  });

  test("skips leading blank lines", () => {
    expect(parseReportedVersion(`\n  \ncodex-cli ${VERSION}\n`)).toBe(VERSION);
  });

  test("accepts a prerelease suffix", () => {
    expect(parseReportedVersion("codex-cli 0.147.0-alpha.1\n")).toBe("0.147.0-alpha.1");
  });

  test("returns null for empty output", () => {
    expect(parseReportedVersion("")).toBeNull();
    expect(parseReportedVersion("   \n\n")).toBeNull();
  });

  test("returns null for output with no version in it", () => {
    expect(parseReportedVersion("codex-cli unknown\n")).toBeNull();
  });
});

describe("selectCodexBinary", () => {
  test("prefers CODEX_PROTOCOL_BINARY over everything else", () => {
    const selected = selectCodexBinary(VERSION, {
      ...BASE,
      env: { CODEX_PROTOCOL_BINARY: " /explicit/codex ", CODEX_PATH: "/configured/codex" },
      existsImpl: () => true,
    });
    expect(selected).toBe("/explicit/codex");
  });

  test("rejects a CODEX_PROTOCOL_BINARY path that does not exist", () => {
    expect(() =>
      selectCodexBinary(VERSION, {
        ...BASE,
        env: { CODEX_PROTOCOL_BINARY: "/missing/codex" },
      }),
    ).toThrow("CODEX_PROTOCOL_BINARY does not exist: /missing/codex");
  });

  test("falls back to the managed toolchain copy of the pinned version", () => {
    const managed = managedBinaryPath(VERSION, BASE);
    expect(managed).toBe(
      "/home/tester/Library/Application Support/orkestrator-v2/toolchains/codex/" +
        `${VERSION}/darwin-arm64/codex`,
    );
    const selected = selectCodexBinary(VERSION, {
      ...BASE,
      env: { CODEX_PATH: "/configured/codex" },
      existsImpl: (path) => path === managed,
    });
    expect(selected).toBe(managed);
  });

  test("uses CODEX_PATH when no managed copy is installed", () => {
    // CODEX_PATH is what process-supervisor.ts launches, so a developer whose
    // pinned binary lives there must not get a red suite.
    const selected = selectCodexBinary(VERSION, {
      ...BASE,
      env: { CODEX_PATH: " /configured/codex " },
      existsImpl: (path) => path === "/configured/codex",
    });
    expect(selected).toBe("/configured/codex");
  });

  test("skips a CODEX_PATH that points at a missing file", () => {
    const selected = selectCodexBinary(VERSION, {
      ...BASE,
      env: { CODEX_PATH: "/configured/codex" },
    });
    expect(selected).toBe("codex");
  });

  test("accepts a bare CODEX_PATH name without an existence check", () => {
    const selected = selectCodexBinary(VERSION, {
      ...BASE,
      env: { CODEX_PATH: "codex-nightly" },
    });
    expect(selected).toBe("codex-nightly");
  });

  test("falls back to `codex` on PATH", () => {
    expect(selectCodexBinary(VERSION, BASE)).toBe("codex");
  });

  test("builds the linux managed path from XDG_CONFIG_HOME", () => {
    expect(
      managedBinaryPath(VERSION, {
        platform: "linux",
        architecture: "x64",
        homeDirectory: "/home/tester",
        env: { XDG_CONFIG_HOME: "/xdg" },
      }),
    ).toBe(`/xdg/orkestrator-v2/toolchains/codex/${VERSION}/linux-x64/codex`);
  });

  test("reads process.env when no env is injected", () => {
    const previous = process.env.CODEX_PROTOCOL_BINARY;
    // A bare name, so the existence check never touches the filesystem.
    process.env.CODEX_PROTOCOL_BINARY = "codex-from-process-env";
    try {
      expect(selectCodexBinary(VERSION, { existsImpl: () => false })).toBe(
        "codex-from-process-env",
      );
    } finally {
      if (previous === undefined) delete process.env.CODEX_PROTOCOL_BINARY;
      else process.env.CODEX_PROTOCOL_BINARY = previous;
    }
  });
});

describe("resolveCodexBinaryUncached", () => {
  test("returns the binary when the reported version matches the pin", async () => {
    const { probe, calls } = probeReturning({});
    await expect(resolveCodexBinaryUncached(resolveOptions({ probeImpl: probe }))).resolves.toBe(
      "codex",
    );
    expect(calls).toEqual([{ binary: "codex", timeoutMs: DEFAULT_VERSION_PROBE_TIMEOUT_MS }]);
  });

  test("passes an overridden timeout through to the probe", async () => {
    const { probe, calls } = probeReturning({});
    await resolveCodexBinaryUncached(resolveOptions({ probeImpl: probe, timeoutMs: 25 }));
    expect(calls[0]?.timeoutMs).toBe(25);
  });

  test("adds pin context when the probe throws (missing binary)", async () => {
    // Bun.spawn throws "Executable not found in $PATH" rather than returning a
    // non-zero exit code, so this — not the exit-code branch — is the path a
    // developer without the toolchain hits.
    const error = await resolveCodexBinaryUncached(
      resolveOptions({
        probeImpl: async () => {
          throw new Error('Executable not found in $PATH: "codex"');
        },
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Could not execute codex");
    expect(message).toContain("Executable not found in $PATH");
    expect(message).toContain("config/codex-version.json pins codex 0.147.0");
    expect(message).toContain("CODEX_PATH");
  });

  test("reports a hung probe with the same pin context", async () => {
    const error = await resolveCodexBinaryUncached(
      resolveOptions({
        timeoutMs: 10,
        probeImpl: async (binary, timeoutMs) => {
          throw new Error(`\`${binary} --version\` did not respond within ${timeoutMs}ms`);
        },
      }),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("did not respond within 10ms");
    expect((error as Error).message).toContain("config/codex-version.json pins codex 0.147.0");
  });

  test("surfaces stderr when the probe exits non-zero", async () => {
    const { probe } = probeReturning({ exitCode: 2, stderr: "  permission denied\n" });
    const error = await resolveCodexBinaryUncached(resolveOptions({ probeImpl: probe })).catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("Could not execute codex: permission denied");
    expect((error as Error).message).toContain("pins codex 0.147.0");
  });

  test("describes a signal kill when there is no stderr and no exit code", async () => {
    const { probe } = probeReturning({ exitCode: null, stderr: "" });
    const error = await resolveCodexBinaryUncached(resolveOptions({ probeImpl: probe })).catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("exited with a signal");
  });

  test("refuses a binary whose version disagrees with the pin", async () => {
    const { probe } = probeReturning({ stdout: "codex-cli 0.145.0\n" });
    const error = await resolveCodexBinaryUncached(
      resolveOptions({
        probeImpl: probe,
        env: { CODEX_PATH: "codex-old" },
      }),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      "codex-old reports 0.145.0, but config/codex-version.json pins 0.147.0",
    );
  });

  test("says `an unknown version` when the output has no version in it", async () => {
    const { probe } = probeReturning({ stdout: "who knows\n" });
    const error = await resolveCodexBinaryUncached(resolveOptions({ probeImpl: probe })).catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toBe(
      "codex reports an unknown version, but config/codex-version.json pins 0.147.0",
    );
  });

  test("reads the real pin by default", async () => {
    // Guards the repo-root path arithmetic in live-binary.ts.
    expect(await pinnedVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("resolveCodexBinary memoisation", () => {
  beforeEach(() => {
    resetResolvedCodexBinary();
  });
  afterEach(() => {
    resetResolvedCodexBinary();
  });

  test("probes once no matter how many callers ask", async () => {
    let probes = 0;
    const options = resolveOptions({
      probeImpl: async () => {
        probes += 1;
        return { stdout: `codex-cli ${VERSION}\n`, stderr: "", exitCode: 0 };
      },
    });

    // Concurrent first, to prove the *promise* is cached rather than the value.
    const [a, b] = await Promise.all([resolveCodexBinary(options), resolveCodexBinary(options)]);
    const c = await resolveCodexBinary(options);

    expect([a, b, c]).toEqual(["codex", "codex", "codex"]);
    expect(probes).toBe(1);
  });

  test("caches a failure rather than re-spawning a broken binary", async () => {
    let probes = 0;
    const options = resolveOptions({
      probeImpl: async () => {
        probes += 1;
        throw new Error("Executable not found in $PATH");
      },
    });

    await expect(resolveCodexBinary(options)).rejects.toThrow("Could not execute codex");
    await expect(resolveCodexBinary(options)).rejects.toThrow("Could not execute codex");
    expect(probes).toBe(1);
  });

  test("resetResolvedCodexBinary re-arms the probe", async () => {
    let probes = 0;
    const options = resolveOptions({
      probeImpl: async () => {
        probes += 1;
        return { stdout: `codex-cli ${VERSION}\n`, stderr: "", exitCode: 0 };
      },
    });

    await resolveCodexBinary(options);
    resetResolvedCodexBinary();
    await resolveCodexBinary(options);
    expect(probes).toBe(2);
  });
});
