import { afterEach, describe, expect, mock, test } from "bun:test";
import type { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import * as tar from "../../../apps/desktop/node_modules/tar-stream";
import {
  ensurePinnedToolchains,
  type ToolchainProgress,
} from "../../../apps/desktop/electron/toolchain-manager";
import {
  pinnedToolchainArtifacts,
  type ToolchainArtifact,
  type ToolchainCompanion,
} from "../../../apps/desktop/electron/toolchain-manifest";

const ZIP_FIXTURE = Buffer.from(
  "UEsDBAoAAAAAADMD8VyEaD1TIAAAACAAAAAEAAAAdG9vbCMhL2Jpbi9zaApwcmludGYgInRvb2wgMS4yLjNcbiIKUEsBAh4DCgAAAAAAMwPxXIRoPVMgAAAAIAAAAAQAAAAAAAAAAQABAECBAAAAAHRvb2xQSwUGAAAAAAEAAQAyAAAAQgAAAAAA",
  "base64",
);
const TAR_GZIP_FIXTURE = Buffer.from(
  "H4sIAAAAAAAAA+3SPQ7CMAwF4M49hSl7Y5skvQxLgAaqorRK0oHb0x8JscAWIaR8y1ss61nyaM69ubYiDsO9SAQRFSIs2Wi1JrLcciURSDFr1pI0AZKUDReAqQq9m0I0fq5ifG8el3YKH+bmMWu/7NkugVf+if1OnDonwq0cfeeihWr5BKCa68PRVeWv+2VZlmVpPAEa1a7GAAgAAA==",
  "base64",
);

const EXECUTABLE_SIZE = 32;
const EXECUTABLE_SHA256 = "5ebb049f9635fcc8d8ab581cb4aee2537ce8ba24abc3281bcd77f8ecd1c53247";
const directories: string[] = [];

const artifacts: readonly ToolchainArtifact[] = [
  {
    name: "codex",
    version: "1.2.3",
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "zip",
      url: "https://downloads.example.test/codex.zip",
      entryPath: "tool",
      size: ZIP_FIXTURE.byteLength,
      sha256: "5f6783d3c05437cfc6a2a58174e1ae52c8942db50e35b27fa49588a629378712",
      allowedHosts: ["downloads.example.test"],
    },
    executable: {
      fileName: "codex",
      size: EXECUTABLE_SIZE,
      sha256: EXECUTABLE_SHA256,
    },
  },
  {
    name: "claude",
    version: "1.2.3",
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: "https://downloads.example.test/claude.tar.gz",
      entryPath: "package/tool",
      size: TAR_GZIP_FIXTURE.byteLength,
      sha256: "cb411a592c9659abaf97469bd5d5640e21577364702847e71598c79c4f3a4f8d",
      allowedHosts: ["downloads.example.test"],
    },
    executable: {
      fileName: "claude",
      size: EXECUTABLE_SIZE,
      sha256: EXECUTABLE_SHA256,
    },
  },
];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createDataDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-toolchains-"));
  directories.push(directory);
  return directory;
}

function createFetch() {
  return mock(async (input: string) => {
    const body = input.endsWith(".zip") ? ZIP_FIXTURE : TAR_GZIP_FIXTURE;
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(body.byteLength) },
    });
  });
}

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function response(body: BodyInit | null, options: ResponseInit & { url?: string } = {}): Response {
  const result = new Response(body, options);
  if (options.url) Object.defineProperty(result, "url", { value: options.url });
  return result;
}

function artifactWithBody(
  base: ToolchainArtifact,
  body: Buffer,
  archive: Partial<ToolchainArtifact["archive"]> = {},
  executable: Partial<ToolchainArtifact["executable"]> = {},
): ToolchainArtifact {
  return {
    ...base,
    archive: {
      ...base.archive,
      size: body.byteLength,
      sha256: sha256(body),
      ...archive,
    },
    executable: { ...base.executable, ...executable },
  };
}

async function tarGzip(entries: Array<{ name: string; body: Buffer; type?: "file" | "directory" }>): Promise<Buffer> {
  const pack = tar.pack();
  const collecting = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of pack) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  })();
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({
        name: entry.name,
        size: entry.body.byteLength,
        type: entry.type ?? "file",
      }, entry.body, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  pack.finalize();
  return gzipSync(await collecting);
}

function storedZip(entries: Array<{ name: string; body: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc32 = Bun.hash.crc32(entry.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32, 14);
    local.writeUInt32LE(entry.body.byteLength, 18);
    local.writeUInt32LE(entry.body.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, entry.body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32, 16);
    central.writeUInt32LE(entry.body.byteLength, 20);
    central.writeUInt32LE(entry.body.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.byteLength + name.byteLength + entry.body.byteLength;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const COMPANION_ARCHIVE_URL = "https://downloads.example.test/codex-host.tar.gz";
const COMPANION_BODY = Buffer.from("#!/bin/sh\nprintf \"host 1.2.3\\n\"\n");

/** `artifacts[0]` plus one companion, the shape the Codex code-mode host uses. */
function companionArtifact(
  base: ToolchainArtifact,
  companionArchive: Buffer,
  companionBody: Buffer,
  overrides: {
    fileName?: string;
    format?: "tar.gz" | "zip";
    url?: string;
    entryPath?: string;
  } = {},
): ToolchainArtifact {
  return {
    ...base,
    companions: [{
      fileName: overrides.fileName ?? "codex-host",
      archive: {
        format: overrides.format ?? "tar.gz",
        url: overrides.url ?? COMPANION_ARCHIVE_URL,
        entryPath: overrides.entryPath ?? "tool-host",
        size: companionArchive.byteLength,
        sha256: sha256(companionArchive),
        allowedHosts: ["downloads.example.test"],
      },
      executable: {
        size: companionBody.byteLength,
        sha256: sha256(companionBody),
      },
    }],
  };
}

function createCompanionFetch(companionArchive: Buffer, companionUrl = COMPANION_ARCHIVE_URL) {
  return mock(async (input: string) => {
    const body = input === companionUrl ? companionArchive : ZIP_FIXTURE;
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(body.byteLength) },
    });
  });
}

/** URLs a fetch mock was asked for, in call order. */
function requestedUrls(fetchImpl: ReturnType<typeof createCompanionFetch>): string[] {
  return fetchImpl.mock.calls.map((call) => String(call[0]));
}

type SpawnOutcome =
  | { type: "exit"; code: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string }
  | { type: "error"; error: Error }
  | { type: "timeout" };

function createSpawn(outcomes: SpawnOutcome[]): typeof spawn {
  let call = 0;
  return mock(() => {
    const outcome = outcomes[call++];
    if (!outcome) throw new Error(`Unexpected spawn call ${call}`);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof mock>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = mock(() => true);
    queueMicrotask(() => {
      if (outcome.type === "exit") {
        if (outcome.stdout) child.stdout.write(outcome.stdout);
        if (outcome.stderr) child.stderr.write(outcome.stderr);
        child.emit("exit", outcome.code, outcome.signal ?? null);
      } else if (outcome.type === "error") {
        child.emit("error", outcome.error);
      }
    });
    return child;
  }) as unknown as typeof spawn;
}

