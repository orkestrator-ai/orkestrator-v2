import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureGrokRuntime } from "./grok-runtime.js";

describe("Grok ACP runtime", () => {
  test("defaults an unspecified provider to Grok", () => {
    const environment: NodeJS.ProcessEnv = {};
    configureGrokRuntime(environment);
    expect(environment.ACP_PROVIDER).toBe("grok");
  });

  test("accepts an explicit Grok provider", () => {
    const environment: NodeJS.ProcessEnv = { ACP_PROVIDER: "grok" };
    configureGrokRuntime(environment);
    expect(environment.ACP_PROVIDER).toBe("grok");
  });

  test("rejects the removed Cursor ACP interface", () => {
    const environment: NodeJS.ProcessEnv = { ACP_PROVIDER: "cursor" };
    expect(() => configureGrokRuntime(environment)).toThrow("acp-bridge only supports grok");
    expect(environment.ACP_PROVIDER).toBe("cursor");
  });

  test("the built entrypoint rejects Cursor before the bridge module evaluates", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "orkestrator-grok-entry-"));
    const bundle = path.join(directory, "index.js");
    try {
      const build = spawnSync(
        process.execPath,
        [
          "build",
          path.join(import.meta.dir, "grok-entry.ts"),
          "--target=node",
          "--format=esm",
          `--outfile=${bundle}`,
        ],
        { cwd: path.join(import.meta.dir, ".."), encoding: "utf8" },
      );
      expect(build.status).toBe(0);

      const execution = spawnSync(process.execPath, [bundle], {
        env: { ...process.env, ACP_PROVIDER: "cursor" },
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(execution.signal).toBeNull();
      expect(execution.status).not.toBe(0);
      expect(`${execution.stdout}\n${execution.stderr}`).toContain("acp-bridge only supports grok");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
