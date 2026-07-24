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
import type { ToolchainArtifact } from "../../../apps/desktop/electron/toolchain-manifest";

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

  test("removes a stale dead-owner lock but preserves a stale-looking live-owner lock", async () => {
    const staleDataDir = await createDataDir();
    const staleRoot = path.join(staleDataDir, "toolchains");
    const staleLock = path.join(staleRoot, ".install.lock");
    await mkdir(staleRoot, { recursive: true });
    await writeFile(staleLock, JSON.stringify({ token: "dead", pid: 999_999, createdAt: new Date(0).toISOString() }));
    await utimes(staleLock, new Date(0), new Date(0));

    const staleResult = await ensurePinnedToolchains({
      dataDir: staleDataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
      processExistsForTests: () => false,
      timingsForTests: { lockPollMs: 1, lockStaleAfterMs: 1, lockWaitTimeoutMs: 100 },
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
        timeout: 1_000,
      },
      {
        body: Buffer.from("#!/bin/sh\nexit 7\n"),
        message: "version check failed (code 7",
        timeout: 1_000,
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
  });

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
  });

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
