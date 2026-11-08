import { afterEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { runClient } from "../src/client/main.js";
import { captureIo, createSandbox, type ClientSandbox } from "./support/client-harness.js";

const sandboxes: ClientSandbox[] = [];
const installCalls: Array<{ dataDir: string; tools?: readonly string[]; signal?: AbortSignal }> =
  [];
let installFailure: Error | null = null;
/** Runs inside the fake install, before it settles. */
let duringInstall: ((signal: AbortSignal | undefined) => Promise<void>) | null = null;

mock.module("@orkestrator/toolchain/install", () => ({
  isToolchainName: (name: string) => ["claude", "codex", "pi"].includes(name),
  planToolchainInstall: async () => {
    throw new Error("Unexpected plan");
  },
  createProgressLogger: () => () => undefined,
  installPinnedToolchains: async (options: {
    dataDir: string;
    tools?: readonly string[];
    signal?: AbortSignal;
  }) => {
    installCalls.push(options);
    await duringInstall?.(options.signal);
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
  duringInstall = null;
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

  test.each(["SIGINT", "SIGTERM"] as const)(
    "the first %s cancels the install and exits as interrupted",
    async (name) => {
      const box = await sandbox();
      const controller = new AbortController();
      duringInstall = (signal) =>
        new Promise<void>((_, reject) => {
          // Stands in for the installer: it rejects once the signal it was given fires.
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          controller.abort(name);
        });
      const io = captureIo(box.env, box.root);
      const code = await runClient(["toolchain", "install", "--json", "--tool", "claude"], {
        io,
        version: "9.9.9",
        signal: controller.signal,
      });

      expect(installCalls[0]?.signal).toBe(controller.signal);
      expect(code).toBe(name === "SIGINT" ? 130 : 143);
      expect(JSON.parse(io.out.join("")).error).toMatchObject({ code: "observation-interrupted" });
    },
  );
});
