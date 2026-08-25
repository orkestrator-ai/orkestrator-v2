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
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PINNED_TOOLCHAIN_ARTIFACTS,
  PINNED_TOOLCHAIN_VERSIONS,
} from "../../apps/desktop/electron/toolchain-manifest";
import { downloadAgent, hostTarget, parseAgent } from "../../scripts/download-agent";

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

describe("download-agent", () => {
  test("accepts exactly the agents the manifest pins", () => {
    for (const name of AGENT_NAMES) expect(parseAgent(name)).toBe(name as never);
    expect(() => parseAgent("nope")).toThrow(/Expected one of/);
    expect(() => parseAgent(undefined)).toThrow(/Expected one of/);
    // The failure names the valid set, because the alternative is a user
    // guessing at which of six spellings this command wants.
    expect(() => parseAgent("nope")).toThrow(new RegExp(AGENT_NAMES[0]!));
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

  test("keeps a bundle's tree intact rather than extracting one file", async () => {
    // Cursor and Pi load themes, helpers and grammars from beside the
    // launcher, so a downloader that lifted out only the executable would
    // produce something that starts and then fails on its first real call.
    const root = await mkdtemp(path.join(tmpdir(), "ork-dl-test-"));
    try {
      const launcher = "#!/bin/sh\nprintf 'pi\\n'\n";
      const staging = path.join(root, "src");
      await Bun.write(path.join(staging, "pi", "pi"), launcher);
      await Bun.write(path.join(staging, "pi", "docs", "guide.md"), "# guide");
      const archivePath = path.join(root, "fixture.tar.gz");
      const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", staging, "pi"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await tar.exited).toBe(0);
      const archive = await readFile(archivePath);
      const destination = path.join(root, "out");

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
              format: "tar.gz",
              url: "https://downloads.example.test/pi-linux-x64.tar.gz",
              entryPath: "pi/pi",
              bundleRoot: "pi/",
              allowedHosts: ["downloads.example.test"],
              size: archive.byteLength,
              sha256: createHash("sha256").update(archive).digest("hex"),
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
});
