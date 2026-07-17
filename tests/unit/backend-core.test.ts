import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "../../apps/backend/src/core/index";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("OrkestratorBackend", () => {
  test("initializes persistent storage and passes the managed toolchain directory to commands", async () => {
    const root = await createTempDir("ork-backend-core-");
    const dataDir = path.join(root, "data");
    const toolchainBinDir = path.join(root, "toolchains", "bin");
    await mkdir(toolchainBinDir, { recursive: true });
    await writeFile(path.join(toolchainBinDir, "codex"), "managed codex");

    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
    });

    await backend.init();

    await expect(backend.invoke("check_codex_cli")).resolves.toBe(true);
    await expect(backend.invoke<{ version: string }>("get_config")).resolves.toMatchObject({
      version: "1.0.0",
    });
    await expect(backend.invoke("unknown-command")).rejects.toThrow(
      "Unknown backend command: unknown-command",
    );
  });
});
