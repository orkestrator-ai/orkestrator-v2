import { describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
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
    // A 2xx with no body would otherwise reach `pipeline()` as null.
    await expect(fetchArtifact(testArtifact(), async () =>
      new Response(null, { status: 204 }))).rejects.toThrow("HTTP 204");
  });

  test("gives up on an endless redirect chain instead of looping forever", async () => {
    let requests = 0;
    await expect(fetchArtifact(testArtifact(), async () => {
      requests += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `/hop-${requests}` },
      });
    })).rejects.toThrow("exceeded 10 redirects");
    // The bound is inclusive of the first request: 1 + MAX_REDIRECTS attempts.
    expect(requests).toBe(11);
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

  test("rejects an archive or executable whose digest moved", async () => {
    // expectDigest is exercised in isolation elsewhere; this pins that
    // verifyArtifact actually calls it, with the archive and the executable
    // expectations the right way round.
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
      const fetchImpl = async () => new Response(
        archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
      );
      const base = testArtifact();

      // Wrong archive digest, correct executable digest.
      await expect(verifyArtifact(
        testArtifact({
          archive: { ...base.archive, size: archive.byteLength, sha256: "f".repeat(64) },
          executable: { ...base.executable, ...digest(executable) },
        }),
        root,
        { fetchImpl },
      )).rejects.toThrow("codex:linux:x64 archive SHA-256 mismatch");

      // Correct archive digest, wrong executable size.
      await expect(verifyArtifact(
        testArtifact({
          archive: { ...base.archive, ...digest(archive) },
          executable: { ...base.executable, ...digest(executable), size: 1 },
        }),
        root,
        { fetchImpl },
      )).rejects.toThrow("codex:linux:x64 executable size mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emit mode prints manifest-shaped digests instead of asserting them", async () => {
    // These lines are pasted straight into toolchain-manifest.ts during a
    // version bump, so the `_` separators and field names are a contract.
    const root = await mkdtemp(join(tmpdir(), "ork-artifact-test-"));
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      // Incompressible, so the archive is comfortably over four digits too.
      const executable = randomBytes(20_000);
      await writeFile(join(root, "codex"), executable);
      const archivePath = join(root, "fixture.tar.gz");
      const tar = Bun.spawn(["tar", "-czf", archivePath, "codex"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await tar.exited).toBe(0);
      const archive = await readFile(archivePath);

      // Digests are deliberately wrong: emit must not assert them.
      await verifyArtifact(testArtifact(), root, {
        emit: true,
        fetchImpl: async () => new Response(
          archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
        ),
      });

      const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(printed).toContain("Hashing codex:linux:x64 1.2.3");
      expect(printed).toContain("  // codex:linux:x64");
      expect(printed).toContain("executable.size:   20_000,");
      expect(printed).toContain(
        `executable.sha256: "${createHash("sha256").update(executable).digest("hex")}",`,
      );
      expect(printed).toContain(
        `archive.sha256:    "${createHash("sha256").update(archive).digest("hex")}",`,
      );
      // Grouped in threes with `_`, never `,` — a comma would not compile.
      expect(printed).toMatch(/archive\.size:      \d{1,3}(?:_\d{3})+,/);
      expect(printed).not.toMatch(/size:\s+\d+,\d/);
    } finally {
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hashes the executable out of a zip archive, which every darwin OpenCode build is", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-artifact-test-"));
    try {
      const executable = Buffer.from("#!/bin/sh\nprintf 'opencode\\n'\n");
      await writeFile(join(root, "opencode"), executable);
      const archivePath = join(root, "fixture.zip");
      const zip = Bun.spawn(["zip", "-q", "-X", archivePath, "opencode"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await zip.exited).toBe(0);
      const archive = await readFile(archivePath);
      const digest = (contents: Uint8Array) => ({
        size: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
      const artifact = testArtifact({
        name: "opencode",
        platform: "darwin",
        architecture: "arm64",
        archive: {
          format: "zip",
          url: "https://downloads.example.test/opencode.zip",
          entryPath: "opencode",
          allowedHosts: ["downloads.example.test"],
          ...digest(archive),
        },
        executable: { fileName: "opencode", ...digest(executable) },
      });

      // `unzip -p` rather than `tar -xOzf`: the archive is not a tarball.
      expect(await hashExecutable(artifact, archivePath)).toEqual(digest(executable));
      await verifyArtifact(artifact, root, {
        fetchImpl: async () => new Response(
          archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
        ),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a response that loses its body before it is streamed to disk", async () => {
    // Defence in depth: fetchArtifact already rejects a body-less response, so
    // this guard only fires if that ever stops holding. Proving it throws is
    // cheaper than discovering `Readable.fromWeb(null)` in a release.
    const root = await mkdtemp(join(tmpdir(), "ork-artifact-test-"));
    try {
      const source = new Response("archive");
      let reads = 0;
      const vanishing = {
        status: 200,
        ok: true,
        get body() {
          reads += 1;
          return reads === 1 ? source.body : null;
        },
        headers: source.headers,
      } as unknown as Response;

      await expect(verifyArtifact(testArtifact(), root, { fetchImpl: async () => vanishing }))
        .rejects.toThrow("Artifact response omitted a body");
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
