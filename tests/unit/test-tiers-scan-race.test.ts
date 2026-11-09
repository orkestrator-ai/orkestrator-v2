/**
 * Flake 9902: the slow-tier scan must survive a build rewriting `dist/` under
 * the package it scans. A real child process rebuilds and deletes a
 * `dist/artifact-runtime` tree while this process scans; before the fix the
 * scan listed a directory the build then deleted and threw ENOENT on most
 * iterations. Slow tier: it races a real process for a few hundred cycles.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { slowTestFiles } from "../../scripts/test-tiers";

const CHURN = `
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const [pkg, cycles] = [process.argv[2], Number(process.argv[3])];
for (let n = 0; n < cycles; n++) {
  const licenses = path.join(pkg, "dist/artifact-runtime/worker-context/licenses");
  for (let i = 0; i < 40; i++) {
    const dir = path.join(licenses, "dependency" + i + "@1." + n);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "LICENSE"), "x");
  }
  rmSync(path.join(pkg, "dist"), { recursive: true, force: true });
}
`;

const roots: string[] = [];
const children: Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the slow-tier scan tolerates a concurrent dist rebuild", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-tier-race-"));
  roots.push(root);
  const pkg = path.join(root, "apps/backend");
  for (const file of ["src/core/a.live.test.ts", "tests/tmux-x.test.ts", "src/kept.test.ts"]) {
    mkdirSync(path.dirname(path.join(pkg, file)), { recursive: true });
    writeFileSync(path.join(pkg, file), "");
  }
  const script = path.join(root, "churn.cjs");
  writeFileSync(script, CHURN);
  const child = Bun.spawn([process.execPath, script, pkg, "300"], {
    stdout: "ignore",
    stderr: "inherit",
  });
  children.push(child);

  const failures: string[] = [];
  let scans = 0;
  while (child.exitCode === null) {
    try {
      expect(slowTestFiles(root, "apps/backend")).toEqual([
        "src/core/a.live.test.ts",
        "tests/tmux-x.test.ts",
      ]);
    } catch (error) {
      failures.push(String(error));
    }
    scans++;
    await Bun.sleep(0);
  }
  expect(await child.exited).toBe(0);
  expect(scans).toBeGreaterThan(10);
  expect(failures.slice(0, 3)).toEqual([]);
}, 60_000);
