import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  KEEP_PRIVATE_TMPDIR_ENV,
  PRIVATE_TMPDIR_ENV,
  PRIVATE_TMPDIR_PREFIX,
  privateTmpdirRoot,
} from "../private-tmpdir";
import { PARENT_TMPDIR_ENV } from "../temp-sweep";

// Each case runs in a fresh process: this test process already has its own
// private TMPDIR from the preload, which a nested call would reuse.

const HOUR_MS = 60 * 60 * 1_000;
const MODULE = path.join(import.meta.dir, "../private-tmpdir.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "orkestrator-private-tmpdir-test-"));
  roots.push(root);
  return root;
}

/** Runs `body` after `enterPrivateTestTmpdir()` in a child whose TMPDIR is `root`. */
function runChild(
  root: string,
  body: string,
  env: Record<string, string> = {},
  setup = "",
  sandbox = false,
) {
  const inherited = { ...process.env };
  delete inherited[PRIVATE_TMPDIR_ENV];
  delete inherited[PARENT_TMPDIR_ENV];
  delete inherited[KEEP_PRIVATE_TMPDIR_ENV];
  const script = `
    const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    ${setup}
    const { enterPrivateTestTmpdir } = await import(${JSON.stringify(MODULE)});
    const out = {};
    const leave = enterPrivateTestTmpdir(typeof preferredRoot === "string" ? preferredRoot : undefined);
    out.inside = tmpdir();
    ${body}
    leave();
    out.after = tmpdir();
    out.removed = !existsSync(out.inside);
    console.log(JSON.stringify(out));
  `;
  const args = ["--eval", script];
  const policy = `(version 1) (allow default) (deny file-write* (subpath "/private/tmp"))
    (allow file-write* (subpath ${JSON.stringify(root)}))`;
  const result = spawnSync(
    sandbox ? "/usr/bin/sandbox-exec" : process.execPath,
    sandbox ? ["-p", policy, process.execPath, ...args] : args,
    {
      env: { ...inherited, TMPDIR: root, ...env },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return { pid: result.pid, ...JSON.parse(result.stdout.trim().split("\n").at(-1)!) };
}

function aged(target: string, ageMs: number): string {
  mkdirSync(target);
  roots.push(target);
  const modified = new Date(Date.now() - ageMs);
  utimesSync(target, modified, modified);
  return target;
}

describe("enterPrivateTestTmpdir", () => {
  test("gives the process a PID-named TMPDIR and removes it with what was left inside", () => {
    const root = createRoot();
    const result = runChild(
      root,
      `mkdirSync(join(tmpdir(), "playwright_chromiumdev_profile-AbC123", "Default"), { recursive: true });
       writeFileSync(join(tmpdir(), "leftover"), "");`,
    );
    roots.push(result.inside);
    expect(path.dirname(result.inside)).toBe(privateTmpdirRoot(root));
    expect(path.basename(result.inside)).toMatch(
      new RegExp(`^${PRIVATE_TMPDIR_PREFIX}${result.pid}-[A-Za-z0-9]{6}$`),
    );
    expect(result.after).toBe(root);
    expect(result.removed).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  for (const code of ["EPERM", "EACCES", "EROFS"]) {
    test(`falls back to the existing TMPDIR on ${code}`, () => {
      const root = createRoot();
      const result = runChild(
        root,
        `writeFileSync(join(tmpdir(), "usable"), "yes");`,
        {},
        `
        const { mock } = await import("bun:test");
        const sweepPath = ${JSON.stringify(path.join(import.meta.dir, "../temp-sweep.ts"))};
        const real = { ...await import(sweepPath) };
        const preferredRoot = join(${JSON.stringify(root)}, "preferred");
        let calls = 0;
        mock.module(sweepPath, () => ({ ...real, createOwnedTempDir: (prefix, parent) => {
          if (++calls === 1) throw Object.assign(new Error("denied"), { code: ${JSON.stringify(code)} });
          if (parent !== ${JSON.stringify(root)}) throw new Error("wrong fallback root");
          return real.createOwnedTempDir(prefix, parent);
        }}));
      `,
      );
      roots.push(result.inside);
      expect(path.dirname(result.inside)).toBe(root);
      expect(result.after).toBe(root);
      expect(result.removed).toBe(true);
    });
  }

  test("leaves all TMPDIR ownership variables unchanged when creation fails everywhere", () => {
    const root = createRoot();
    const result = runChild(
      root,
      `
      writeFileSync(join(tmpdir(), "usable"), "yes");
      out.private = process.env.${PRIVATE_TMPDIR_ENV} ?? null;
      out.parent = process.env.${PARENT_TMPDIR_ENV} ?? null;
    `,
      {},
      `
      const { mock } = await import("bun:test");
      const sweepPath = ${JSON.stringify(path.join(import.meta.dir, "../temp-sweep.ts"))};
      const real = { ...await import(sweepPath) };
      const preferredRoot = join(${JSON.stringify(root)}, "preferred");
      mock.module(sweepPath, () => ({ ...real, createOwnedTempDir: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }}));
    `,
    );
    expect(result.inside).toBe(root);
    expect(result.after).toBe(root);
    expect(result.private).toBeNull();
    expect(result.parent).toBeNull();
    expect(result.removed).toBe(false);
  });

  test("an unreadable sweep root does not prevent private directory creation", () => {
    const root = createRoot();
    const result = runChild(
      root,
      `writeFileSync(join(tmpdir(), "usable"), "yes");`,
      {},
      `
      const { mock } = await import("bun:test");
      const fs = { ...await import("node:fs") };
      mock.module("node:fs", () => ({ ...fs, readdirSync: (target, ...args) => {
        if (target === ${JSON.stringify(privateTmpdirRoot(root))})
          throw Object.assign(new Error("cannot list root"), { code: "EACCES" });
        return fs.readdirSync(target, ...args);
      }}));
    `,
    );
    roots.push(result.inside);
    expect(result.inside).not.toBe(root);
    expect(result.after).toBe(root);
    expect(result.removed).toBe(true);
  });

  test.skipIf(process.platform !== "darwin")(
    "works in a macOS sandbox writable only beneath the existing TMPDIR",
    () => {
      const root = createRoot();
      const result = runChild(
        root,
        `writeFileSync(join(tmpdir(), "usable"), "yes");`,
        {},
        "",
        true,
      );
      roots.push(result.inside);
      expect(path.dirname(result.inside)).toBe(root);
      expect(result.after).toBe(root);
      // A sandbox may also deny spawning ps; teardown then conservatively retains
      // the directory. Creation and the original usable TMPDIR are the contract.
    },
  );

  test("retains its own directory while an outliving process names it", () => {
    const root = createRoot();
    const result = runChild(
      root,
      `
      writeFileSync(join(tmpdir(), "profile"), "");
      const { spawn } = require("node:child_process");
      const browser = spawn(process.execPath,
        ["--eval", "setInterval(() => {}, 1000)", "--user-data-dir=" + tmpdir() + "/profile"],
        { stdio: "ignore", detached: true });
      browser.unref();
      out.browserPid = browser.pid;
    `,
    );
    roots.push(result.inside);
    try {
      expect(result.after).toBe(root);
      expect(result.removed).toBe(false);
      expect(existsSync(path.join(result.inside, "profile"))).toBe(true);
    } finally {
      process.kill(result.browserPid, "SIGKILL");
    }
  });

  test("keeps the directory when asked to, for a leak hunt", () => {
    const root = createRoot();
    const result = runChild(root, `writeFileSync(join(tmpdir(), "leftover"), "");`, {
      [KEEP_PRIVATE_TMPDIR_ENV]: "1",
    });
    roots.push(result.inside);
    expect(result.removed).toBe(false);
    expect(readdirSync(result.inside)).toEqual(["leftover"]);
  });

  test("a child that inherited a private TMPDIR reuses it and removes nothing", () => {
    const root = createRoot();
    const shared = path.join(root, "shared");
    mkdirSync(shared);
    const result = runChild(root, "", { TMPDIR: shared, [PRIVATE_TMPDIR_ENV]: shared });
    expect(result.inside).toBe(shared);
    expect(result.removed).toBe(false);
  });

  test("sweeps directories of exited owners that are old and unused, and nothing else", async () => {
    const root = createRoot();
    // Where the child puts private directories, so where its sweep looks.
    const sweptRoot = privateTmpdirRoot(root);
    const dead = spawnSync(process.execPath, ["--eval", ""], { timeout: 5_000 }).pid;
    const stale = aged(path.join(sweptRoot, `${PRIVATE_TMPDIR_PREFIX}${dead}-Stale1`), 2 * HOUR_MS);
    const fresh = aged(path.join(sweptRoot, `${PRIVATE_TMPDIR_PREFIX}${dead}-Fresh1`), 60_000);
    const live = aged(
      path.join(sweptRoot, `${PRIVATE_TMPDIR_PREFIX}${process.pid}-Live01`),
      2 * HOUR_MS,
    );
    const used = aged(path.join(sweptRoot, `${PRIVATE_TMPDIR_PREFIX}${dead}-Used01`), 2 * HOUR_MS);
    const other = aged(
      path.join(sweptRoot, `playwright_chromiumdev_profile-Other${dead}`),
      2 * HOUR_MS,
    );
    // A browser that outlived its test still names its profile.
    const browser = spawn(
      process.execPath,
      ["--eval", "setInterval(() => {}, 1000)", `--user-data-dir=${used}/profile`],
      { stdio: "ignore" },
    );
    const exited = new Promise<void>((resolve) => browser.once("exit", () => resolve()));
    try {
      runChild(root, "");
      expect(existsSync(stale)).toBe(false);
      for (const kept of [fresh, live, used, other]) expect(existsSync(kept)).toBe(true);
    } finally {
      browser.kill("SIGKILL");
      await exited;
    }
  });
});

describe("privateTmpdirRoot", () => {
  test("never lengthens macOS paths, and honours the temporary directory elsewhere", () => {
    const perUser = "/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T";
    expect(privateTmpdirRoot(perUser, "darwin")).toBe(
      existsSync("/private/tmp") ? "/private/tmp" : perUser,
    );
    expect(privateTmpdirRoot("/tmp", "darwin")).toBe("/tmp");
    expect(privateTmpdirRoot("/tmp", "linux")).toBe("/tmp");
    expect(privateTmpdirRoot("/home/me/scratch/tmp", "linux")).toBe("/home/me/scratch/tmp");
  });
});
