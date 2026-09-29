import { afterEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { createSandbox, type ClientSandbox } from "./support/client-harness.js";

const sandboxes: ClientSandbox[] = [];
const installCalls: Array<{ dataDir: string; tools?: readonly string[] }> = [];
let installFailure: Error | null = null;

mock.module("@orkestrator/toolchain/install", () => ({
  isToolchainName: (name: string) => ["claude", "codex", "pi"].includes(name),
  planToolchainInstall: async () => {
    throw new Error("Unexpected plan");
  },
  createProgressLogger: () => () => undefined,
  installPinnedToolchains: async (options: { dataDir: string; tools?: readonly string[] }) => {
    installCalls.push(options);
    if (installFailure) throw installFailure;
    const rootDir = path.join(options.dataDir, "toolchains");
    return {
      dataDir: options.dataDir,
      rootDir,
      binDir: path.join(rootDir, "bin", "set-a"),
      currentBinDir: path.join(rootDir, "bin", "current"),
      source: "explicit",
      tools: ["claude"],
      versions: { claude: "1.2.3" },
      executables: { claude: path.join(rootDir, "bin", "set-a", "claude") },
      dropped: ["codex"],
    };
  },
}));

afterEach(async () => {
  installFailure = null;
  installCalls.length = 0;
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.cleanup()));
});

async function sandbox(): Promise<ClientSandbox> {
  const created = await createSandbox();
  sandboxes.push(created);
  return created;
}

describe("toolchain install command", () => {
  test("prints the current pointer as ID and warns about dropped tools", async () => {
    const box = await sandbox();
    const dataDir = path.join(box.root, "data");
    const id = await box.run([
      "toolchain",
      "install",
      "--tool",
      "claude",
      "--data-dir",
      dataDir,
      "--output",
      "id",
    ]);
    expect(id.code).toBe(0);
    expect(id.out.trim()).toBe(path.join(dataDir, "toolchains", "bin", "current"));
    expect(installCalls).toMatchObject([{ dataDir, tools: ["claude"] }]);

    const human = await box.run([
      "toolchain",
      "install",
      "--tool",
      "claude",
      "--data-dir",
      dataDir,
    ]);
    expect(human.code).toBe(0);
    expect(human.err).toContain("This set no longer includes: codex");
    expect(human.out).toContain(path.join(dataDir, "toolchains", "bin", "current"));
  });

  test("wraps installer failures as retryable operation failures", async () => {
    const box = await sandbox();
    installFailure = new Error("digest mismatch");
    const failure = await box.run(["toolchain", "install", "--json", "--tool", "claude"]);
    expect(failure.code).not.toBe(0);
    expect(JSON.parse(failure.out).error).toMatchObject({
      code: "operation-failed",
      retryable: true,
      message: "digest mismatch",
    });
  });
});
