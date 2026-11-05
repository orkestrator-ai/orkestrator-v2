import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listProcesses } from "./preview-process-tree.js";

const originalPath = process.env.PATH;
const directories: string[] = [];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Puts a shell script named `ps` first on PATH for this test. */
function stubPs(body: string): void {
  const directory = mkdtempSync(path.join(tmpdir(), "ork-preview-ps-"));
  directories.push(directory);
  const script = path.join(directory, "ps");
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
}

describe("listProcesses capture", () => {
  test("parses every row and keeps a command's internal whitespace", async () => {
    stubPs(`printf '  10   1  10  2048 S  /path/with  two spaces --flag\\n  11  10  10  0 Z+\\n'`);
    expect(await listProcesses({ commands: true })).toEqual([
      {
        pid: 10,
        ppid: 1,
        pgid: 10,
        rssKiB: 2048,
        zombie: false,
        command: "/path/with  two spaces --flag",
      },
      { pid: 11, ppid: 10, pgid: 10, rssKiB: 0, zombie: true, command: "" },
    ]);
  });

  test("asks for the command column only when told to", async () => {
    stubPs(`printf '1 1 1 1 S %s\\n' "$*"`);
    const [plain] = await listProcesses();
    expect(plain?.command).toBeUndefined();
    const [full] = await listProcesses({ commands: true });
    expect(full?.command).toBe("-A -ww -o pid=,ppid=,pgid=,rss=,stat=,command=");
  });

  test("a failing ps lists nothing, whatever it printed", async () => {
    stubPs(`printf '1 1 1 1 S\\n'; exit 1`);
    expect(await listProcesses()).toEqual([]);
  });

  test("a ps past its 2 s timeout lists nothing, whatever it printed", async () => {
    stubPs(`printf '1 1 1 1 S\\n'; exec sleep 30`);
    const started = Date.now();
    expect(await listProcesses()).toEqual([]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(10_000);
  });

  test("a ps past its 8 MiB limit lists nothing rather than part of the table", async () => {
    stubPs(`printf '1 1 1 1 S\\n'; head -c ${8 * 1024 * 1024} /dev/zero`);
    expect(await listProcesses()).toEqual([]);
  });

  test("a missing ps lists nothing", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "ork-preview-no-ps-"));
    directories.push(empty);
    process.env.PATH = empty;
    expect(await listProcesses()).toEqual([]);
  });
});
