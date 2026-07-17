import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readlink, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function tarGzip(entries: Array<{ name: string; body: Buffer }>): Promise<Buffer> {
  const pack = tar.pack();
  const collecting = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of pack) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  })();
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: entry.name, size: entry.body.byteLength }, entry.body, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  pack.finalize();
  return gzipSync(await collecting);
}

describe("pinned desktop toolchain cache", () => {
  test("installs ZIP and tar.gz artifacts once, activates them, and reuses verified files", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();

    const [first, concurrent] = await Promise.all([
      ensurePinnedToolchains({ dataDir, artifacts, fetchImpl, skipExecutableProbeForTests: true }),
      ensurePinnedToolchains({ dataDir, artifacts, fetchImpl, skipExecutableProbeForTests: true }),
    ]);

    expect(first.binDir).toBe(path.join(dataDir, "toolchains", "bin"));
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

    await ensurePinnedToolchains({ dataDir, artifacts, fetchImpl, skipExecutableProbeForTests: true });
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

    await expect(lstat(path.join(dataDir, "toolchains", "bin", "codex"))).rejects.toThrow();
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
    await expect(second).resolves.toMatchObject({ binDir: path.join(dataDir, "toolchains", "bin") });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("removes a stale dead-owner lock but preserves a stale-looking live-owner lock", async () => {
    const staleDataDir = await createDataDir();
    const staleRoot = path.join(staleDataDir, "toolchains");
    const staleLock = path.join(staleRoot, ".install.lock");
    await mkdir(staleRoot, { recursive: true });
    await writeFile(staleLock, JSON.stringify({ token: "dead", pid: 999_999, createdAt: new Date(0).toISOString() }));
    await utimes(staleLock, new Date(0), new Date(0));

    await expect(ensurePinnedToolchains({
      dataDir: staleDataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
      processExistsForTests: () => false,
      timingsForTests: { lockPollMs: 1, lockStaleAfterMs: 1, lockWaitTimeoutMs: 100 },
    })).resolves.toMatchObject({ binDir: path.join(staleRoot, "bin") });

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

    await expect(ensurePinnedToolchains({
      dataDir,
      artifacts: [artifacts[0]],
      fetchImpl: createFetch(),
      skipExecutableProbeForTests: true,
    })).resolves.toMatchObject({ binDir: path.join(dataDir, "toolchains", "bin") });
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
    const cases = [
      { artifact: artifactWithBody(artifacts[0], Buffer.from("not a zip")), body: Buffer.from("not a zip"), message: "central directory" },
      { artifact: artifactWithBody(artifacts[0], unsafeZip), body: unsafeZip, message: "invalid relative path" },
      { artifact: { ...artifacts[0], archive: { ...artifacts[0].archive, entryPath: "missing" } }, body: ZIP_FIXTURE, message: "was not found" },
      { artifact: { ...artifacts[0], executable: { ...artifacts[0].executable, size: EXECUTABLE_SIZE - 1 } }, body: ZIP_FIXTURE, message: "entry did not match" },
      { artifact: { ...artifacts[0], executable: { ...artifacts[0].executable, sha256: "0".repeat(64) } }, body: ZIP_FIXTURE, message: "executable checksum" },
      { artifact: { ...artifacts[0], executable: { ...artifacts[0].executable, installedSha256: "0".repeat(64), installedSize: EXECUTABLE_SIZE } }, body: ZIP_FIXTURE, message: "installed executable" },
      { artifact: artifactWithBody(artifacts[1], duplicateTar), body: duplicateTar, message: "duplicate executable entry" },
    ];

    for (const failure of cases) {
      const dataDir = await createDataDir();
      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [failure.artifact],
        fetchImpl: async () => response(failure.body, {
          status: 200,
          headers: { "content-length": String(failure.body.byteLength) },
        }),
        skipExecutableProbeForTests: true,
      })).rejects.toThrow(failure.message);
    }
  });

  test("probes installed executables and rejects unexpected versions", async () => {
    const executableArtifact: ToolchainArtifact = { ...artifacts[0], platform: "linux" };
    const successDataDir = await createDataDir();
    await expect(ensurePinnedToolchains({
      dataDir: successDataDir,
      artifacts: [executableArtifact],
      fetchImpl: createFetch(),
    })).resolves.toMatchObject({ binDir: path.join(successDataDir, "toolchains", "bin") });

    const failureDataDir = await createDataDir();
    await expect(ensurePinnedToolchains({
      dataDir: failureDataDir,
      artifacts: [{ ...executableArtifact, version: "9.9.9" }],
      fetchImpl: createFetch(),
    })).rejects.toThrow("reported an unexpected version");
  });

  if (process.platform === "darwin") {
    test("rejects an unsigned macOS executable when repair is not allowed", async () => {
      const dataDir = await createDataDir();
      await expect(ensurePinnedToolchains({
        dataDir,
        artifacts: [artifacts[0]],
        fetchImpl: createFetch(),
        timingsForTests: { processTimeoutMs: 1_000 },
      })).rejects.toThrow("invalid macOS code signature");
    });
  }

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
});
