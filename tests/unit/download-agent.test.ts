/**
 * `scripts/download-agent.ts` replaced three hand-written shell downloaders,
 * each of which re-derived the manifest's URL, version and platform mapping in
 * bash. Those needed tests proving the copy still matched the manifest; this
 * one reads the manifest directly, so what is worth testing is different:
 * that it resolves the right artifact, refuses to install bytes that do not
 * match the pinned digests, and handles all four artifact shapes this repo
 * actually ships (plain entry, zip entry, raw file, bundle) plus companions.
 *
 * Nothing here touches the network.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PINNED_TOOLCHAIN_ARTIFACTS,
  PINNED_TOOLCHAIN_VERSIONS,
} from "../../apps/desktop/electron/toolchain-manifest";
import {
  downloadAgent,
  hostTarget,
  parseAgent,
  parseCliArguments,
  promotePaths,
} from "../../scripts/download-agent";
import { hashBundleIntegrity } from "../../scripts/verify-toolchain-artifacts";

const AGENT_NAMES = Object.keys(PINNED_TOOLCHAIN_VERSIONS);

/** A tar.gz containing one file at `entryPath`, built with the system tar. */
async function makeTarGz(root: string, entryPath: string, contents: string): Promise<string> {
  const staging = path.join(root, "src");
  const filePath = path.join(staging, entryPath);
  await Bun.write(filePath, contents);
  const archivePath = path.join(root, "fixture.tar.gz");
  const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", staging, entryPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await tar.exited).toBe(0);
  return archivePath;
}

