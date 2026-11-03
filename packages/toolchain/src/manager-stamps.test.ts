import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { STAMP_FILE } from "./file-stamps.js";
import { ensurePinnedToolchains, type EnsurePinnedToolchainsOptions } from "./manager.js";
import type { ToolchainArtifact } from "./manifest.js";

// Launch-level behaviour of verified stamps and resumable downloads. Hash and
// download mechanics are covered in file-stamps.test.ts and download.test.ts.

const BODY = Buffer.from("#!/bin/sh\nprintf 'codex 1.2.3\\n'\n");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

const artifact: ToolchainArtifact = {
  name: "codex",
  version: "1.2.3",
  platform: "darwin",
  architecture: "arm64",
  archive: {
    format: "raw",
    url: "https://downloads.example.test/codex",
    entryPath: "",
    size: BODY.byteLength,
    sha256: sha256(BODY),
    allowedHosts: ["downloads.example.test"],
  },
  executable: { fileName: "codex", size: BODY.byteLength, sha256: sha256(BODY) },
};

const repairable: ToolchainArtifact = {
  ...artifact,
  executable: { ...artifact.executable, repairInvalidMacSignature: true },
};

async function createDataDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-toolchain-stamps-"));
  directories.push(directory);
  return directory;
}

function createFetch() {
  return mock(async () => new Response(BODY, { status: 200 }));
}

function launch(
  dataDir: string,
  fetchImpl: EnsurePinnedToolchainsOptions["fetchImpl"],
  options: Partial<EnsurePinnedToolchainsOptions> = {},
) {
  return ensurePinnedToolchains({
    dataDir,
    artifacts: [artifact],
    fetchImpl,
    skipExecutableProbeForTests: true,
    skipVersionLeaseForTests: true,
    ...options,
    // Stamps taken moments after the fixture wrote its files are otherwise
    // (correctly) treated as racy and re-hashed.
    timingsForTests: { racyStampWindowMs: -60_000, ...options.timingsForTests },
  });
}

async function stamps(dataDir: string) {
  return JSON.parse(await readFile(path.join(dataDir, "toolchains", STAMP_FILE), "utf8")) as {
    fullCheckAt: number;
    files: Record<string, { stampedAtNs: string; sha256: string }>;
    derived: Record<string, string>;
  };
}

