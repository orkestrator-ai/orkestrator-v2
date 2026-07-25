import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolchainArtifact } from "../../apps/desktop/electron/toolchain-manifest";
import {
  expectDigest,
  fetchArtifact,
  hashExecutable,
  parseArguments,
  parseFilters,
  validateDownloadUrl,
  verifyArtifact,
} from "../../scripts/verify-toolchain-artifacts";

function testArtifact(overrides: Partial<ToolchainArtifact> = {}): ToolchainArtifact {
  return {
    name: "codex",
    version: "1.2.3",
    platform: "linux",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: "https://downloads.example.test/codex.tar.gz",
      entryPath: "codex",
      size: 0,
      sha256: "0".repeat(64),
      allowedHosts: ["downloads.example.test"],
    },
    executable: {
      fileName: "codex",
      size: 0,
      sha256: "0".repeat(64),
    },
    ...overrides,
  };
}

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

  test("parses emit mode separately from filters in any position", () => {
    expect(parseArguments(["--emit", "--tool=codex"])).toEqual({
      emit: true,
      filters: { tool: "codex" },
    });
    expect(parseArguments(["--platform=linux", "--emit", "--arch=x64"])).toEqual({
      emit: true,
      filters: { platform: "linux", architecture: "x64" },
    });
    expect(parseArguments([])).toEqual({ emit: false, filters: {} });
  });

  test("rejects duplicate emit mode and unknown arguments", () => {
    expect(() => parseArguments(["--emit", "--emit"])).toThrow("Duplicate mode");
    expect(() => parseArguments(["--emit=true"])).toThrow("Unknown filter");
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

  test("follows allowlisted redirects and validates every hop", async () => {
    const requested: string[] = [];
    const response = await fetchArtifact(testArtifact(), async (input, init) => {
      requested.push(String(input));
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return requested.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "/release/codex.tar.gz" },
          })
        : new Response("archive");
    });

    expect(await response.text()).toBe("archive");
    expect(requested).toEqual([
      "https://downloads.example.test/codex.tar.gz",
      "https://downloads.example.test/release/codex.tar.gz",
    ]);

    await expect(fetchArtifact(testArtifact(), async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example/codex.tar.gz" },
      }))).rejects.toThrow("outside allowlist");
  });

  test("surfaces redirect, HTTP, and fetch failures", async () => {
    await expect(fetchArtifact(testArtifact(), async () =>
      new Response(null, { status: 302 }))).rejects.toThrow("omitted Location");
    await expect(fetchArtifact(testArtifact(), async () =>
      new Response("unavailable", { status: 503 }))).rejects.toThrow("HTTP 503");
    await expect(fetchArtifact(testArtifact(), async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new Error("request timed out");
    })).rejects.toThrow("request timed out");
  });

  test("hashes and verifies a complete local tar artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-artifact-test-"));
    try {
      const executable = Buffer.from("#!/bin/sh\nprintf 'ok\\n'\n");
      await writeFile(join(root, "codex"), executable);
      const archivePath = join(root, "fixture.tar.gz");
      const tar = Bun.spawn(["tar", "-czf", archivePath, "codex"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await tar.exited).toBe(0);
      const archive = await readFile(archivePath);
      const digest = (contents: Uint8Array) => ({
        size: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
      const archiveDigest = digest(archive);
      const executableDigest = digest(executable);
      const artifact = testArtifact({
        archive: {
          ...testArtifact().archive,
          ...archiveDigest,
        },
        executable: {
          ...testArtifact().executable,
          ...executableDigest,
        },
      });

      await verifyArtifact(artifact, root, {
        fetchImpl: async () => new Response(
          archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
        ),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports extraction failures from malformed archives", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-artifact-test-"));
    try {
      const archivePath = join(root, "invalid.tar.gz");
      await writeFile(archivePath, "not an archive");
      await expect(hashExecutable(testArtifact(), archivePath)).rejects.toThrow(
        "Could not extract codex",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