function digestOf(contents: string) {
  const bytes = Buffer.from(contents);
  return { size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function digestBytes(contents: Uint8Array) {
  return {
    size: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function makeZip(root: string, entryPath: string, contents: string): Promise<string> {
  const staging = path.join(root, "zip-src");
  await Bun.write(path.join(staging, entryPath), contents);
  const archivePath = path.join(root, "fixture.zip");
  const zip = Bun.spawn(["zip", "-q", "-X", archivePath, entryPath], {
    cwd: staging,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await zip.exited).toBe(0);
  return archivePath;
}

async function makeBundleTarGz(root: string, launcher: string, guide: string): Promise<string> {
  const staging = path.join(root, "bundle-src");
  await Bun.write(path.join(staging, "pi", "pi"), launcher);
  await Bun.write(path.join(staging, "pi", "docs", "guide.md"), guide);
  const archivePath = path.join(root, "bundle.tar.gz");
  const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", staging, "pi"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await tar.exited).toBe(0);
  return archivePath;
}

describe("download-agent", () => {
  test("accepts exactly the agents the manifest pins", () => {
    for (const name of AGENT_NAMES) expect(parseAgent(name)).toBe(name as never);
    expect(() => parseAgent("nope")).toThrow(/Expected one of/);
    expect(() => parseAgent(undefined)).toThrow(/Expected one of/);
    // The failure names the valid set, because the alternative is a user
    // guessing at which of six spellings this command wants.
    expect(() => parseAgent("nope")).toThrow(new RegExp(AGENT_NAMES[0]!));
  });

  test("accepts both spellings of --dir and rejects anything else", () => {
    // `--dir=<path>` silently parsed as "no directory given" in the first
    // version of this parser, which installed into the repository's
    // `binaries/` while reporting the path the user asked for as fetched.
    expect(parseCliArguments(["grok"])).toEqual({ agent: "grok", directory: undefined });
    expect(parseCliArguments(["grok", "--dir", "/tmp/probe"])).toEqual({
      agent: "grok",
      directory: "/tmp/probe",
    });
    expect(parseCliArguments(["grok", "--dir=/tmp/probe"])).toEqual({
      agent: "grok",
      directory: "/tmp/probe",
    });
    // Order is not significant: `bun run download:agent -- --dir X grok` works.
    expect(parseCliArguments(["--dir", "/tmp/probe", "grok"])).toEqual({
      agent: "grok",
      directory: "/tmp/probe",
    });

    // A directory whose name happens to be an agent name is still a directory.
    expect(parseCliArguments(["--dir", "claude", "grok"])).toEqual({
      agent: "grok",
      directory: "claude",
    });

    // Silently ignoring an unknown flag is how a typo becomes a wrong install.
    expect(() => parseCliArguments(["grok", "--into", "/tmp/probe"])).toThrow(/Unknown option/);
    expect(() => parseCliArguments(["grok", "-d", "/tmp/probe"])).toThrow(/Unknown option/);
    expect(() => parseCliArguments(["grok", "--dir"])).toThrow(/--dir requires a directory path/);
    expect(() => parseCliArguments(["grok", "--dir="])).toThrow(/--dir requires a directory path/);
    expect(() => parseCliArguments(["grok", "--dir", "--other"])).toThrow(
      /--dir requires a directory path/,
    );
    expect(() => parseCliArguments(["grok", "codex"])).toThrow(/Unexpected extra argument: codex/);
    expect(() => parseCliArguments([])).toThrow(/Expected one of/);
    expect(() => parseCliArguments(["--dir", "/tmp/probe"])).toThrow(/Expected one of/);
  });

  test("maps the host onto the manifest's platform vocabulary", () => {
    expect(hostTarget("darwin", "arm64")).toEqual({ platform: "darwin", architecture: "arm64" });
    expect(hostTarget("linux", "x64")).toEqual({ platform: "linux", architecture: "x64" });
    expect(() => hostTarget("win32", "x64")).toThrow(/Unsupported platform/);
    expect(() => hostTarget("linux", "ia32")).toThrow(/Unsupported architecture/);
  });

  test("every pinned agent is resolvable on every supported target", () => {
    // The downloader can only install what the manifest describes, so a
    // missing entry is an agent that cannot be fetched on that host at all.
    for (const platform of ["darwin", "linux"] as const) {
      for (const architecture of ["arm64", "x64"] as const) {
        for (const name of AGENT_NAMES) {
          const artifact = PINNED_TOOLCHAIN_ARTIFACTS.find(
            (entry) =>
              entry.name === name &&
              entry.platform === platform &&
              entry.architecture === architecture,
          );
          expect(artifact, `${name} on ${platform}/${architecture}`).toBeDefined();
        }
      }
    }
  });

  test("installs a tar.gz entry and marks it executable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const contents = "#!/bin/sh\nprintf 'agent\\n'\n";
      const archivePath = await makeTarGz(root, "package/claude", contents);
      const archive = await readFile(archivePath);
      const destination = path.join(root, "out");

      const installed = await downloadAgent({
        agent: "claude",
        platform: "linux",
        architecture: "x64",
        directory: destination,
        log: () => undefined,
        artifacts: [
          {
            name: "claude",
            version: "9.9.9",
            platform: "linux",
            architecture: "x64",
            archive: {
              format: "tar.gz",
              url: "https://downloads.example.test/claude.tar.gz",
              entryPath: "package/claude",
              allowedHosts: ["downloads.example.test"],
              size: archive.byteLength,
              sha256: createHash("sha256").update(archive).digest("hex"),
            },
            executable: { fileName: "claude", ...digestOf(contents) },
          },
        ],
        fetchImpl: async () => new Response(new Uint8Array(archive)),
      });

      expect(installed).toBe(path.join(destination, "claude"));
      expect(await Bun.file(installed).text()).toBe(contents);
      // 0o755: the whole point of fetching it is to run it.
      expect((await stat(installed)).mode & 0o111).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("installs a zip entry, which every darwin OpenCode artifact uses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const contents = "#!/bin/sh\nprintf 'opencode\\n'\n";
      const archivePath = await makeZip(root, "opencode", contents);
      const archive = await readFile(archivePath);
      const destination = path.join(root, "out");

      const installed = await downloadAgent({
        agent: "opencode",
        platform: "linux",
        architecture: "x64",
        directory: destination,
        log: () => undefined,
        artifacts: [
          {
            name: "opencode",
            version: "9.9.9",
            platform: "linux",
            architecture: "x64",
            archive: {
              format: "zip",
              url: "https://downloads.example.test/opencode.zip",
              entryPath: "opencode",
              allowedHosts: ["downloads.example.test"],
              ...digestBytes(archive),
            },
            executable: { fileName: "opencode", ...digestOf(contents) },
          },
        ],
        fetchImpl: async () => new Response(new Uint8Array(archive)),
      });

      expect(await Bun.file(installed).text()).toBe(contents);
      expect((await stat(installed)).mode & 0o111).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an archive digest mismatch before extracting a matching executable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const contents = "#!/bin/sh\nprintf 'claude\\n'\n";
      const archivePath = await makeTarGz(root, "package/claude", contents);
      const archive = await readFile(archivePath);
      const destination = path.join(root, "out");
      await Bun.write(path.join(destination, "claude"), "previous installation");

      await expect(
        downloadAgent({
          agent: "claude",
          platform: "linux",
          architecture: "x64",
          directory: destination,
          log: () => undefined,
          artifacts: [
            {
              name: "claude",
              version: "9.9.9",
              platform: "linux",
              architecture: "x64",
              archive: {
                format: "tar.gz",
                url: "https://downloads.example.test/claude.tar.gz",
                entryPath: "package/claude",
                allowedHosts: ["downloads.example.test"],
                size: archive.byteLength,
                sha256: "f".repeat(64),
              },
              executable: { fileName: "claude", ...digestOf(contents) },
            },
          ],
          fetchImpl: async () => new Response(new Uint8Array(archive)),
        }),
      ).rejects.toThrow(/claude archive SHA-256 mismatch/);

      expect(await Bun.file(path.join(destination, "claude")).text()).toBe("previous installation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to install bytes that do not match the pinned digest", async () => {
    // The shell scripts this replaced fetched a URL and trusted the response.
    // A pinned digest that is never checked is decoration.
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const archivePath = await makeTarGz(root, "package/claude", "substituted payload");
      const archive = await readFile(archivePath);
      const destination = path.join(root, "out");

      await expect(
        downloadAgent({
          agent: "claude",
          platform: "linux",
          architecture: "x64",
          directory: destination,
          log: () => undefined,
          artifacts: [
            {
              name: "claude",
              version: "9.9.9",
              platform: "linux",
              architecture: "x64",
              archive: {
                format: "tar.gz",
                url: "https://downloads.example.test/claude.tar.gz",
                entryPath: "package/claude",
                allowedHosts: ["downloads.example.test"],
                size: archive.byteLength,
                sha256: createHash("sha256").update(archive).digest("hex"),
              },
              // What the manifest expected, which is not what arrived.
              executable: { fileName: "claude", ...digestOf("the expected payload") },
            },
          ],
          fetchImpl: async () => new Response(new Uint8Array(archive)),
        }),
      ).rejects.toThrow(/claude executable/);

      expect(await Bun.file(path.join(destination, "claude")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("installs a raw artifact as itself, which every Grok build is", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const contents = "#!/bin/sh\nprintf 'grok\\n'\n";
      const bytes = Buffer.from(contents);
      const destination = path.join(root, "out");

      const installed = await downloadAgent({
        agent: "grok",
        platform: "linux",
        architecture: "x64",
        directory: destination,
        log: () => undefined,
        artifacts: [
          {
            name: "grok",
            version: "9.9.9",
            platform: "linux",
            architecture: "x64",
            archive: {
              format: "raw",
              url: "https://downloads.example.test/grok-linux-x86_64",
              entryPath: "",
              allowedHosts: ["downloads.example.test"],
              ...digestOf(contents),
            },
            executable: { fileName: "grok", ...digestOf(contents) },
          },
        ],
        fetchImpl: async () => new Response(new Uint8Array(bytes)),
      });

      expect(await Bun.file(installed).text()).toBe(contents);
      expect((await stat(installed)).mode & 0o111).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates staging on the destination filesystem before promotion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const contents = "#!/bin/sh\nprintf 'grok\\n'\n";
      const bytes = Buffer.from(contents);
      const destination = path.join(root, "mounted-destination");
      await mkdir(destination, { recursive: true });
      let observedDestinationLocalStaging = false;

      await downloadAgent({
        agent: "grok",
        platform: "linux",
        architecture: "x64",
        directory: destination,
        log: () => undefined,
        artifacts: [
          {
            name: "grok",
            version: "9.9.9",
            platform: "linux",
            architecture: "x64",
            archive: {
              format: "raw",
              url: "https://downloads.example.test/grok-linux-x86_64",
              entryPath: "",
              allowedHosts: ["downloads.example.test"],
              ...digestBytes(bytes),
            },
            executable: { fileName: "grok", ...digestBytes(bytes) },
          },
        ],
        fetchImpl: async () => {
          const entries = await readdir(destination);
          const stagingName = entries.find((entry) => entry.startsWith(".ork-download-grok-"));
          expect(stagingName).toBeDefined();
          observedDestinationLocalStaging =
            (await stat(path.join(destination, stagingName!))).dev ===
            (await stat(destination)).dev;
          return new Response(new Uint8Array(bytes));
        },
      });

      expect(observedDestinationLocalStaging).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a non-zero version probe without replacing the installed executable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const contents = "#!/bin/sh\nprintf 'probe failed\\n' >&2\nexit 7\n";
      const bytes = Buffer.from(contents);
      const destination = path.join(root, "out");
      await Bun.write(path.join(destination, "grok"), "previous installation");

      await expect(
        downloadAgent({
          agent: "grok",
          platform: "linux",
          architecture: "x64",
          directory: destination,
          log: () => undefined,
          artifacts: [
            {
              name: "grok",
              version: "9.9.9",
              platform: "linux",
              architecture: "x64",
              archive: {
                format: "raw",
                url: "https://downloads.example.test/grok-linux-x86_64",
                entryPath: "",
                allowedHosts: ["downloads.example.test"],
                ...digestBytes(bytes),
              },
              executable: { fileName: "grok", ...digestBytes(bytes) },
            },
          ],
          fetchImpl: async () => new Response(new Uint8Array(bytes)),
        }),
      ).rejects.toThrow(/grok --version exited 7: probe failed/);

      expect(await Bun.file(path.join(destination, "grok")).text()).toBe("previous installation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a version probe that cannot spawn without replacing the installed executable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const contents = "#!/definitely-not-present/orkestrator\n";
      const bytes = Buffer.from(contents);
      const destination = path.join(root, "out");
      await Bun.write(path.join(destination, "grok"), "previous installation");

      await expect(
        downloadAgent({
          agent: "grok",
          platform: "linux",
          architecture: "x64",
          directory: destination,
          log: () => undefined,
          artifacts: [
            {
              name: "grok",
              version: "9.9.9",
              platform: "linux",
              architecture: "x64",
              archive: {
                format: "raw",
                url: "https://downloads.example.test/grok-linux-x86_64",
                entryPath: "",
                allowedHosts: ["downloads.example.test"],
                ...digestBytes(bytes),
              },
              executable: { fileName: "grok", ...digestBytes(bytes) },
            },
          ],
          fetchImpl: async () => new Response(new Uint8Array(bytes)),
        }),
      ).rejects.toThrow(/Could not run grok --version/);

      expect(await Bun.file(path.join(destination, "grok")).text()).toBe("previous installation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("times out a hung version probe without replacing the installed executable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const contents = "#!/bin/sh\nwhile :; do :; done\n";
      const bytes = Buffer.from(contents);
      const destination = path.join(root, "out");
      await Bun.write(path.join(destination, "grok"), "previous installation");

      await expect(
        downloadAgent({
          agent: "grok",
          platform: "linux",
          architecture: "x64",
          directory: destination,
          log: () => undefined,
          versionProbeTimeoutMs: 50,
          artifacts: [
            {
              name: "grok",
              version: "9.9.9",
              platform: "linux",
              architecture: "x64",
              archive: {
                format: "raw",
                url: "https://downloads.example.test/grok-linux-x86_64",
                entryPath: "",
                allowedHosts: ["downloads.example.test"],
                ...digestBytes(bytes),
              },
              executable: { fileName: "grok", ...digestBytes(bytes) },
            },
          ],
          fetchImpl: async () => new Response(new Uint8Array(bytes)),
        }),
      ).rejects.toThrow(/grok --version timed out after 50ms/);

      expect(await Bun.file(path.join(destination, "grok")).text()).toBe("previous installation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a bundle's tree intact rather than extracting one file", async () => {
    // Cursor and Pi load themes, helpers and grammars from beside the
    // launcher, so a downloader that lifted out only the executable would
    // produce something that starts and then fails on its first real call.
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const launcher = "#!/bin/sh\nprintf 'pi\\n'\n";
      const archivePath = await makeBundleTarGz(root, launcher, "# guide");
      const archive = await readFile(archivePath);
      const destination = path.join(root, "out");
      const archiveDescriptor = {
        format: "tar.gz" as const,
        url: "https://downloads.example.test/pi-linux-x64.tar.gz",
        entryPath: "pi/pi",
        bundleRoot: "pi/",
        allowedHosts: ["downloads.example.test"],
        ...digestBytes(archive),
      };
      const bundleIntegrity = await hashBundleIntegrity(archiveDescriptor, archivePath);

      const installed = await downloadAgent({
        agent: "pi",
        platform: "linux",
        architecture: "x64",
        directory: destination,
        log: () => undefined,
        artifacts: [
          {
            name: "pi",
            version: "9.9.9",
            platform: "linux",
            architecture: "x64",
            archive: {
              ...archiveDescriptor,
              bundleIntegrity,
            },
            executable: { fileName: "pi", ...digestOf(launcher) },
          },
        ],
        fetchImpl: async () => new Response(new Uint8Array(archive)),
      });

      expect(await Bun.file(installed).text()).toBe(launcher);
      // The sibling file is the whole reason this is a bundle.
      expect(await Bun.file(path.join(destination, "pi-bundle", "docs", "guide.md")).text()).toBe(
        "# guide",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a modified bundle sibling while preserving the installed bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const launcher = "#!/bin/sh\nprintf 'pi\\n'\n";
      const trustedArchivePath = await makeBundleTarGz(
        path.join(root, "trusted"),
        launcher,
        "trusted guide",
      );
      const trustedArchive = await readFile(trustedArchivePath);
      const trustedDescriptor = {
        format: "tar.gz" as const,
        url: "https://downloads.example.test/pi-linux-x64.tar.gz",
        entryPath: "pi/pi",
        bundleRoot: "pi/",
        allowedHosts: ["downloads.example.test"],
        ...digestBytes(trustedArchive),
      };
      const bundleIntegrity = await hashBundleIntegrity(trustedDescriptor, trustedArchivePath);

      const modifiedArchivePath = await makeBundleTarGz(
        path.join(root, "modified"),
        launcher,
        "modified runtime content",
      );
      const modifiedArchive = await readFile(modifiedArchivePath);
      const destination = path.join(root, "out");
      await Bun.write(path.join(destination, "pi-bundle", "pi"), "previous launcher");
      await Bun.write(path.join(destination, "pi-bundle", "docs", "guide.md"), "previous guide");

      await expect(
        downloadAgent({
          agent: "pi",
          platform: "linux",
          architecture: "x64",
          directory: destination,
          log: () => undefined,
          artifacts: [
            {
              name: "pi",
              version: "9.9.9",
              platform: "linux",
              architecture: "x64",
              archive: {
                ...trustedDescriptor,
                ...digestBytes(modifiedArchive),
                bundleIntegrity,
              },
              executable: { fileName: "pi", ...digestOf(launcher) },
            },
          ],
          fetchImpl: async () => new Response(new Uint8Array(modifiedArchive)),
        }),
      ).rejects.toThrow(/pi bundle integrity mismatch/);

      expect(await Bun.file(path.join(destination, "pi-bundle", "pi")).text()).toBe(
        "previous launcher",
      );
      expect(await Bun.file(path.join(destination, "pi-bundle", "docs", "guide.md")).text()).toBe(
        "previous guide",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("installs a companion beside the primary executable", async () => {
    // Codex spawns `codex-code-mode-host` from its own directory, so a bundle
    // without it breaks every model that defaults to code mode.
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const primary = "#!/bin/sh\nprintf 'codex\\n'\n";
      const helper = "#!/bin/sh\nprintf 'host\\n'\n";
      const primaryArchivePath = await makeTarGz(root, "codex-x86_64", primary);
      const primaryArchive = await readFile(primaryArchivePath);
      const helperRoot = await mkdtemp(path.join(tmpdir(), "ork-dl-companion-"));
      const helperArchivePath = await makeTarGz(helperRoot, "codex-code-mode-host-x86_64", helper);
      const helperArchive = await readFile(helperArchivePath);
      const destination = path.join(root, "out");

      await downloadAgent({
        agent: "codex",
        platform: "linux",
        architecture: "x64",
        directory: destination,
        log: () => undefined,
        artifacts: [
          {
            name: "codex",
            version: "9.9.9",
            platform: "linux",
            architecture: "x64",
            archive: {
              format: "tar.gz",
              url: "https://downloads.example.test/codex.tar.gz",
              entryPath: "codex-x86_64",
              allowedHosts: ["downloads.example.test"],
              size: primaryArchive.byteLength,
              sha256: createHash("sha256").update(primaryArchive).digest("hex"),
            },
            executable: { fileName: "codex", ...digestOf(primary) },
            companions: [
              {
                fileName: "codex-code-mode-host",
                archive: {
                  format: "tar.gz",
                  url: "https://downloads.example.test/codex-host.tar.gz",
                  entryPath: "codex-code-mode-host-x86_64",
                  allowedHosts: ["downloads.example.test"],
                  size: helperArchive.byteLength,
                  sha256: createHash("sha256").update(helperArchive).digest("hex"),
                },
                executable: { fileName: "codex-code-mode-host", ...digestOf(helper) },
              },
            ],
          },
        ],
        fetchImpl: async (input) =>
          new Response(
            new Uint8Array(String(input).includes("codex-host") ? helperArchive : primaryArchive),
          ),
      });

      expect(await Bun.file(path.join(destination, "codex")).text()).toBe(primary);
      expect(await Bun.file(path.join(destination, "codex-code-mode-host")).text()).toBe(helper);
      await rm(helperRoot, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("promotePaths", () => {
    /**
     * A staging tree holding `install/<name>` for each named file, beside a
     * destination directory. Mirrors the layout `downloadAgent` builds.
     */
    async function stage(
      root: string,
      staged: Record<string, string>,
      existing: Record<string, string>,
    ): Promise<{ staging: string; destination: string }> {
      const staging = path.join(root, "staging");
      const destination = path.join(root, "out");
      await mkdir(path.join(staging, "install"), { recursive: true });
      await mkdir(destination, { recursive: true });
      for (const [name, contents] of Object.entries(staged)) {
        await Bun.write(path.join(staging, "install", name), contents);
      }
      for (const [name, contents] of Object.entries(existing)) {
        await Bun.write(path.join(destination, name), contents);
      }
      return { staging, destination };
    }

    test("restores every previous file when a later promotion fails", async () => {
      // Codex promotes two paths: the binary and the code-mode host it spawns
      // from its own directory. Half-promoting them leaves an install whose
      // helper is from a different release than the binary that spawns it.
      const root = await mkdtemp(path.join(tmpdir(), "ork-promote-test-"));
      try {
        const { staging, destination } = await stage(
          root,
          { codex: "new codex" },
          { codex: "old codex", "codex-code-mode-host": "old host" },
        );

        await expect(
          promotePaths(
            [
              {
                source: path.join(staging, "install", "codex"),
                destination: path.join(destination, "codex"),
              },
              // Never staged, so its rename fails after the first succeeded.
              {
                source: path.join(staging, "install", "codex-code-mode-host"),
                destination: path.join(destination, "codex-code-mode-host"),
              },
            ],
            staging,
          ),
        ).rejects.toThrow(/ENOENT/);

        expect(await Bun.file(path.join(destination, "codex")).text()).toBe("old codex");
        expect(await Bun.file(path.join(destination, "codex-code-mode-host")).text()).toBe(
          "old host",
        );
        // The staged file goes back where it came from, so the `finally` that
        // deletes staging is what cleans it up rather than the destination.
        expect(await Bun.file(path.join(staging, "install", "codex")).text()).toBe("new codex");
        expect((await readdir(staging)).filter((entry) => entry.startsWith(".previous-"))).toEqual(
          [],
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("leaves a first-time install absent rather than half-promoted", async () => {
      // The `existed: false` branch: nothing was backed up because nothing was
      // there, so rollback must not conjure a file the destination never had.
      const root = await mkdtemp(path.join(tmpdir(), "ork-promote-test-"));
      try {
        const { staging, destination } = await stage(root, { codex: "new codex" }, {});

        await expect(
          promotePaths(
            [
              {
                source: path.join(staging, "install", "codex"),
                destination: path.join(destination, "codex"),
              },
              {
                source: path.join(staging, "install", "codex-code-mode-host"),
                destination: path.join(destination, "codex-code-mode-host"),
              },
            ],
            staging,
          ),
        ).rejects.toThrow(/ENOENT/);

        expect(await Bun.file(path.join(destination, "codex")).exists()).toBe(false);
        expect(await Bun.file(path.join(destination, "codex-code-mode-host")).exists()).toBe(false);
        expect(await readdir(destination)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("promotes every path and discards the backups on success", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "ork-promote-test-"));
      try {
        const { staging, destination } = await stage(
          root,
          { codex: "new codex", "codex-code-mode-host": "new host" },
          { codex: "old codex" },
        );

        await promotePaths(
          [
            {
              source: path.join(staging, "install", "codex"),
              destination: path.join(destination, "codex"),
            },
            {
              source: path.join(staging, "install", "codex-code-mode-host"),
              destination: path.join(destination, "codex-code-mode-host"),
            },
          ],
          staging,
        );

        expect(await Bun.file(path.join(destination, "codex")).text()).toBe("new codex");
        expect(await Bun.file(path.join(destination, "codex-code-mode-host")).text()).toBe(
          "new host",
        );
        // A retained backup is a second copy of a ~250MB binary per download.
        expect((await readdir(staging)).filter((entry) => entry.startsWith(".previous-"))).toEqual(
          [],
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