describe("verified stamps across launches", () => {
  test("an unchanged toolchain is not hashed again on the next launch", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const first = await launch(dataDir, fetchImpl);
    const executablePath = await readlink(first.executables.codex);
    const recorded = (await stamps(dataDir)).files[executablePath];
    expect(recorded?.sha256).toBe(sha256(BODY));

    await launch(dataDir, fetchImpl);
    await launch(dataDir, fetchImpl);

    // A re-hash would have taken a new stamp; the original one was reused.
    expect((await stamps(dataDir)).files[executablePath]).toEqual(recorded!);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("desktop subset then combined checks retain both tools across launches", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const support: ToolchainArtifact = {
      ...artifact,
      name: "gh",
      executable: { ...artifact.executable, fileName: "gh" },
    };
    const desktopStartup = async () => {
      await launch(dataDir, fetchImpl);
      return launch(dataDir, fetchImpl, { artifacts: [artifact, support] });
    };
    const first = await desktopStartup();
    const paths = await Promise.all(Object.values(first.executables).map((file) => readlink(file)));
    const before = await stamps(dataDir);
    // Make a re-hash observably different even on a fast filesystem.
    for (const file of paths)
      before.files[file]!.stampedAtNs = String(
        BigInt(before.files[file]!.stampedAtNs) - 1_000_000n,
      );
    await writeFile(path.join(dataDir, "toolchains", STAMP_FILE), JSON.stringify(before));
    for (let launchNumber = 0; launchNumber < 2; launchNumber += 1) {
      await desktopStartup();
    }
    for (const file of paths)
      expect((await stamps(dataDir)).files[file]).toEqual(before.files[file]!);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("companion failure retains the completed primary archive for the next attempt", async () => {
    const dataDir = await createDataDir();
    const companionBody = Buffer.from('#!/bin/sh\nprintf "tool 1.2.3\\n"\n');
    const companionZip = Buffer.from(
      "UEsDBAoAAAAAADMD8VyEaD1TIAAAACAAAAAEAAAAdG9vbCMhL2Jpbi9zaApwcmludGYgInRvb2wgMS4yLjNcbiIKUEsBAh4DCgAAAAAAMwPxXIRoPVMgAAAAIAAAAAQAAAAAAAAAAQABAECBAAAAAHRvb2xQSwUGAAAAAAEAAQAyAAAAQgAAAAAA",
      "base64",
    );
    const companionArchive = {
      ...artifact.archive,
      url: "https://downloads.example.test/companion",
      format: "zip" as const,
      entryPath: "tool",
      size: companionZip.length,
      sha256: sha256(companionZip),
    };
    const withCompanion: ToolchainArtifact = {
      ...artifact,
      companions: [
        {
          fileName: "codex-helper",
          archive: companionArchive,
          executable: { size: companionBody.length, sha256: sha256(companionBody) },
        },
      ],
    };
    let failCompanion = true;
    const requests: string[] = [];
    const fetchImpl = mock(async (url: string) => {
      requests.push(url);
      if (url === companionArchive.url) {
        if (failCompanion) return new Response(null, { status: 503 });
        return new Response(companionZip);
      }
      return new Response(BODY);
    });
    await expect(launch(dataDir, fetchImpl, { artifacts: [withCompanion] })).rejects.toThrow(
      "HTTP 503",
    );
    failCompanion = false;
    const result = await launch(dataDir, fetchImpl, { artifacts: [withCompanion] });
    expect(requests).toEqual([artifact.archive.url, companionArchive.url, companionArchive.url]);
    const executablePath = await readlink(result.executables.codex);
    expect(await readFile(executablePath)).toEqual(BODY);
    expect(await readFile(path.join(path.dirname(executablePath), "codex-helper"))).toEqual(
      companionBody,
    );
    expect(await readdir(path.join(dataDir, "toolchains", ".downloads"))).toEqual([]);
  });

  test("any change to an installed file is hashed and repaired", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const first = await launch(dataDir, fetchImpl);
    const executablePath = await readlink(first.executables.codex);
    const before = (await stamps(dataDir)).files[executablePath]!;

    // Same size, so only the digest can tell.
    await chmod(executablePath, 0o700);
    await writeFile(executablePath, Buffer.alloc(BODY.byteLength, 0x41));
    await launch(dataDir, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await readFile(executablePath)).toEqual(BODY);
    expect((await stamps(dataDir)).files[executablePath]!.stampedAtNs).not.toBe(before.stampedAtNs);
  });

  test("a periodic full check hashes every file even when stamps match", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const first = await launch(dataDir, fetchImpl);
    const executablePath = await readlink(first.executables.codex);
    const before = await stamps(dataDir);

    await launch(dataDir, fetchImpl, { timingsForTests: { fullCheckIntervalMs: 0 } });
    const after = await stamps(dataDir);

    expect(after.files[executablePath]!.stampedAtNs).not.toBe(
      before.files[executablePath]!.stampedAtNs,
    );
    expect(after.fullCheckAt).toBeGreaterThanOrEqual(before.fullCheckAt);
  });

  test("an explicit full verification ignores stamps", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const first = await launch(dataDir, fetchImpl);
    const executablePath = await readlink(first.executables.codex);
    const before = (await stamps(dataDir)).files[executablePath]!;

    await launch(dataDir, fetchImpl, { fullVerification: true });

    expect((await stamps(dataDir)).files[executablePath]!.stampedAtNs).not.toBe(before.stampedAtNs);
  });

  test("final verification still catches a change made after the initial check", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const first = await launch(dataDir, fetchImpl);
    const executablePath = await readlink(first.executables.codex);

    await expect(
      launch(dataDir, fetchImpl, {
        beforeFinalVerificationForTests: async () => {
          await chmod(executablePath, 0o700);
          await writeFile(executablePath, Buffer.alloc(BODY.byteLength, 0x41));
        },
      }),
    ).rejects.toThrow("failed final verification");
  });

  test("an untouched re-signed copy is reused, and a changed one is produced again", async () => {
    const dataDir = await createDataDir();
    const fetchImpl = createFetch();
    const first = await launch(dataDir, fetchImpl, { artifacts: [repairable] });
    const executablePath = await readlink(first.executables.codex);
    const produced = await lstat(executablePath);
    expect((await stamps(dataDir)).derived[executablePath]).toBe(sha256(BODY));

    await launch(dataDir, fetchImpl, { artifacts: [repairable] });
    // Re-creating the copy renames a new file into place, so its inode moves.
    expect((await lstat(executablePath)).ino).toBe(produced.ino);

    await chmod(executablePath, 0o700);
    await writeFile(executablePath, "substituted");
    await launch(dataDir, fetchImpl, { artifacts: [repairable] });
    expect(await readFile(executablePath)).toEqual(BODY);
    expect((await lstat(executablePath)).mode & 0o777).toBe(0o500);
    const reproduced = await lstat(executablePath);
    expect(reproduced.ino).not.toBe(produced.ino);

    await launch(dataDir, fetchImpl, { artifacts: [repairable], fullVerification: true });
    expect((await lstat(executablePath)).ino).not.toBe(reproduced.ino);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a download interrupted on one launch resumes on the next", async () => {
    const dataDir = await createDataDir();
    const ranges: Array<string | null> = [];
    let interrupt = true;
    const fetchImpl = mock(async (_input: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      ranges.push(range);
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : 0;
      const slice = BODY.subarray(start);
      let delivered = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(new Uint8Array(interrupt ? slice.subarray(0, 10) : slice));
          } else if (interrupt) {
            // A stream that errors discards what is still queued, so the
            // interruption comes on the pull after the bytes.
            controller.error(new Error("connection reset"));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: range ? 206 : 200,
        headers: range
          ? { "content-range": `bytes ${start}-${BODY.byteLength - 1}/${BODY.byteLength}` }
          : {},
      });
    });

    await expect(
      launch(dataDir, fetchImpl, { timingsForTests: { downloadAttempts: 1 } }),
    ).rejects.toThrow("connection reset");
    interrupt = false;
    const result = await launch(dataDir, fetchImpl);

    expect(ranges).toEqual([null, "bytes=10-"]);
    expect(await readFile(await readlink(result.executables.codex))).toEqual(BODY);
    expect(await readdir(path.join(dataDir, "toolchains", ".downloads"))).toEqual([]);
  });
});
