import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fixPath } from "./fix-path.js";

const originalPath = process.env.PATH;
const originalShell = process.env.SHELL;
const originalVersion = process.env.ORKESTRATOR_VERSION;
const tempDirectories: string[] = [];

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  if (originalVersion === undefined) delete process.env.ORKESTRATOR_VERSION;
  else process.env.ORKESTRATOR_VERSION = originalVersion;
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  mock.restore();
});

describe("fixPath", () => {
  const unixTest = process.platform === "win32" ? test.skip : test;

  unixTest("merges login-shell and inherited entries without logging path contents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-fix-path-"));
    tempDirectories.push(root);
    const shell = path.join(root, "fake-shell");
    const shellPrivatePath = path.join(root, "private-shell-tools");
    const inheritedPrivatePath = path.join(root, "private-inherited-tools");
    await fs.writeFile(
      shell,
      `#!/bin/sh\nprintf '%s' '${shellPrivatePath}${path.delimiter}/usr/bin'\n`,
    );
    await fs.chmod(shell, 0o755);
    process.env.SHELL = shell;
    process.env.PATH = [inheritedPrivatePath, "/usr/bin", "/bin"].join(path.delimiter);
    process.env.ORKESTRATOR_VERSION = "9.9.9-test";
    const info = mock((..._args: [message?: unknown]) => {});
    const originalInfo = console.info;
    console.info = info;

    try {
      fixPath();
    } finally {
      console.info = originalInfo;
    }

    const entries = process.env.PATH?.split(path.delimiter) ?? [];
    expect(entries.slice(0, 4)).toEqual([
      shellPrivatePath,
      "/usr/bin",
      inheritedPrivatePath,
      "/bin",
    ]);
    expect(entries.filter((entry) => entry === "/usr/bin")).toHaveLength(1);
    expect(info).toHaveBeenCalledTimes(1);
    const logLine = String(info.mock.calls[0]?.[0]);
    expect(logLine).toContain("version=9.9.9-test");
    expect(logLine).toContain("loginShellPathResolved=true");
    expect(logLine).toContain("inheritedPathEntries=3");
    expect(logLine).toContain("loginShellPathEntries=2");
    expect(logLine).not.toContain(shellPrivatePath);
    expect(logLine).not.toContain(inheritedPrivatePath);
  });
});
