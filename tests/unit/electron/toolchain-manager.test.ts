import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmod, lstat, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensurePinnedToolchains } from "../../../apps/desktop/electron/toolchain-manager";
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
});
