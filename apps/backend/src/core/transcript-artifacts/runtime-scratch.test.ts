import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PREVIEW_SCRATCH_PREFIX, PREVIEW_SCRATCH_STALE_MS } from "./preview-supervisor.js";

for (const isolation of ["process", "disabled", "container"]) {
  test(`backend startup recovers stale scratch only in process isolation: ${isolation}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ork-runtime-scratch-"));
    const live = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => live.once("exit", () => resolve()));
    try {
      const dead = spawnSync(process.execPath, ["--eval", ""], { timeout: 5_000 });
      expect(dead.status).toBe(0);
      expect(dead.pid).toBeGreaterThan(1);
      expect(live.pid).toBeGreaterThan(1);
      const stale = path.join(root, `${PREVIEW_SCRATCH_PREFIX}${dead.pid}-aB3dE9`);
      const active = path.join(root, `${PREVIEW_SCRATCH_PREFIX}${live.pid}-aB3dE9`);
      for (const dir of [stale, active]) {
        mkdirSync(dir);
        const old = new Date(Date.now() - PREVIEW_SCRATCH_STALE_MS - 60_000);
        utimesSync(dir, old, old);
      }
      const docker = path.join(root, "docker");
      writeFileSync(docker, "#!/bin/sh\nexit 0\n");
      chmodSync(docker, 0o755);
      const child = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dir, "fixtures/runtime-scratch-startup.ts"),
          isolation,
          root,
          docker,
        ],
        {
          env: { ...process.env, TMPDIR: root },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const configuration = child.stdout
        .split("\n")
        .find((line) => line.startsWith('{"isolation":'));
      expect(configuration).toBeDefined();
      expect(JSON.parse(configuration!)).toEqual({ isolation });
      expect(existsSync(active)).toBe(true);
      expect(existsSync(stale)).toBe(isolation !== "process");
      if (isolation === "process")
        expect(child.stderr).toContain("removed 1 stale preview scratch directory");
      else expect(child.stderr).not.toContain("stale preview scratch");
    } finally {
      live.kill("SIGKILL");
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
}
