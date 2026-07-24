import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  expectDigest,
  parseFilters,
  validateDownloadUrl,
} from "../../scripts/verify-toolchain-artifacts";

describe("verify-toolchain-artifacts", () => {
  test("parses supported filters independently and together", () => {
    expect(parseFilters([])).toEqual({});
    expect(parseFilters([
      "--tool=codex",
      "--platform=linux",
      "--arch=arm64",
    ])).toEqual({
      tool: "codex",
      platform: "linux",
      architecture: "arm64",
    });
  });

  for (const argument of [
    "--tool",
    "--tool=unknown",
    "--tool=claude=unexpected",
    "--platform=windows",
    "--arch=ia32",
    "--unknown=value",
  ]) {
    test(`rejects malformed filter ${argument}`, () => {
      expect(() => parseFilters([argument])).toThrow("Unknown filter");
    });
  }

  test("accepts HTTPS downloads from an explicitly allowed host", () => {
    expect(() => validateDownloadUrl(
      new URL("https://downloads.example.test/tool.tar.gz"),
      ["downloads.example.test"],
    )).not.toThrow();
  });

  test("rejects non-HTTPS and non-allowlisted artifact URLs", () => {
    expect(() => validateDownloadUrl(
      new URL("http://downloads.example.test/tool.tar.gz"),
      ["downloads.example.test"],
    )).toThrow("Refusing non-HTTPS");
    expect(() => validateDownloadUrl(
      new URL("https://redirect.example.test/tool.tar.gz"),
      ["downloads.example.test"],
    )).toThrow("outside allowlist");
  });

  test("accepts exact digests and describes size or checksum mismatches", () => {
    const expected = { size: 4, sha256: "a".repeat(64) };
    expect(() => expectDigest("artifact", expected, expected)).not.toThrow();
    expect(() => expectDigest(
      "artifact",
      { ...expected, size: 3 },
      expected,
    )).toThrow("size mismatch");
    expect(() => expectDigest(
      "artifact",
      { ...expected, sha256: "b".repeat(64) },
      expected,
    )).toThrow("SHA-256 mismatch");
  });

  test("CLI refuses downloads unless the live verification guard is explicit", async () => {
    const scriptPath = join(import.meta.dir, "..", "..", "scripts", "verify-toolchain-artifacts.ts");
    const child = Bun.spawn([process.execPath, scriptPath], {
      env: {
        ...process.env,
        RUN_LIVE_TOOLCHAIN_ARTIFACTS: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("RUN_LIVE_TOOLCHAIN_ARTIFACTS=1");
  });
});