describe("pinned desktop toolchain cache", () => {
  test("activates the pinned Cursor bundle under the cursor-agent command", () => {
    const cursor = pinnedToolchainArtifacts("darwin", "arm64")
      .find((artifact) => artifact.name === "cursor");
    expect(cursor?.archive.entryPath).toBe("dist-package/cursor-agent");
    expect(cursor?.activationAliases).toContain("cursor-agent");
  });

  test("installs a raw executable artifact", async () => {
    const dataDir = await createDataDir();
    const body = Buffer.from("#!/bin/sh\nprintf 'grok 1.0.3\\n'\n");
    const artifact: ToolchainArtifact = { ...artifactWithBody(artifacts[0]!, body, {
      format: "raw",
      entryPath: "",
      url: "https://downloads.example.test/grok",
    }, {
      fileName: "grok",
      size: body.byteLength,
      sha256: sha256(body),
    }), name: "grok" };
    const result = await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifact],
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      }),
      skipExecutableProbeForTests: true,
    });

    const target = await readlink(path.join(result.binDir, "grok"));
    expect(await readFile(target)).toEqual(body);
  });

  test("retains an extracted launcher bundle beside its runtime", async () => {
    const dataDir = await createDataDir();
    const launcher = Buffer.from("#!/bin/sh\nexec \"$(dirname \"$0\")/node/bin/node\"\n");
    const runtime = Buffer.from("bundled runtime");
    const archive = await tarGzip([
      { name: "dist-package/cursor-agent", body: launcher },
      { name: "dist-package/node/bin/node", body: runtime },
      { name: "dist-package/unpinned-runtime.js", body: Buffer.from("not installed") },
    ]);
    const artifact: ToolchainArtifact = { ...artifactWithBody(artifacts[1]!, archive, {
      entryPath: "dist-package/cursor-agent",
      bundleRoot: "dist-package/",
      bundleFiles: [
        { path: "node/bin/node", size: runtime.byteLength, sha256: sha256(runtime) },
      ],
      url: "https://downloads.example.test/cursor.tar.gz",
    }, {
      fileName: "cursor",
      size: launcher.byteLength,
      sha256: sha256(launcher),
    }), name: "cursor", activationAliases: ["cursor-agent"] };
    const result = await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifact],
      fetchImpl: async () => new Response(archive, {
        status: 200,
        headers: { "content-length": String(archive.byteLength) },
      }),
      skipExecutableProbeForTests: true,
    });

    const target = await readlink(path.join(result.binDir, "cursor"));
    expect(await readlink(path.join(result.binDir, "cursor-agent"))).toBe(target);
    expect(await readFile(target)).toEqual(launcher);
    expect(await readFile(path.join(path.dirname(target), "node/bin/node"))).toEqual(runtime);
    await expect(readFile(path.join(path.dirname(target), "unpinned-runtime.js"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const runtimePath = path.join(path.dirname(target), "node/bin/node");
    await chmod(runtimePath, 0o600);
    await writeFile(runtimePath, "corrupt");
    let downloads = 0;
    await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifact],
      fetchImpl: async () => {
        downloads += 1;
        return new Response(archive, {
          status: 200,
          headers: { "content-length": String(archive.byteLength) },
        });
      },
      skipExecutableProbeForTests: true,
    });
    expect(downloads).toBe(1);
    expect(await readFile(path.join(path.dirname(target), "node/bin/node"))).toEqual(runtime);
  });

  test("retains and revalidates a complete runtime bundle by its tree digest", async () => {
    const dataDir = await createDataDir();
    const launcher = Buffer.from("#!/bin/sh\nexit 0\n");
    const runtime = Buffer.from("bundled runtime");
    const lazyChunk = Buffer.from("lazy runtime");
    const archive = await tarGzip([
      { name: "dist-package/cursor-agent", body: launcher },
      { name: "dist-package/node", body: runtime },
      { name: "dist-package/chunks/lazy.js", body: lazyChunk },
    ]);
    const artifact: ToolchainArtifact = { ...artifactWithBody(artifacts[1]!, archive, {
      entryPath: "dist-package/cursor-agent",
      bundleRoot: "dist-package/",
      bundleIntegrity: {
        fileCount: 2,
        totalSize: 27,
        sha256: "46ed76bffe64e3672843d3c536ff0fbd0d91e3dd3528b12e1c870264856d8855",
      },
      url: "https://downloads.example.test/cursor.tar.gz",
    }, {
      fileName: "cursor",
      size: launcher.byteLength,
      sha256: sha256(launcher),
    }), name: "cursor", activationAliases: ["cursor-agent"] };
    const install = async (onFetch = () => undefined) => ensurePinnedToolchains({
      dataDir,
      artifacts: [artifact],
      fetchImpl: async () => {
        onFetch();
        return new Response(archive, {
          status: 200,
          headers: { "content-length": String(archive.byteLength) },
        });
      },
      skipExecutableProbeForTests: true,
    });

    const result = await install();
    const target = await readlink(path.join(result.binDir, "cursor"));
    const lazyChunkPath = path.join(path.dirname(target), "chunks/lazy.js");
    expect(await readFile(lazyChunkPath)).toEqual(lazyChunk);

    await chmod(lazyChunkPath, 0o600);
    await writeFile(lazyChunkPath, "corrupt");
    let downloads = 0;
    await install(() => downloads += 1);
    expect(downloads).toBe(1);
    expect(await readFile(lazyChunkPath)).toEqual(lazyChunk);
  });

  test("installs ZIP and tar.gz artifacts once, activates them, and reuses verified files", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();

    const [first, concurrent] = await Promise.all([
      ensurePinnedToolchains({ dataDir, artifacts, fetchImpl, skipExecutableProbeForTests: true }),
      ensurePinnedToolchains({ dataDir, artifacts, fetchImpl, skipExecutableProbeForTests: true }),
    ]);

    expect(path.dirname(first.binDir)).toBe(path.join(dataDir, "toolchains", "bin"));
    expect(concurrent.binDir).toBe(first.binDir);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const artifact of artifacts) {
      const activePath = path.join(first.binDir, artifact.name);
      const target = await readlink(activePath);
      expect(target).toBe(path.join(
        dataDir,
        "toolchains",
        artifact.name,
        artifact.version,
        "darwin-arm64",
        artifact.name,
      ));
      const installed = await lstat(target);
      expect(installed.size).toBe(EXECUTABLE_SIZE);
      expect(installed.mode & 0o777).toBe(0o500);
    }

    const reordered = await ensurePinnedToolchains({
      dataDir,
      artifacts: [...artifacts].reverse(),
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    expect(reordered.binDir).toBe(first.binDir);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("redownloads a cached executable that no longer matches the signed manifest", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const first = await ensurePinnedToolchains({
      dataDir,
      artifacts,
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    const codexPath = await readlink(path.join(first.binDir, "codex"));
    await chmod(codexPath, 0o700);
    await writeFile(codexPath, "corrupt");

    await ensurePinnedToolchains({ dataDir, artifacts, fetchImpl, skipExecutableProbeForTests: true });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((await lstat(codexPath)).size).toBe(EXECUTABLE_SIZE);
  });

  test("repairs cached executable permissions without redownloading verified bytes", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const first = await ensurePinnedToolchains({
      dataDir,
      artifacts,
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    const codexPath = await readlink(path.join(first.binDir, "codex"));
    await chmod(codexPath, 0o400);

    await ensurePinnedToolchains({ dataDir, artifacts, fetchImpl, skipExecutableProbeForTests: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await lstat(codexPath)).mode & 0o777).toBe(0o500);
  });

  test("rejects a download whose archive hash is not pinned and leaves no active executable", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const invalidArtifact: ToolchainArtifact = {
      ...artifacts[0],
      archive: { ...artifacts[0].archive, sha256: "0".repeat(64) },
    };

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [invalidArtifact],
      fetchImpl,
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("archive checksum did not match");

    await expect(lstat(path.join(dataDir, "toolchains", "bin"))).rejects.toThrow();
    await expect(lstat(path.join(dataDir, "toolchains", ".install.lock"))).rejects.toThrow();
  });

  test("keeps the install lock until every parallel artifact has settled", async () => {
    const dataDir = await createDataDir();
    let releaseClaude!: () => void;
    let codexRequests = 0;
    const fetchImpl = mock(async (input: string) => {
      if (input.endsWith("codex.zip")) {
        codexRequests += 1;
        const body = codexRequests === 1
          ? Buffer.from(ZIP_FIXTURE.map((byte, index) => index === 20 ? byte ^ 0xff : byte))
          : ZIP_FIXTURE;
        return response(body, { status: 200, headers: { "content-length": String(body.byteLength) } });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseClaude = () => {
            controller.enqueue(TAR_GZIP_FIXTURE);
            controller.close();
          };
        },
      });
      return response(stream, {
        status: 200,
        headers: { "content-length": String(TAR_GZIP_FIXTURE.byteLength) },
      });
    });

    let firstSettled = false;
    const first = ensurePinnedToolchains({
      dataDir,
      artifacts,
      fetchImpl,
      skipExecutableProbeForTests: true,
      timingsForTests: { lockPollMs: 2, lockStaleAfterMs: 30, lockWaitTimeoutMs: 500 },
    }).finally(() => { firstSettled = true; });
    while (!releaseClaude) await Bun.sleep(1);
    const second = ensurePinnedToolchains({
      dataDir,
      artifacts,
      fetchImpl,
      skipExecutableProbeForTests: true,
      timingsForTests: { lockPollMs: 2, lockStaleAfterMs: 30, lockWaitTimeoutMs: 500 },
    });

    await Bun.sleep(40);
    expect(firstSettled).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    releaseClaude();
    await expect(first).rejects.toThrow("archive checksum did not match");
    const secondResult = await second;
    expect(path.dirname(secondResult.binDir)).toBe(path.join(dataDir, "toolchains", "bin"));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("removes a fresh dead-owner lock but preserves a stale-looking live-owner lock", async () => {
    const staleDataDir = await createDataDir();
    const staleRoot = path.join(staleDataDir, "toolchains");
    const staleLock = path.join(staleRoot, ".install.lock");
    await mkdir(staleRoot, { recursive: true });
    await writeFile(staleLock, JSON.stringify({ token: "dead", pid: 999_999, createdAt: new Date(0).toISOString() }));

    const staleResult = await ensurePinnedToolchains({
      dataDir: staleDataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
      processExistsForTests: () => false,
      timingsForTests: { lockPollMs: 1, lockStaleAfterMs: 10_000, lockWaitTimeoutMs: 100 },
    });
    expect(path.dirname(staleResult.binDir)).toBe(path.join(staleRoot, "bin"));

    const liveDataDir = await createDataDir();
    const liveRoot = path.join(liveDataDir, "toolchains");
    const liveLock = path.join(liveRoot, ".install.lock");
    await mkdir(liveRoot, { recursive: true });
    await writeFile(liveLock, JSON.stringify({ token: "live", pid: process.pid, createdAt: new Date(0).toISOString() }));
    await utimes(liveLock, new Date(0), new Date(0));
    const progressEvents: ToolchainProgress[] = [];

    await expect(ensurePinnedToolchains({
      dataDir: liveDataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      onProgress: (event) => progressEvents.push(event),
      skipExecutableProbeForTests: true,
      processExistsForTests: () => true,
      timingsForTests: { lockPollMs: 2, lockStaleAfterMs: 1, lockWaitTimeoutMs: 20 },
    })).rejects.toThrow("Timed out waiting");
    expect(progressEvents.some((event) => event.phase === "waiting")).toBe(true);
    expect((await lstat(liveLock)).isFile()).toBe(true);
  });

  test("reclaims malformed stale locks but treats EPERM owners as alive", async () => {
    const malformedDataDir = await createDataDir();
    const malformedRoot = path.join(malformedDataDir, "toolchains");
    const malformedLock = path.join(malformedRoot, ".install.lock");
    await mkdir(malformedRoot, { recursive: true });
    await writeFile(malformedLock, "{}");
    await utimes(malformedLock, new Date(0), new Date(0));
    await expect(ensurePinnedToolchains({
      dataDir: malformedDataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
      timingsForTests: { lockPollMs: 1, lockStaleAfterMs: 1, lockWaitTimeoutMs: 100 },
    })).resolves.toBeDefined();

    const epermDataDir = await createDataDir();
    const epermRoot = path.join(epermDataDir, "toolchains");
    const epermLock = path.join(epermRoot, ".install.lock");
    await mkdir(epermRoot, { recursive: true });
    await writeFile(epermLock, JSON.stringify({
      token: "protected",
      pid: 42,
      createdAt: new Date(0).toISOString(),
    }));
    await utimes(epermLock, new Date(0), new Date(0));
    await expect(ensurePinnedToolchains({
      dataDir: epermDataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
      processKillForTests: () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      },
      timingsForTests: { lockPollMs: 2, lockStaleAfterMs: 1, lockWaitTimeoutMs: 15 },
    })).rejects.toThrow("Timed out waiting");
    await expect(lstat(epermLock)).resolves.toBeDefined();
  });

  test("cached callers wait for the cache-wide lock before validation and activation", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    const lockPath = path.join(dataDir, "toolchains", ".install.lock");
    await writeFile(lockPath, JSON.stringify({
      token: "other-live-window",
      pid: 42,
      createdAt: new Date().toISOString(),
    }));

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl,
      skipExecutableProbeForTests: true,
      processExistsForTests: () => true,
      timingsForTests: { lockPollMs: 2, lockStaleAfterMs: 10_000, lockWaitTimeoutMs: 15 },
    })).rejects.toThrow("Timed out waiting");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("detects a disappeared or replaced lock before releasing cache ownership", async () => {
    for (const replacement of [null, { token: "replacement", pid: 42, createdAt: new Date().toISOString() }]) {
      const dataDir = await createDataDir();
      const lockPath = path.join(dataDir, "toolchains", ".install.lock");
      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [artifacts[0]],
        fetchImpl: createFetch(),
        skipExecutableProbeForTests: true,
        skipVersionLeaseForTests: true,
        beforeFinalVerificationForTests: async () => {
          if (replacement) await writeFile(lockPath, JSON.stringify(replacement));
          else await rm(lockPath);
        },
      })).rejects.toThrow(replacement ? "ownership changed unexpectedly" : "disappeared unexpectedly");
    }
  });

  test("cleans up a lock when owner metadata cannot be written", async () => {
    const dataDir = await createDataDir();
    const lockPath = path.join(dataDir, "toolchains", ".install.lock");
    let injected = false;
    const failingOpen: typeof open = (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (injected) return handle;
      injected = true;
      return {
        writeFile: async () => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        },
        close: () => handle.close(),
      } as Awaited<ReturnType<typeof open>>;
    }) as typeof open;

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
      openLockFileForTests: failingOpen,
    })).rejects.toThrow("disk full");
    await expect(lstat(lockPath)).rejects.toThrow();

    const installed = await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
    });
    expect(path.dirname(installed.binDir)).toBe(path.join(dataDir, "toolchains", "bin"));
  });

  test("removes abandoned and failed staging directories while retaining no partial install", async () => {
    const dataDir = await createDataDir();
    const rootDir = path.join(dataDir, "toolchains");
    const abandoned = path.join(rootDir, ".staging-codex-abandoned");
    await mkdir(abandoned, { recursive: true });
    await writeFile(path.join(abandoned, "partial"), "partial");

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [{ ...artifacts[0], archive: { ...artifacts[0].archive, sha256: "0".repeat(64) } }],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("archive checksum did not match");

    expect((await readdir(rootDir)).filter((entry) => entry.startsWith(".staging-"))).toEqual([]);
    await expect(lstat(path.join(rootDir, "codex", "1.2.3"))).rejects.toThrow();
  });

  const downloadFailureCases: Array<{
    name: string;
    artifact?: ToolchainArtifact;
    fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
    message: string;
    timingsForTests?: { downloadTimeoutMs: number };
  }> = [
    {
      name: "HTTP failure",
      fetchImpl: async () => response("unavailable", { status: 503 }),
      message: "HTTP 503",
    },
    {
      name: "missing body",
      fetchImpl: async () => response(null, { status: 200 }),
      message: "HTTP 200",
    },
    {
      name: "insecure URL",
      artifact: { ...artifacts[0], archive: { ...artifacts[0].archive, url: "http://downloads.example.test/codex.zip" } },
      fetchImpl: async () => response(ZIP_FIXTURE, { status: 200 }),
      message: "did not use HTTPS",
    },
    {
      name: "untrusted requested host",
      artifact: { ...artifacts[0], archive: { ...artifacts[0].archive, url: "https://untrusted.example/codex.zip" } },
      fetchImpl: async () => response(ZIP_FIXTURE, { status: 200 }),
      message: "host is not allowlisted",
    },
    {
      name: "untrusted redirect",
      fetchImpl: async () => response(ZIP_FIXTURE, { status: 200, url: "https://untrusted.example/codex.zip" }),
      message: "redirected to an untrusted host",
    },
    {
      name: "mismatched content length",
      fetchImpl: async () => response(ZIP_FIXTURE, { status: 200, headers: { "content-length": "1" } }),
      message: "size header did not match",
    },
    {
      name: "truncated body",
      fetchImpl: async () => response(ZIP_FIXTURE.subarray(0, -1), { status: 200 }),
      message: "archive was truncated",
    },
    {
      name: "oversized body",
      fetchImpl: async () => response(Buffer.concat([ZIP_FIXTURE, Buffer.from([0])]), { status: 200 }),
      message: "archive exceeded its pinned size",
    },
    {
      name: "timeout",
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
      }),
      message: "aborted by timeout",
      timingsForTests: { downloadTimeoutMs: 10 },
    },
  ];

  for (const failure of downloadFailureCases) {
    test(`rejects ${failure.name} downloads and releases the lock`, async () => {
      const dataDir = await createDataDir();
      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [failure.artifact ?? artifacts[0]],
        fetchImpl: failure.fetchImpl,
        skipExecutableProbeForTests: true,
        timingsForTests: failure.timingsForTests,
      })).rejects.toThrow(failure.message);
      await expect(lstat(path.join(dataDir, "toolchains", ".install.lock"))).rejects.toThrow();
    });
  }

  test("rejects malformed, unsafe, missing, duplicate, and mismatched archive entries", async () => {
    const unsafeZip = Buffer.from(ZIP_FIXTURE);
    const originalName = Buffer.from("tool");
    const unsafeName = Buffer.from("../x");
    let offset = unsafeZip.indexOf(originalName);
    while (offset >= 0) {
      unsafeName.copy(unsafeZip, offset);
      offset = unsafeZip.indexOf(originalName, offset + unsafeName.length);
    }
    const duplicateTar = await tarGzip([
      { name: "package/tool", body: Buffer.from("#!/bin/sh\nprintf \"tool 1.2.3\\n\"\n") },
      { name: "package/tool", body: Buffer.from("#!/bin/sh\nprintf \"tool 1.2.3\\n\"\n") },
    ]);
    const nonTargetTar = await tarGzip([
      { name: "package/readme", body: Buffer.from("ignored") },
      { name: "package/tool", body: Buffer.from("#!/bin/sh\nprintf \"tool 1.2.3\\n\"\n") },
    ]);
    const wrongTypeTar = await tarGzip([
      { name: "package/tool", body: Buffer.alloc(0), type: "directory" },
    ]);
    const wrongSizeTar = await tarGzip([
      { name: "package/tool", body: Buffer.alloc(EXECUTABLE_SIZE - 1) },
    ]);
    const duplicateZip = storedZip([
      { name: "tool", body: Buffer.from("#!/bin/sh\nprintf \"tool 1.2.3\\n\"\n") },
      { name: "tool", body: Buffer.from("#!/bin/sh\nprintf \"tool 1.2.3\\n\"\n") },
    ]);
    const invalidLocalHeaderZip = storedZip([
      { name: "tool", body: Buffer.from("#!/bin/sh\nprintf \"tool 1.2.3\\n\"\n") },
    ]);
    invalidLocalHeaderZip.writeUInt32LE(0, 0);
    const cases = [
      { artifact: artifactWithBody(artifacts[0], Buffer.from("not a zip")), body: Buffer.from("not a zip"), message: "central directory" },
      { artifact: artifactWithBody(artifacts[0], unsafeZip), body: unsafeZip, message: "invalid relative path" },
      { artifact: { ...artifacts[0], archive: { ...artifacts[0].archive, entryPath: "missing" } }, body: ZIP_FIXTURE, message: "was not found" },
      { artifact: { ...artifacts[0], executable: { ...artifacts[0].executable, size: EXECUTABLE_SIZE - 1 } }, body: ZIP_FIXTURE, message: "entry did not match" },
      { artifact: { ...artifacts[0], executable: { ...artifacts[0].executable, sha256: "0".repeat(64) } }, body: ZIP_FIXTURE, message: "executable checksum" },
      { artifact: { ...artifacts[0], executable: { ...artifacts[0].executable, installedSha256: "0".repeat(64), installedSize: EXECUTABLE_SIZE } }, body: ZIP_FIXTURE, message: "installed executable" },
      { artifact: artifactWithBody(artifacts[1], duplicateTar), body: duplicateTar, message: "duplicate executable entry" },
      { artifact: artifactWithBody(artifacts[1], nonTargetTar), body: nonTargetTar, message: "" },
      { artifact: artifactWithBody(artifacts[1], wrongTypeTar), body: wrongTypeTar, message: "entry did not match" },
      { artifact: artifactWithBody(artifacts[1], wrongSizeTar), body: wrongSizeTar, message: "entry did not match" },
      { artifact: artifactWithBody(artifacts[0], duplicateZip), body: duplicateZip, message: "duplicate executable entry" },
      { artifact: artifactWithBody(artifacts[0], invalidLocalHeaderZip), body: invalidLocalHeaderZip, message: "local file header" },
    ];

    for (const failure of cases) {
      const dataDir = await createDataDir();
      const installing = ensurePinnedToolchains({
        dataDir,
        artifacts: [failure.artifact],
        fetchImpl: async () => response(failure.body, {
          status: 200,
          headers: { "content-length": String(failure.body.byteLength) },
        }),
        skipExecutableProbeForTests: true,
      });
      if (failure.message) await expect(installing).rejects.toThrow(failure.message);
      else await expect(installing).resolves.toBeDefined();
    }
  });

  test("probes installed executables and rejects unexpected versions", async () => {
    const executableArtifact: ToolchainArtifact = { ...artifacts[0], platform: "linux" };
    const successDataDir = await createDataDir();
    const installed = await ensurePinnedToolchains({
      dataDir: successDataDir,
      artifacts: [executableArtifact],
      fetchImpl: createFetch(),
    });
    expect(path.dirname(installed.binDir)).toBe(path.join(successDataDir, "toolchains", "bin"));

    const failureDataDir = await createDataDir();
    await expect(ensurePinnedToolchains({
      dataDir: failureDataDir,
      artifacts: [{ ...executableArtifact, version: "9.9.9" }],
      fetchImpl: createFetch(),
    })).rejects.toThrow("reported an unexpected version");
  });

  test("reports executable probe spawn, nonzero-exit, and timeout failures", async () => {
    const cases = [
      {
        body: Buffer.from("#!/definitely/missing/interpreter\n"),
        message: "could not execute from the Orkestrator toolchain cache",
        timeout: 5_000,
      },
      {
        body: Buffer.from("#!/bin/sh\nexit 7\n"),
        message: "version check failed (code 7",
        timeout: 5_000,
      },
      {
        body: Buffer.from("#!/bin/sh\nsleep 1\n"),
        message: "version check timed out",
        timeout: 10,
      },
    ];

    for (const failure of cases) {
      const dataDir = await createDataDir();
      const archiveBody = await tarGzip([{ name: "package/tool", body: failure.body }]);
      const artifact = artifactWithBody(
        { ...artifacts[1], platform: "linux" },
        archiveBody,
        {},
        { size: failure.body.byteLength, sha256: sha256(failure.body) },
      );
      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [artifact],
        fetchImpl: async () => response(archiveBody, {
          status: 200,
          headers: { "content-length": String(archiveBody.byteLength) },
        }),
        timingsForTests: { processTimeoutMs: failure.timeout },
      })).rejects.toThrow(failure.message);
      await expect(lstat(path.join(dataDir, "toolchains", ".install.lock"))).rejects.toThrow();
    }
  }, 15_000);

  test("reports deterministic macOS code-signature spawn, timeout, and nonzero failures", async () => {
    const cases: Array<{ outcome: SpawnOutcome; message: string; timeout?: number }> = [
      { outcome: { type: "error", error: new Error("codesign spawn failed") }, message: "codesign spawn failed" },
      { outcome: { type: "timeout" }, message: "code-signature check timed out", timeout: 5 },
      {
        outcome: { type: "exit", code: 9, stderr: "signature rejected" },
        message: "invalid macOS code signature (code 9, signal none): signature rejected",
      },
    ];
    for (const failure of cases) {
      const dataDir = await createDataDir();
      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [artifacts[0]],
        fetchImpl: createFetch(),
        spawnForTests: createSpawn([failure.outcome]),
        timingsForTests: { processTimeoutMs: failure.timeout ?? 1_000 },
      })).rejects.toThrow(failure.message);
      await expect(lstat(path.join(dataDir, "toolchains", ".install.lock"))).rejects.toThrow();
    }
  });

  // `codesign` only exists on macOS. These report as skips elsewhere rather than
  // disappearing silently, so the reduced coverage on Linux CI stays visible.
  const darwinTest = test.skipIf(process.platform !== "darwin");

  darwinTest("rejects an unsigned macOS executable when repair is not allowed", async () => {
    const dataDir = await createDataDir();
    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      timingsForTests: { processTimeoutMs: 1_000 },
    })).rejects.toThrow("invalid macOS code signature");
  });

  // The ad-hoc re-signature is produced by the local `codesign`, so its bytes
  // are not reproducible across machines and the manifest cannot pin them. This
  // is the path that ships for the darwin OpenCode artifacts: retain verified
  // upstream bytes and regenerate the runnable copy from them on every launch.
  darwinTest("repairs an invalid macOS signature from a manifest-pinned pristine copy", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const repairable: ToolchainArtifact = {
      ...artifacts[0],
      executable: { ...artifacts[0].executable, repairInvalidMacSignature: true },
    };

    const first = await ensurePinnedToolchains({
      dataDir,
      artifacts: [repairable],
      fetchImpl,
      timingsForTests: { processTimeoutMs: 10_000 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const installedPath = await readlink(path.join(first.binDir, "codex"));
    const upstreamPath = path.join(path.dirname(installedPath), ".upstream-codex");
    expect(sha256(await readFile(upstreamPath))).toBe(EXECUTABLE_SHA256);
    expect((await lstat(upstreamPath)).mode & 0o777).toBe(0o400);
    await chmod(installedPath, 0o700);
    await writeFile(installedPath, "substituted");
    await writeFile(path.join(path.dirname(installedPath), ".installed.json"), JSON.stringify({
      size: 11,
      sha256: sha256(Buffer.from("substituted")),
    }));

    await ensurePinnedToolchains({
      dataDir,
      artifacts: [repairable],
      fetchImpl,
      timingsForTests: { processTimeoutMs: 10_000 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sha256(await readFile(installedPath))).toBe(EXECUTABLE_SHA256);
  }, 20_000);

  test("retains pinned upstream state for repair-flagged artifacts and reuses it without redownloading", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const repairable: ToolchainArtifact = {
      ...artifacts[0],
      executable: { ...artifacts[0].executable, repairInvalidMacSignature: true },
    };

    const first = await ensurePinnedToolchains({
      dataDir,
      artifacts: [repairable],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    const installedPath = await readlink(path.join(first.binDir, "codex"));
    const upstreamPath = path.join(path.dirname(installedPath), ".upstream-codex");
    expect(sha256(await readFile(upstreamPath))).toBe(EXECUTABLE_SHA256);

    await chmod(installedPath, 0o700);
    await writeFile(installedPath, "substituted");
    await writeFile(path.join(path.dirname(installedPath), ".installed.json"), JSON.stringify({
      size: 11,
      sha256: sha256(Buffer.from("substituted")),
    }));
    await ensurePinnedToolchains({ dataDir, artifacts: [repairable], fetchImpl, skipExecutableProbeForTests: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sha256(await readFile(installedPath))).toBe(EXECUTABLE_SHA256);
  });

  test("redownloads a repair-flagged artifact whose trusted upstream copy is missing or malformed", async () => {
    const repairable: ToolchainArtifact = {
      ...artifacts[0],
      executable: { ...artifacts[0].executable, repairInvalidMacSignature: true },
    };

    for (const damage of [
      async (upstreamPath: string) => { await rm(upstreamPath, { force: true }); },
      async (upstreamPath: string) => {
        await chmod(upstreamPath, 0o600);
        await writeFile(upstreamPath, "corrupt");
      },
      async (upstreamPath: string) => {
        const target = path.join(path.dirname(upstreamPath), "decoy");
        await writeFile(target, Buffer.alloc(EXECUTABLE_SIZE));
        await rm(upstreamPath);
        await symlink(target, upstreamPath);
      },
    ]) {
      const dataDir = await createDataDir();
      const fetchImpl = createFetch();
      const first = await ensurePinnedToolchains({
        dataDir,
        artifacts: [repairable],
        fetchImpl,
        skipExecutableProbeForTests: true,
      });
      const installedPath = await readlink(path.join(first.binDir, "codex"));
      await damage(path.join(path.dirname(installedPath), ".upstream-codex"));

      await ensurePinnedToolchains({ dataDir, artifacts: [repairable], fetchImpl, skipExecutableProbeForTests: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  test("restores substituted repairable bytes from the trusted upstream copy without downloading", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const repairable: ToolchainArtifact = {
      ...artifacts[0],
      executable: { ...artifacts[0].executable, repairInvalidMacSignature: true },
    };
    const first = await ensurePinnedToolchains({
      dataDir,
      artifacts: [repairable],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    const installedPath = await readlink(path.join(first.binDir, "codex"));
    await chmod(installedPath, 0o700);
    await writeFile(installedPath, "corrupt");

    await ensurePinnedToolchains({ dataDir, artifacts: [repairable], fetchImpl, skipExecutableProbeForTests: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await lstat(installedPath)).size).toBe(EXECUTABLE_SIZE);
  });

  test("cleans repair temporaries after codesign I/O, timeout, and signing failures", async () => {
    const failures: Array<{ outcomes: SpawnOutcome[]; message: string; timeout?: number }> = [
      {
        outcomes: [
          { type: "exit", code: 1 },
          { type: "error", error: new Error("codesign I/O failure") },
        ],
        message: "codesign I/O failure",
      },
      {
        outcomes: [
          { type: "exit", code: 1 },
          { type: "timeout" },
        ],
        message: "invalid signature could not be removed timed out",
        timeout: 5,
      },
      {
        outcomes: [
          { type: "exit", code: 1 },
          { type: "exit", code: 1 },
          { type: "exit", code: 2, stderr: "signing failed" },
        ],
        message: "could not be ad-hoc signed after source verification (code 2",
      },
    ];
    for (const failure of failures) {
      const dataDir = await createDataDir();
      const fetchImpl = createFetch();
      const repairable: ToolchainArtifact = {
        ...artifacts[0],
        executable: { ...artifacts[0].executable, repairInvalidMacSignature: true },
      };
      const first = await ensurePinnedToolchains({
        dataDir,
        artifacts: [repairable],
        fetchImpl,
        skipExecutableProbeForTests: true,
      });
      const directory = path.dirname(await readlink(path.join(first.binDir, "codex")));

      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [repairable],
        fetchImpl,
        spawnForTests: createSpawn(failure.outcomes),
        timingsForTests: { processTimeoutMs: failure.timeout ?? 1_000 },
      })).rejects.toThrow(failure.message);
      expect((await readdir(directory)).filter((entry) => entry.startsWith(".repair-"))).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  test("rejects partial or incompatible installed metadata before touching the cache", async () => {
    const dataDir = await createDataDir();
    const partialSize = {
      ...artifacts[0],
      executable: { ...artifacts[0].executable, installedSize: EXECUTABLE_SIZE },
    } as unknown as ToolchainArtifact;
    const partialDigest = {
      ...artifacts[0],
      executable: { ...artifacts[0].executable, installedSha256: EXECUTABLE_SHA256 },
    } as unknown as ToolchainArtifact;
    const repairedAndPinned = {
      ...artifacts[0],
      executable: {
        ...artifacts[0].executable,
        installedSize: EXECUTABLE_SIZE,
        installedSha256: EXECUTABLE_SHA256,
        repairInvalidMacSignature: true,
      },
    } as unknown as ToolchainArtifact;
    const invalidSize = {
      ...artifacts[0],
      executable: {
        ...artifacts[0].executable,
        installedSize: -1,
        installedSha256: EXECUTABLE_SHA256,
      },
    } as unknown as ToolchainArtifact;
    const invalidDigest = {
      ...artifacts[0],
      executable: {
        ...artifacts[0].executable,
        installedSize: EXECUTABLE_SIZE,
        installedSha256: "NOT-A-DIGEST",
      },
    } as unknown as ToolchainArtifact;
    const unsupportedArchive = {
      ...artifacts[0],
      archive: { ...artifacts[0].archive, format: "rar" },
    } as unknown as ToolchainArtifact;

    for (const invalid of [partialSize, partialDigest]) {
      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [invalid],
        fetchImpl: createFetch(),
        skipExecutableProbeForTests: true,
      })).rejects.toThrow("must provide installedSize and installedSha256 together");
    }
    for (const invalid of [invalidSize, invalidDigest]) {
      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [invalid],
        fetchImpl: createFetch(),
        skipExecutableProbeForTests: true,
      })).rejects.toThrow("invalid installed executable metadata");
    }
    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [repairedAndPinned],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("cannot pin locally repaired executable bytes");
    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [unsupportedArchive],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("unsupported archive format");
    await expect(lstat(path.join(dataDir, "toolchains"))).rejects.toThrow();
  });

  test("still enforces pinned installed values when the manifest supplies them", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const pinned: ToolchainArtifact = {
      ...artifacts[0],
      executable: {
        ...artifacts[0].executable,
        installedSize: EXECUTABLE_SIZE,
        installedSha256: EXECUTABLE_SHA256,
      },
    };

    await ensurePinnedToolchains({ dataDir, artifacts: [pinned], fetchImpl, skipExecutableProbeForTests: true });
    await ensurePinnedToolchains({ dataDir, artifacts: [pinned], fetchImpl, skipExecutableProbeForTests: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("rejects a cached executable that has been replaced by a symlink", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const first = await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    const installedPath = await readlink(path.join(first.binDir, "codex"));
    const decoy = path.join(dataDir, "decoy");
    await writeFile(decoy, "#!/bin/sh\nprintf \"tool 1.2.3\\n\"\n");
    await rm(installedPath, { force: true });
    await symlink(decoy, installedPath);

    await ensurePinnedToolchains({ dataDir, artifacts: [artifacts[0]], fetchImpl, skipExecutableProbeForTests: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await lstat(installedPath)).isSymbolicLink()).toBe(false);
  });

  test("fails final verification if installed bytes change before activation", async () => {
    const dataDir = await createDataDir();
    const executablePath = path.join(
      dataDir,
      "toolchains",
      "codex",
      "1.2.3",
      "darwin-arm64",
      "codex",
    );
    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
      beforeFinalVerificationForTests: async () => {
        await chmod(executablePath, 0o700);
        await writeFile(executablePath, "changed after install");
      },
    })).rejects.toThrow("failed final verification");
    await expect(lstat(path.join(dataDir, "toolchains", "bin"))).rejects.toThrow();
    await expect(lstat(path.join(dataDir, "toolchains", ".install.lock"))).rejects.toThrow();
  });

  test("prunes superseded versions that have gone unused past the retention window", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const older = artifacts.map((artifact) => ({ ...artifact, version: "1.2.2" }));
    const unrelated = path.join(dataDir, "toolchains", "opencode", "9.9.9");

    await ensurePinnedToolchains({
      dataDir,
      artifacts: older,
      fetchImpl,
      skipExecutableProbeForTests: true,
      skipVersionLeaseForTests: true,
    });
    await mkdir(unrelated, { recursive: true });
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    for (const artifact of older) {
      await utimes(path.join(dataDir, "toolchains", artifact.name, "1.2.2"), stale, stale);
    }
    await utimes(unrelated, stale, stale);

    const current = await ensurePinnedToolchains({
      dataDir,
      artifacts,
      fetchImpl,
      skipExecutableProbeForTests: true,
    });

    for (const artifact of artifacts) {
      const toolDir = path.join(dataDir, "toolchains", artifact.name);
      await expect(lstat(path.join(toolDir, "1.2.2"))).rejects.toThrow();
      await expect(lstat(path.join(toolDir, artifact.version))).resolves.toBeDefined();
      // The activated symlink still resolves after the prune.
      const target = await readlink(path.join(current.binDir, artifact.name));
      expect((await lstat(target)).size).toBe(EXECUTABLE_SIZE);
    }
    // Tools outside this run are left alone even when they are stale.
    await expect(lstat(unrelated)).resolves.toBeDefined();
  });

  test("refreshes the version directory timestamp used by retention pruning", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const older = [{ ...artifacts[0], version: "1.2.2" }];
    const versionDir = path.join(dataDir, "toolchains", "codex", "1.2.2");
    const platformDir = path.join(versionDir, "darwin-arm64");

    await ensurePinnedToolchains({
      dataDir,
      artifacts: older,
      fetchImpl,
      skipExecutableProbeForTests: true,
      skipVersionLeaseForTests: true,
    });
    const stale = new Date(Date.now() - 60_000);
    await utimes(versionDir, stale, stale);
    await utimes(platformDir, stale, stale);

    await ensurePinnedToolchains({
      dataDir,
      artifacts: older,
      fetchImpl,
      skipExecutableProbeForTests: true,
      skipVersionLeaseForTests: true,
    });
    expect((await lstat(versionDir)).mtimeMs).toBeGreaterThan(stale.getTime());
    expect((await lstat(platformDir)).mtimeMs).toBe(stale.getTime());

    await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl,
      skipExecutableProbeForTests: true,
      skipVersionLeaseForTests: true,
      timingsForTests: { retainSupersededMs: 10_000 },
    });
    await expect(lstat(versionDir)).resolves.toBeDefined();
  });

  test("a live app lease prevents another build from pruning its old toolchain", async () => {
    // A second build of the app can legitimately share this cache while pinning
    // an older version. Each refreshes its own directories on launch, so neither
    // may prune the other's and trigger a re-download ping-pong.
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const older = artifacts.map((artifact) => ({ ...artifact, version: "1.2.2" }));

    const olderResult = await ensurePinnedToolchains({
      dataDir,
      artifacts: older,
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    const currentResult = await ensurePinnedToolchains({
      dataDir,
      artifacts,
      fetchImpl,
      skipExecutableProbeForTests: true,
      timingsForTests: { retainSupersededMs: 0 },
    });
    expect(currentResult.binDir).not.toBe(olderResult.binDir);
    expect(fetchImpl).toHaveBeenCalledTimes(artifacts.length * 2);
    for (const artifact of artifacts) {
      await expect(lstat(path.join(dataDir, "toolchains", artifact.name, "1.2.2"))).resolves.toBeDefined();
      await expect(lstat(path.join(dataDir, "toolchains", artifact.name, artifact.version))).resolves.toBeDefined();
      expect(await readlink(path.join(olderResult.binDir, artifact.name))).toContain("/1.2.2/");
      expect(await readlink(path.join(currentResult.binDir, artifact.name))).toContain(`/${artifact.version}/`);
    }

    // Once the lease owner is no longer alive, its copies are reclaimed.
    await ensurePinnedToolchains({
      dataDir,
      artifacts,
      fetchImpl,
      skipExecutableProbeForTests: true,
      processExistsForTests: () => false,
      timingsForTests: { retainSupersededMs: 0 },
    });
    for (const artifact of artifacts) {
      await expect(lstat(path.join(dataDir, "toolchains", artifact.name, "1.2.2"))).rejects.toThrow();
      await expect(lstat(path.join(dataDir, "toolchains", artifact.name, artifact.version))).resolves.toBeDefined();
    }

    // If its lease and version were reclaimed, a still-running process can
    // recreate both rather than trusting only its in-memory lease registry.
    await ensurePinnedToolchains({
      dataDir,
      artifacts: older,
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    await ensurePinnedToolchains({
      dataDir,
      artifacts,
      fetchImpl,
      skipExecutableProbeForTests: true,
      timingsForTests: { retainSupersededMs: 0 },
    });
    for (const artifact of artifacts) {
      await expect(lstat(path.join(dataDir, "toolchains", artifact.name, "1.2.2"))).resolves.toBeDefined();
    }
  });

  test("cleans a partial lease and releases the install lock when lease metadata cannot be written", async () => {
    const dataDir = await createDataDir();
    const failingLeaseOpen: typeof open = (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      return {
        writeFile: async () => {
          throw Object.assign(new Error("lease disk full"), { code: "ENOSPC" });
        },
        close: () => handle.close(),
      } as Awaited<ReturnType<typeof open>>;
    }) as typeof open;

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
      openLeaseFileForTests: failingLeaseOpen,
    })).rejects.toThrow("lease disk full");
    await expect(lstat(path.join(dataDir, "toolchains", ".install.lock"))).rejects.toThrow();
    const leaseDirectory = path.join(dataDir, "toolchains", ".leases", "codex", "1.2.3");
    expect(await readdir(leaseDirectory)).toEqual([]);
  });

  test("treats superseded-version removal failures as best-effort", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const older = [{ ...artifacts[0], version: "1.2.2" }];
    await ensurePinnedToolchains({
      dataDir,
      artifacts: older,
      fetchImpl,
      skipExecutableProbeForTests: true,
      skipVersionLeaseForTests: true,
    });
    const stale = new Date(Date.now() - 60_000);
    const olderDirectory = path.join(dataDir, "toolchains", "codex", "1.2.2");
    await utimes(olderDirectory, stale, stale);
    const removeVersion = mock(async () => {
      throw Object.assign(new Error("simulated prune I/O failure"), { code: "EIO" });
    }) as unknown as typeof rm;

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl,
      skipExecutableProbeForTests: true,
      skipVersionLeaseForTests: true,
      removeSupersededVersionForTests: removeVersion,
      timingsForTests: { retainSupersededMs: 0 },
    })).resolves.toBeDefined();
    expect(removeVersion).toHaveBeenCalledTimes(1);
    await expect(lstat(olderDirectory)).resolves.toBeDefined();
  });

  test("reports aggregate progress monotonically across parallel tools", async () => {
    const dataDir = await createDataDir();
    const events: ToolchainProgress[] = [];
    await ensurePinnedToolchains({
      dataDir,
      artifacts,
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
      onProgress: (event) => events.push(event),
    });

    const fractions = events.map((event) => event.overallFraction ?? -1);
    for (let index = 1; index < fractions.length; index += 1) {
      expect(fractions[index]).toBeGreaterThanOrEqual(fractions[index - 1]);
    }
    expect(fractions.at(-1)).toBe(1);
  });

  test("replaces a non-symlink activation with the verified target", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const installed = await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    const activePath = path.join(installed.binDir, "codex");
    await rm(activePath);
    await writeFile(activePath, "stale");

    await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });

    expect(await readlink(activePath)).toContain("/codex/1.2.3/");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("does not recursively replace an activation directory and cleans its temporary link", async () => {
    const dataDir = await createDataDir();
    const installed = await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
    });
    const binDir = installed.binDir;
    const activeDirectory = path.join(binDir, "codex");
    await rm(activeDirectory);
    await mkdir(activeDirectory);
    await writeFile(path.join(activeDirectory, "user-data"), "keep");

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("Refusing to replace toolchain activation directory");
    expect(await readFile(path.join(activeDirectory, "user-data"), "utf8")).toBe("keep");
    expect((await readdir(binDir)).filter((entry) => entry.startsWith(".codex-"))).toEqual([]);
    await expect(lstat(path.join(dataDir, "toolchains", ".install.lock"))).rejects.toThrow();
  });

  test("rejects symlinked activation roots and version-set directories", async () => {
    const rootSymlinkDataDir = await createDataDir();
    const rootToolchains = path.join(rootSymlinkDataDir, "toolchains");
    const rootDecoy = path.join(rootSymlinkDataDir, "activation-root-decoy");
    await mkdir(rootToolchains);
    await mkdir(rootDecoy);
    await symlink(rootDecoy, path.join(rootToolchains, "bin"), "dir");

    await expect(ensurePinnedToolchains({
      dataDir: rootSymlinkDataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("unsafe toolchain activation root");
    expect(await readdir(rootDecoy)).toEqual([]);

    const setSymlinkDataDir = await createDataDir();
    const fetchImpl = createFetch();
    const installed = await ensurePinnedToolchains({
      dataDir: setSymlinkDataDir,
      artifacts: [artifacts[0]],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    const setDecoy = path.join(setSymlinkDataDir, "activation-set-decoy");
    await mkdir(setDecoy);
    await rm(installed.binDir, { recursive: true });
    await symlink(setDecoy, installed.binDir, "dir");

    await expect(ensurePinnedToolchains({
      dataDir: setSymlinkDataDir,
      artifacts: [artifacts[0]],
      fetchImpl,
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("unsafe toolchain activation directory");
    expect(await readdir(setDecoy)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("installs, activates, and repairs a companion executable", async () => {
    const dataDir = await createDataDir();
    const companionBody = COMPANION_BODY;
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const withCompanion = companionArtifact(artifacts[0], companionArchive, companionBody);
    const fetchImpl = createCompanionFetch(companionArchive);

    const result = await ensurePinnedToolchains({
      dataDir,
      artifacts: [withCompanion],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });

    const versionDir = path.join(dataDir, "toolchains", "codex", "1.2.3", "darwin-arm64");
    const companionTarget = await readlink(path.join(result.binDir, "codex-host"));
    expect(companionTarget).toBe(path.join(versionDir, "codex-host"));
    const installed = await lstat(companionTarget);
    expect(installed.size).toBe(companionBody.byteLength);
    expect(installed.mode & 0o777).toBe(0o500);
    // No `--version` probe: a companion is a helper process, not a CLI.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Staging archives must not survive into the activated version directory.
    expect((await readdir(versionDir)).sort()).toEqual(["codex", "codex-host"]);

    // A cache that predates the companion still holds a valid primary
    // executable. Only the companion is fetched again: re-downloading the
    // primary archive would cost the whole release for a helper a fraction of
    // its size, and rebuilding the version directory would disturb a running
    // build whose activation symlink resolves into it.
    const primaryPath = path.join(versionDir, "codex");
    const primaryBefore = await lstat(primaryPath);
    await rm(companionTarget, { force: true });
    await ensurePinnedToolchains({
      dataDir,
      artifacts: [withCompanion],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(requestedUrls(fetchImpl)[2]).toBe(COMPANION_ARCHIVE_URL);
    const repaired = await lstat(companionTarget);
    expect(repaired.size).toBe(companionBody.byteLength);
    expect(repaired.mode & 0o777).toBe(0o500);
    // Same file, not a replacement: the primary executable was never touched.
    const primaryAfter = await lstat(primaryPath);
    expect(primaryAfter.ino).toBe(primaryBefore.ino);
    expect((await readdir(versionDir)).sort()).toEqual(["codex", "codex-host"]);
  });

  test("repairs only the companions that are missing and leaves no staging behind", async () => {
    const dataDir = await createDataDir();
    const firstBody = Buffer.from("#!/bin/sh\nprintf \"first 1.2.3\\n\"\n");
    const secondBody = Buffer.from("#!/bin/sh\nprintf \"second 1.2.3\\n\"\n");
    const firstArchive = await tarGzip([{ name: "tool-host", body: firstBody }]);
    const secondArchive = await tarGzip([{ name: "second-host", body: secondBody }]);
    const secondUrl = "https://downloads.example.test/second-host.tar.gz";
    const base = companionArtifact(artifacts[0], firstArchive, firstBody);
    const withTwo: ToolchainArtifact = {
      ...base,
      companions: [base.companions![0], {
        fileName: "second-host",
        archive: {
          format: "tar.gz",
          url: secondUrl,
          entryPath: "second-host",
          size: secondArchive.byteLength,
          sha256: sha256(secondArchive),
          allowedHosts: ["downloads.example.test"],
        },
        executable: { size: secondBody.byteLength, sha256: sha256(secondBody) },
      }],
    };
    const fetchImpl = mock(async (input: string) => {
      const body = input === COMPANION_ARCHIVE_URL
        ? firstArchive
        : input === secondUrl ? secondArchive : ZIP_FIXTURE;
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      });
    });

    await ensurePinnedToolchains({
      dataDir,
      artifacts: [withTwo],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const versionDir = path.join(dataDir, "toolchains", "codex", "1.2.3", "darwin-arm64");
    await rm(path.join(versionDir, "second-host"), { force: true });
    await ensurePinnedToolchains({
      dataDir,
      artifacts: [withTwo],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });

    // The intact companion is not re-fetched either.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))[3]).toBe(secondUrl);
    expect((await readdir(versionDir)).sort()).toEqual(["codex", "codex-host", "second-host"]);
    expect((await readdir(path.join(dataDir, "toolchains")))
      .filter((entry) => entry.startsWith(".staging-"))).toEqual([]);
  });

  test("installs a companion shipped as a zip archive", async () => {
    const dataDir = await createDataDir();
    const companionBody = COMPANION_BODY;
    const companionArchive = storedZip([{ name: "tool-host", body: companionBody }]);
    const companionUrl = "https://downloads.example.test/codex-host.zip";
    const fetchImpl = createCompanionFetch(companionArchive, companionUrl);

    const result = await ensurePinnedToolchains({
      dataDir,
      artifacts: [companionArtifact(artifacts[0], companionArchive, companionBody, {
        format: "zip",
        url: companionUrl,
      })],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });

    const target = await readlink(path.join(result.binDir, "codex-host"));
    expect((await lstat(target)).size).toBe(companionBody.byteLength);
    expect(await readFile(target)).toEqual(companionBody);
  });

  test("reports one progress stream covering the companion archives too", async () => {
    const dataDir = await createDataDir();
    const companionBody = COMPANION_BODY;
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const withCompanion = companionArtifact(artifacts[0], companionArchive, companionBody);
    const combined = ZIP_FIXTURE.byteLength + companionArchive.byteLength;
    const events: ToolchainProgress[] = [];

    await ensurePinnedToolchains({
      dataDir,
      artifacts: [withCompanion],
      fetchImpl: createCompanionFetch(companionArchive),
      skipExecutableProbeForTests: true,
      onProgress: (event) => events.push(event),
    });

    const downloads = events.filter((event) => event.phase === "downloading");
    // Both archives are one budget, so the bar cannot reach full and then fall
    // back when the companion download starts.
    expect(downloads.every((event) => event.bytesTotal === combined)).toBe(true);
    expect(downloads.at(-1)?.bytesReceived).toBe(combined);
    const received = downloads.map((event) => event.bytesReceived ?? 0);
    expect(received).toEqual([...received].sort((left, right) => left - right));
    const fractions = events.map((event) => event.overallFraction);
    expect(fractions).toEqual([...fractions].sort((left, right) => left - right));
    expect(fractions.at(-1)).toBe(1);
    // The phase never moves backwards: "downloading" covers both archives as
    // one budget, so once "verifying" is announced nothing reports
    // "downloading" again.
    const firstVerifying = events.findIndex((event) => event.phase === "verifying");
    expect(firstVerifying).not.toBe(-1);
    expect(events.slice(firstVerifying)
      .some((event) => event.phase === "downloading")).toBe(false);
    expect(events.at(-2)?.phase).toBe("installing");
    expect(events.at(-1)?.phase).toBe("ready");
  });

  test("repair progress counts only the companion that is missing", async () => {
    const dataDir = await createDataDir();
    const companionBody = COMPANION_BODY;
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const withCompanion = companionArtifact(artifacts[0], companionArchive, companionBody);
    const fetchImpl = createCompanionFetch(companionArchive);

    const first = await ensurePinnedToolchains({
      dataDir,
      artifacts: [withCompanion],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    await rm(await readlink(path.join(first.binDir, "codex-host")), { force: true });

    const events: ToolchainProgress[] = [];
    await ensurePinnedToolchains({
      dataDir,
      artifacts: [withCompanion],
      fetchImpl,
      skipExecutableProbeForTests: true,
      onProgress: (event) => events.push(event),
    });

    const downloads = events.filter((event) => event.phase === "downloading");
    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads.every((event) => event.bytesTotal === companionArchive.byteLength)).toBe(true);
    // Same monotonicity guarantee as a fresh install: the repair announces
    // "verifying" only after its last byte is on disk.
    const firstVerifying = events.findIndex((event) => event.phase === "verifying");
    expect(firstVerifying).not.toBe(-1);
    expect(events.slice(firstVerifying)
      .some((event) => event.phase === "downloading")).toBe(false);
    expect(events.at(-1)?.phase).toBe("ready");
    expect(events.at(-1)?.overallFraction).toBe(1);
  });

  test("corrects a companion's permission mode without re-downloading it", async () => {
    const dataDir = await createDataDir();
    const companionBody = COMPANION_BODY;
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const withCompanion = companionArtifact(artifacts[0], companionArchive, companionBody);
    const fetchImpl = createCompanionFetch(companionArchive);

    const result = await ensurePinnedToolchains({
      dataDir,
      artifacts: [withCompanion],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // A companion whose bytes are intact but whose mode has drifted is still
    // considered valid: validation repairs the mode in place instead of
    // re-downloading the archive.
    const versionDir = path.join(dataDir, "toolchains", "codex", "1.2.3", "darwin-arm64");
    const companionPath = path.join(versionDir, "codex-host");
    await chmod(companionPath, 0o755);
    await ensurePinnedToolchains({
      dataDir,
      artifacts: [withCompanion],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await lstat(companionPath)).mode & 0o777).toBe(0o500);
    expect((await readlink(path.join(result.binDir, "codex-host")))).toBe(companionPath);
  });

  test("self-heals an interrupted companion repair on the next launch", async () => {
    const dataDir = await createDataDir();
    const firstBody = Buffer.from("#!/bin/sh\nprintf \"first 1.2.3\\n\"\n");
    const secondBody = Buffer.from("#!/bin/sh\nprintf \"second 1.2.3\\n\"\n");
    const firstArchive = await tarGzip([{ name: "tool-host", body: firstBody }]);
    const secondArchive = await tarGzip([{ name: "second-host", body: secondBody }]);
    const secondUrl = "https://downloads.example.test/second-host.tar.gz";
    const base = companionArtifact(artifacts[0], firstArchive, firstBody);
    const withTwo: ToolchainArtifact = {
      ...base,
      companions: [base.companions![0], {
        fileName: "second-host",
        archive: {
          format: "tar.gz",
          url: secondUrl,
          entryPath: "second-host",
          size: secondArchive.byteLength,
          sha256: sha256(secondArchive),
          allowedHosts: ["downloads.example.test"],
        },
        executable: { size: secondBody.byteLength, sha256: sha256(secondBody) },
      }],
    };
    const fetchImpl = mock(async (input: string) => {
      const body = input === COMPANION_ARCHIVE_URL
        ? firstArchive
        : input === secondUrl ? secondArchive : ZIP_FIXTURE;
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      });
    });

    await ensurePinnedToolchains({
      dataDir,
      artifacts: [withTwo],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const versionDir = path.join(dataDir, "toolchains", "codex", "1.2.3", "darwin-arm64");
    // Simulate a repair that died half-way through its per-file renames: the
    // first companion was renamed in, but a directory now blocks the second
    // companion's rename, so the second rename fails after the first succeeded.
    await rm(path.join(versionDir, "codex-host"), { force: true });
    await rm(path.join(versionDir, "second-host"), { force: true });
    await mkdir(path.join(versionDir, "second-host"));

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [withTwo],
      fetchImpl,
      skipExecutableProbeForTests: true,
    })).rejects.toThrow();

    // Whole files, never truncated: the first companion landed, the second is
    // still blocked, and no staging directory survived the failure.
    expect((await readdir(versionDir)).sort()).toEqual(["codex", "codex-host", "second-host"]);
    expect((await lstat(path.join(versionDir, "codex-host"))).isFile()).toBe(true);
    expect((await lstat(path.join(versionDir, "second-host"))).isDirectory()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect((await readdir(path.join(dataDir, "toolchains")))
      .filter((entry) => entry.startsWith(".staging-"))).toEqual([]);

    // The next launch repairs only what is still missing; the companion the
    // interrupted repair already placed is left alone.
    await rm(path.join(versionDir, "second-host"), { recursive: true, force: true });
    await ensurePinnedToolchains({
      dataDir,
      artifacts: [withTwo],
      fetchImpl,
      skipExecutableProbeForTests: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))[5]).toBe(secondUrl);
    expect((await lstat(path.join(versionDir, "codex-host"))).mode & 0o777).toBe(0o500);
    expect((await lstat(path.join(versionDir, "second-host"))).isFile()).toBe(true);
    expect(await readFile(path.join(versionDir, "second-host"))).toEqual(secondBody);
  });

  test("rejects companion archives whose contents do not match the pinned manifest", async () => {
    const dataDir = await createDataDir();
    const companionBody = COMPANION_BODY;
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const base = companionArtifact(artifacts[0], companionArchive, companionBody);
    const pinned = base.companions![0];
    const withCompanion = (companion: Partial<ToolchainCompanion>): ToolchainArtifact => ({
      ...base,
      companions: [{ ...pinned, ...companion }],
    });
    const reject = async (
      artifact: ToolchainArtifact,
      archiveBody: Buffer,
      message: string,
    ) => {
      const dataDir = await createDataDir();
      const fetchImpl = mock(async (input: string) => {
        const body = input === COMPANION_ARCHIVE_URL ? archiveBody : ZIP_FIXTURE;
        return new Response(body, {
          status: 200,
          headers: { "content-length": String(body.byteLength) },
        });
      });
      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [artifact],
        fetchImpl,
        skipExecutableProbeForTests: true,
      })).rejects.toThrow(message);
      // The primary archive and then the companion archive were both
      // downloaded before the companion's extraction failed.
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(await readdir(path.join(dataDir, "toolchains", "codex")).catch(() => [])).toEqual([]);
    };

    // The archive entry's size does not match the pinned executable size.
    await reject(
      withCompanion({ executable: { ...pinned.executable, size: pinned.executable.size + 1 } }),
      companionArchive,
      "codex-host executable entry did not match the pinned manifest",
    );
    // The archive does not contain the pinned entry at all.
    await reject(
      withCompanion({ archive: { ...pinned.archive, entryPath: "missing-entry" } }),
      companionArchive,
      "codex-host executable was not found in its archive",
    );
    // The archive carries two entries under the pinned name.
    const duplicateArchive = await tarGzip([
      { name: "tool-host", body: companionBody },
      { name: "tool-host", body: companionBody },
    ]);
    await reject(
      companionArtifact(artifacts[0], duplicateArchive, companionBody),
      duplicateArchive,
      "codex-host archive contains a duplicate executable entry",
    );
  });

  test("verifies a companion's macOS code signature without probing it", async () => {
    const dataDir = await createDataDir();
    const companionBody = COMPANION_BODY;
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const withCompanion = companionArtifact(artifacts[0], companionArchive, companionBody);

    // Exactly three: codesign then `--version` for the primary, and codesign
    // alone for the companion. A fourth spawn — a companion `--version` probe —
    // makes createSpawn throw.
    const result = await ensurePinnedToolchains({
      dataDir,
      artifacts: [withCompanion],
      fetchImpl: createCompanionFetch(companionArchive),
      spawnForTests: createSpawn([
        { type: "exit", code: 0 },
        { type: "exit", code: 0, stdout: "codex 1.2.3" },
        { type: "exit", code: 0 },
      ]),
      timingsForTests: { processTimeoutMs: 1_000 },
    });

    expect((await lstat(await readlink(path.join(result.binDir, "codex-host")))).size)
      .toBe(companionBody.byteLength);
  });

  test("rejects a companion with an invalid macOS code signature, leaving nothing activated", async () => {
    const dataDir = await createDataDir();
    const companionBody = COMPANION_BODY;
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const withCompanion = companionArtifact(artifacts[0], companionArchive, companionBody);

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [withCompanion],
      fetchImpl: createCompanionFetch(companionArchive),
      spawnForTests: createSpawn([
        { type: "exit", code: 0 },
        { type: "exit", code: 0, stdout: "codex 1.2.3" },
        { type: "exit", code: 9, stderr: "signature rejected" },
      ]),
      timingsForTests: { processTimeoutMs: 1_000 },
    })).rejects.toThrow("codex-host has an invalid macOS code signature");

    expect(await readdir(path.join(dataDir, "toolchains", "codex")).catch(() => [])).toEqual([]);
    await expect(lstat(path.join(dataDir, "toolchains", ".install.lock"))).rejects.toThrow();
  });

  test("does not verify a companion's signature on a non-darwin artifact", async () => {
    const dataDir = await createDataDir();
    const companionBody = COMPANION_BODY;
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const linuxArtifact: ToolchainArtifact = {
      ...companionArtifact(artifacts[0], companionArchive, companionBody),
      platform: "linux",
      architecture: "x64",
    };

    // One spawn only: the primary `--version` probe. codesign does not exist
    // off darwin, so a companion signature check there would fail the install.
    const result = await ensurePinnedToolchains({
      dataDir,
      artifacts: [linuxArtifact],
      fetchImpl: createCompanionFetch(companionArchive),
      spawnForTests: createSpawn([{ type: "exit", code: 0, stdout: "codex 1.2.3" }]),
      timingsForTests: { processTimeoutMs: 1_000 },
    });

    expect((await lstat(await readlink(path.join(result.binDir, "codex-host")))).size)
      .toBe(companionBody.byteLength);
  });

  test("rejects companion metadata that is not a supported, pinnable archive", async () => {
    const companionBody = COMPANION_BODY;
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const base = companionArtifact(artifacts[0], companionArchive, companionBody);
    const pinned = base.companions![0];
    const withCompanion = (companion: Partial<ToolchainCompanion>): ToolchainArtifact => ({
      ...base,
      companions: [{ ...pinned, ...companion }],
    });
    const fetchImpl = createCompanionFetch(companionArchive);
    const reject = async (artifact: ToolchainArtifact, message: string) => {
      await expect(ensurePinnedToolchains({
        dataDir: await createDataDir(),
        artifacts: [artifact],
        fetchImpl,
        skipExecutableProbeForTests: true,
      })).rejects.toThrow(message);
    };

    await reject(
      withCompanion({
        archive: { ...pinned.archive, format: "rar" as ToolchainCompanion["archive"]["format"] },
      }),
      "companion has an unsupported archive format",
    );
    await reject(
      withCompanion({ executable: { size: 0, sha256: sha256(companionBody) } }),
      "companion codex-host has invalid executable metadata",
    );
    await reject(
      withCompanion({ executable: { size: companionBody.byteLength, sha256: "not-a-digest" } }),
      "companion codex-host has invalid executable metadata",
    );
    await reject(
      withCompanion({ executable: { size: 1.5, sha256: sha256(companionBody) } }),
      "companion codex-host has invalid executable metadata",
    );
    // Metadata is rejected before any network use.
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  test("rejects a companion whose name collides with another tool's activation link", async () => {
    const companionBody = COMPANION_BODY;
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const fetchImpl = createCompanionFetch(companionArchive);
    const hijacksClaude = companionArtifact(
      artifacts[0],
      companionArchive,
      companionBody,
      { fileName: "claude" },
    );

    // Every artifact and companion shares one activation directory, so this
    // would silently replace claude's symlink — and which one won would depend
    // on iteration order. Both orders have to be rejected.
    for (const set of [[hijacksClaude, artifacts[1]], [artifacts[1], hijacksClaude]]) {
      await expect(ensurePinnedToolchains({
        dataDir: await createDataDir(),
        artifacts: set,
        fetchImpl,
        skipExecutableProbeForTests: true,
      })).rejects.toThrow("codex companion claude collides with claude in the shared activation directory");
    }

    // Two different tools claiming the same companion name is the same clash.
    await expect(ensurePinnedToolchains({
      dataDir: await createDataDir(),
      artifacts: [
        companionArtifact(artifacts[0], companionArchive, companionBody, { fileName: "shared-host" }),
        companionArtifact(artifacts[1], companionArchive, companionBody, { fileName: "shared-host" }),
      ],
      fetchImpl,
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("companion shared-host collides with codex in the shared activation directory");

    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  test("rejects unsafe or colliding activation aliases before downloading", async () => {
    const fetchImpl = createFetch();
    await expect(ensurePinnedToolchains({
      dataDir: await createDataDir(),
      artifacts: [{ ...artifacts[0], activationAliases: ["../cursor-agent"] }],
      fetchImpl,
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("manifest has an unsafe or duplicate activation alias");

    const aliasesClaude = { ...artifacts[0], activationAliases: ["claude"] };
    for (const set of [[aliasesClaude, artifacts[1]], [artifacts[1], aliasesClaude]]) {
      await expect(ensurePinnedToolchains({
        dataDir: await createDataDir(),
        artifacts: set,
        fetchImpl,
        skipExecutableProbeForTests: true,
      })).rejects.toThrow("codex activation alias claude collides with claude in the shared activation directory");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  test("gives a companion set its own activation directory", async () => {
    const dataDir = await createDataDir();
    const companionBody = Buffer.from("#!/bin/sh\nprintf \"host 1.2.3\\n\"\n");
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);

    const withoutCompanion = await ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
    });
    const withCompanion = await ensurePinnedToolchains({
      dataDir,
      artifacts: [companionArtifact(artifacts[0], companionArchive, companionBody)],
      fetchImpl: createCompanionFetch(companionArchive),
      skipExecutableProbeForTests: true,
    });

    // A running older build keeps the sibling layout its executable was
    // launched against, so the two sets cannot share one bin directory.
    expect(withCompanion.binDir).not.toBe(withoutCompanion.binDir);
    expect(await readdir(withoutCompanion.binDir)).toEqual(["codex"]);
    expect((await readdir(withCompanion.binDir)).sort()).toEqual(["codex", "codex-host"]);
  });

  test("rejects a companion whose bytes are not pinned, leaving nothing activated", async () => {
    const dataDir = await createDataDir();
    const companionBody = Buffer.from("#!/bin/sh\nprintf \"host 1.2.3\\n\"\n");
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const base = companionArtifact(artifacts[0], companionArchive, companionBody);
    const tampered: ToolchainArtifact = {
      ...base,
      companions: [{
        ...base.companions![0],
        executable: { ...base.companions![0].executable, sha256: "0".repeat(64) },
      }],
    };

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [tampered],
      fetchImpl: createCompanionFetch(companionArchive),
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("codex-host executable checksum did not match the pinned manifest");

    expect(await readdir(path.join(dataDir, "toolchains", "codex")).catch(() => [])).toEqual([]);
  });

  test("rejects companion manifests that could escape the directories it owns", async () => {
    const dataDir = await createDataDir();
    const companionBody = Buffer.from("#!/bin/sh\nprintf \"host 1.2.3\\n\"\n");
    const companionArchive = await tarGzip([{ name: "tool-host", body: companionBody }]);
    const base = companionArtifact(artifacts[0], companionArchive, companionBody);
    const withFileName = (fileName: string): ToolchainArtifact => ({
      ...base,
      companions: [{ ...base.companions![0], fileName }],
    });

    for (const fileName of ["../escape", "nested/host", ".upstream-codex"]) {
      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [withFileName(fileName)],
        fetchImpl: createCompanionFetch(companionArchive),
        skipExecutableProbeForTests: true,
      })).rejects.toThrow("companion has an unsafe file name");
    }

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [{ ...base, companions: [base.companions![0], base.companions![0]] }],
      fetchImpl: createCompanionFetch(companionArchive),
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("companion codex-host is declared twice");

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [withFileName("codex")],
      fetchImpl: createCompanionFetch(companionArchive),
      skipExecutableProbeForTests: true,
    })).rejects.toThrow("companion codex is declared twice");
  });

  test("supports an empty explicit artifact set", async () => {
    const dataDir = await createDataDir();
    const events: ToolchainProgress[] = [];
    const result = await ensurePinnedToolchains({
      dataDir,
      artifacts: [],
      onProgress: (event) => events.push(event),
      skipVersionLeaseForTests: true,
    });

    expect(result.executables).toEqual({});
    expect(path.dirname(result.binDir)).toBe(path.join(dataDir, "toolchains", "bin"));
    expect(events.at(-1)).toMatchObject({ phase: "ready", overallFraction: 1, totalTools: 0 });
  });
});
