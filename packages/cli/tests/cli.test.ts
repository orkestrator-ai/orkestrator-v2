import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const temporaryDirectories: string[] = [];
const processes: Bun.Subprocess[] = [];

afterAll(async () => {
  for (const child of processes) child.kill("SIGTERM");
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("orkestrator CLI package", () => {
  test("publishes a Bun executable with the application release version", async () => {
    const manifest = await Bun.file(path.join(packageRoot, "package.json")).json() as {
      name?: string;
      version?: string;
      bin?: Record<string, string>;
      files?: string[];
      os?: string[];
    };
    const rootManifest = await Bun.file(path.join(repositoryRoot, "package.json")).json() as {
      version?: string;
    };
    const executable = await readFile(path.join(packageRoot, "bin/orkestrator.js"), "utf8");

    expect(manifest.name).toBe("orkestrator");
    expect(manifest.version).toBe(rootManifest.version);
    expect(manifest.bin).toEqual({ orkestrator: "bin/orkestrator.js" });
    expect(manifest.files).toContain("dist/");
    expect(manifest.files).toContain("resources/");
    expect(manifest.os).toEqual(["darwin", "linux"]);
    expect(executable.startsWith("#!/usr/bin/env bun\n")).toBe(true);
  });

  test("stages a self-contained backend and both bridge entrypoints", async () => {
    await expect(Bun.file(path.join(packageRoot, "dist/main.js")).exists()).resolves.toBe(true);
    await expect(
      Bun.file(path.join(packageRoot, "resources/claude-bridge/dist/index.js")).exists(),
    ).resolves.toBe(true);
    await expect(
      Bun.file(path.join(packageRoot, "resources/codex-bridge/dist/index.js")).exists(),
    ).resolves.toBe(true);
  });

  test("starts and gracefully stops the packaged backend", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-cli-test-"));
    temporaryDirectories.push(dataDir);
    const child = Bun.spawn([
      process.execPath,
      path.join(packageRoot, "bin/orkestrator.js"),
      "--host", "127.0.0.1",
      "--port", "0",
      "--allow-non-tailscale-bind",
      "--data-dir", dataDir,
    ], {
      cwd: dataDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    processes.push(child);

    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 10_000;
    let pending = "";
    let ready: { type?: string; authFile?: string } | undefined;
    while (!ready && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { type?: string; authFile?: string };
          if (message.type === "orkestrator-backend-ready") ready = message;
        } catch {
          // Human-readable startup logs precede the readiness contract.
        }
      }
    }

    if (!ready) {
      child.kill("SIGTERM");
      throw new Error(`Packaged backend did not become ready: ${await new Response(child.stderr).text()}`);
    }
    expect(ready.authFile).toBe(path.join(dataDir, "gateway-auth.json"));

    child.kill("SIGTERM");
    await expect(child.exited).resolves.toBe(0);
  });
});
