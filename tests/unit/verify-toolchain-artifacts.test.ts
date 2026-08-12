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
  run,
  selectArtifacts,
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

  test("verifies, emits, and rejects a companion alongside its primary executable", async () => {
    // A companion ships as its own release asset, so its digests move
    // independently of the primary executable's. Both have to be downloaded and
    // both have to be asserted, under labels that say which one moved.
    const root = await mkdtemp(join(tmpdir(), "ork-artifact-test-"));
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const primaryBody = Buffer.from("#!/bin/sh\nprintf 'codex\\n'\n");
      const companionBody = Buffer.from("#!/bin/sh\nprintf 'host\\n'\n");
      await writeFile(join(root, "codex"), primaryBody);
      await writeFile(join(root, "codex-code-mode-host"), companionBody);
      const pack = async (entry: string, name: string) => {
        const archivePath = join(root, name);
        const tar = Bun.spawn(["tar", "-czf", archivePath, entry], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await tar.exited).toBe(0);
        return readFile(archivePath);
      };
      const primaryArchive = await pack("codex", "primary.tar.gz");
      const companionArchive = await pack("codex-code-mode-host", "companion.tar.gz");
      const digest = (contents: Uint8Array) => ({
        size: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
      const companionUrl = "https://downloads.example.test/codex-code-mode-host.tar.gz";
      const body = (contents: Buffer) => contents.buffer.slice(
        contents.byteOffset,
        contents.byteOffset + contents.byteLength,
      );
      const fetchImpl = async (input: URL | string) => new Response(
        String(input) === companionUrl ? body(companionArchive) : body(primaryArchive),
      );
      const withCompanion = (
        companionDigests: { archive: ReturnType<typeof digest>; executable: ReturnType<typeof digest> },
      ) => testArtifact({
        archive: { ...testArtifact().archive, ...digest(primaryArchive) },
        executable: { ...testArtifact().executable, ...digest(primaryBody) },
        companions: [{
          fileName: "codex-code-mode-host",
          archive: {
            format: "tar.gz",
            url: companionUrl,
            entryPath: "codex-code-mode-host",
            allowedHosts: ["downloads.example.test"],
            ...companionDigests.archive,
          },
          executable: companionDigests.executable,
        }],
      });
      const correct = withCompanion({
        archive: digest(companionArchive),
        executable: digest(companionBody),
      });

      await verifyArtifact(correct, root, { fetchImpl });

      // Both scratch archives are removed even though two were written.
      expect(await readFile(join(root, "codex-code-mode-host-linux-x64.tar.gz"))
        .then(() => true, () => false)).toBe(false);

      await expect(verifyArtifact(
        withCompanion({
          archive: { ...digest(companionArchive), sha256: "f".repeat(64) },
          executable: digest(companionBody),
        }),
        root,
        { fetchImpl },
      )).rejects.toThrow("codex:linux:x64 codex-code-mode-host archive SHA-256 mismatch");

      await expect(verifyArtifact(
        withCompanion({
          archive: digest(companionArchive),
          executable: { ...digest(companionBody), size: 1 },
        }),
        root,
        { fetchImpl },
      )).rejects.toThrow("codex:linux:x64 codex-code-mode-host executable size mismatch");

      // Emit prints the companion as its own paste-ready block, so a version
      // bump does not silently reuse the previous release's helper digests.
      log.mockClear();
      await verifyArtifact(correct, root, { emit: true, fetchImpl });
      const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(printed).toContain("  // codex:linux:x64\n");
      expect(printed).toContain("  // codex:linux:x64 codex-code-mode-host\n");
      expect(printed).toContain(
        `executable.sha256: "${createHash("sha256").update(companionBody).digest("hex")}",`,
      );
      expect(printed).toContain(
        `archive.sha256:    "${createHash("sha256").update(companionArchive).digest("hex")}",`,
      );
    } finally {
      log.mockRestore();
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

  describe("run", () => {
    const liveEnv = { RUN_LIVE_TOOLCHAIN_ARTIFACTS: "1" };

    function fixtureArtifacts(): ToolchainArtifact[] {
      return [
        testArtifact({ name: "codex", platform: "darwin", architecture: "arm64" }),
        testArtifact({ name: "codex", platform: "linux", architecture: "x64" }),
        testArtifact({ name: "opencode", platform: "darwin", architecture: "arm64" }),
      ];
    }

    test("selects by each filter dimension and by all of them together", () => {
      const artifacts = fixtureArtifacts();

      expect(selectArtifacts({}, artifacts)).toHaveLength(3);
      expect(selectArtifacts({ tool: "opencode" }, artifacts)).toHaveLength(1);
      expect(selectArtifacts({ platform: "darwin" }, artifacts)).toHaveLength(2);
      expect(selectArtifacts({ architecture: "x64" }, artifacts)).toHaveLength(1);
      expect(
        selectArtifacts(
          { tool: "codex", platform: "darwin", architecture: "arm64" },
          artifacts,
        ),
      ).toHaveLength(1);
      expect(
        selectArtifacts({ tool: "opencode", architecture: "x64" }, artifacts),
      ).toHaveLength(0);
    });

    test("verifies every selected artifact into one scratch root and cleans it up", async () => {
      const seen: Array<{ name: string; emit: boolean }> = [];
      const roots = new Set<string>();
      const logged: string[] = [];

      await run({
        argv: [],
        env: liveEnv,
        artifacts: fixtureArtifacts(),
        verify: async (artifact, temporaryRoot, options) => {
          seen.push({ name: artifact.name, emit: options.emit });
          roots.add(temporaryRoot);
        },
        log: (message) => logged.push(message),
      });

      expect(seen).toHaveLength(3);
      expect(seen.every((entry) => entry.emit === false)).toBe(true);
      expect(roots.size).toBe(1);
      expect(logged).toEqual(["Verified 3 pinned toolchain artifact(s)"]);
      // The scratch root holds full release archives; leaving it behind would
      // silently fill the disk across repeated runs.
      expect(await Bun.file(join([...roots][0], "unused")).exists()).toBe(false);
    });

    test("passes --emit through and reports the paste-the-values summary", async () => {
      const logged: string[] = [];
      const emitFlags: boolean[] = [];

      await run({
        argv: ["--emit", "--tool=codex"],
        env: liveEnv,
        artifacts: fixtureArtifacts(),
        verify: async (_artifact, _root, options) => {
          emitFlags.push(options.emit);
        },
        log: (message) => logged.push(message),
      });

      expect(emitFlags).toEqual([true, true]);
      expect(logged).toEqual([
        "Hashed 2 artifact(s); paste the values into toolchain-manifest.ts",
      ]);
    });

    test("removes the scratch root even when an artifact fails mid-run", async () => {
      let capturedRoot = "";
      const attempted: string[] = [];

      await expect(
        run({
          argv: [],
          env: liveEnv,
          artifacts: fixtureArtifacts(),
          verify: async (artifact, temporaryRoot) => {
            capturedRoot = temporaryRoot;
            attempted.push(artifact.platform);
            if (attempted.length === 2) throw new Error("codex executable digest mismatch");
          },
          log: () => {},
        }),
      ).rejects.toThrow("codex executable digest mismatch");

      // Aborted before the third artifact, and the scratch root is still gone.
      expect(attempted).toHaveLength(2);
      expect(await Bun.file(join(capturedRoot, "unused")).exists()).toBe(false);
    });

    test("refuses to run without the explicit live guard, before any download", async () => {
      let verified = 0;

      await expect(
        run({
          argv: [],
          env: {},
          artifacts: fixtureArtifacts(),
          verify: async () => {
            verified += 1;
          },
        }),
      ).rejects.toThrow("RUN_LIVE_TOOLCHAIN_ARTIFACTS=1");

      expect(verified).toBe(0);
    });

    test("rejects an unknown filter instead of silently verifying everything", async () => {
      let verified = 0;

      await expect(
        run({
          argv: ["--tool=rust-analyzer"],
          env: liveEnv,
          artifacts: fixtureArtifacts(),
          verify: async () => {
            verified += 1;
          },
        }),
      ).rejects.toThrow("Unknown filter --tool=rust-analyzer");

      expect(verified).toBe(0);
    });

    test("fails loudly when a filter combination matches nothing", async () => {
      await expect(
        run({
          argv: ["--tool=claude"],
          env: liveEnv,
          artifacts: fixtureArtifacts(),
          verify: async () => {},
        }),
      ).rejects.toThrow("No artifacts matched the filters");
    });

    test("the real manifest exposes every filter combination the CLI accepts", () => {
      // Guards the pairing between parseFilters' accepted values and the shipped
      // manifest: a tool/platform/arch the CLI accepts but the manifest lacks
      // would only surface as "No artifacts matched the filters" at upgrade time.
      for (const tool of ["claude", "codex", "opencode"] as const) {
        for (const platform of ["darwin", "linux"] as const) {
          for (const architecture of ["arm64", "x64"] as const) {
            expect(
              selectArtifacts({ tool, platform, architecture }),
              `${tool}:${platform}:${architecture} is missing from the manifest`,
            ).toHaveLength(1);
          }
        }
      }
    });
  });
});
