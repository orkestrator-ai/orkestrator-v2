/**
 * To-dos 8101 and 8093 (retired), with real processes: on a Linux desktop session an
 * orphan is adopted by the session's subreaper (`systemd --user`), not PID 1,
 * so the startup reaper used to read a killed backend's bridge as owned by a
 * live backend and leave it running.
 *
 * The fixture reproduces that tree. A process that is *not* a Bun program by
 * `argv[0]` (as `systemd --user` is not) marks itself a child subreaper with
 * `prctl(PR_SET_CHILD_SUBREAPER)` and starts a stand-in backend (a Bun
 * program), which starts a detached stand-in bridge whose command line carries
 * the codex bridge's markers. The subreaper SIGKILLs the backend on request
 * and, like systemd, waits for the adopted bridge once it exits.
 *
 * Every process here is spawned by this file; the bridge is signalled only by
 * the reaper under test, or in cleanup after its command line is checked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { isPidAlive, reapOrphanedLocalServers } from "./local-server-reaper.js";
import type { Environment } from "./models.js";

const SUBREAPER_SOURCE = `
import { dlopen, FFIType } from "bun:ffi";
const [backendScript, bridgeScript] = process.argv.slice(2);
const libc = dlopen("libc.so.6", {
  prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});
const PR_SET_CHILD_SUBREAPER = 36;
const WNOHANG = 1;
if (libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) !== 0) {
  console.log("no-subreaper");
  process.exit(3);
}
const backend = Bun.spawn([process.execPath, backendScript, bridgeScript], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "inherit",
});
console.log("backend " + backend.pid);
let bridgePid = 0;
// Reap the bridge once it is ours and has exited, as systemd --user does.
setInterval(() => {
  if (bridgePid > 0) libc.symbols.waitpid(bridgePid, null, WNOHANG);
}, 20);
(async () => {
  let buffered = "";
  for await (const chunk of backend.stdout) {
    buffered += new TextDecoder().decode(chunk);
    const lines = buffered.split("\\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^bridge (\\d+)$/.exec(line.trim());
      if (match) bridgePid = Number(match[1]);
      console.log(line);
    }
  }
})();
for await (const line of console) {
  if (line.trim() === "kill-backend") {
    backend.kill("SIGKILL");
    await backend.exited;
    console.log("backend-killed");
  }
}
backend.kill("SIGKILL");
process.exit(0);
`;

const BACKEND_SOURCE = `
import { spawn } from "node:child_process";
const bridge = spawn(process.execPath, [process.argv[2]], { detached: true, stdio: "ignore" });
bridge.unref();
console.log("bridge " + bridge.pid);
setInterval(() => {}, 1000);
`;

const BRIDGE_SOURCE = `setInterval(() => {}, 1000);\n`;

interface Fixture {
  root: string;
  bridgeScript: string;
  subreaper: Subprocess<"pipe", "pipe", "inherit">;
  lines: AsyncIterator<string>;
  bridgePid?: number;
}

let fixture: Fixture | undefined;

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  if (!current) return;
  current.subreaper.kill("SIGKILL");
  await current.subreaper.exited;
  const bridgePid = current.bridgePid;
  if (bridgePid !== undefined && isPidAlive(bridgePid)) {
    // Signal it only while it is still the stand-in this fixture started.
    let commandLine = "";
    try {
      commandLine = readFileSync(`/proc/${bridgePid}/cmdline`, "utf8");
    } catch {
      // Gone already.
    }
    if (commandLine.includes(current.bridgeScript)) process.kill(-bridgePid, "SIGKILL");
  }
  await fs.rm(current.root, { recursive: true, force: true });
});

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim().length > 0) yield line.trim();
  }
}

async function nextLine(current: Fixture, pattern: RegExp): Promise<RegExpExecArray> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      current.lines.next(),
      Bun.sleep(deadline - Date.now()).then(() => null),
    ]);
    if (next === null || next.done) break;
    const match = pattern.exec(next.value);
    if (match) return match;
    if (next.value === "no-subreaper") throw new Error("prctl(PR_SET_CHILD_SUBREAPER) refused");
  }
  throw new Error(`fixture never printed ${pattern}`);
}

async function startFixture(): Promise<Fixture & { backendPid: number; bridgePid: number }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reaper-subreaper-"));
  const subreaperScript = path.join(root, "subreaper.ts");
  const backendScript = path.join(root, "backend.ts");
  // The codex bridge's markers: `codex-bridge` and `dist/index.js`.
  const bridgeScript = path.join(root, "codex-bridge", "dist", "index.js");
  await fs.mkdir(path.dirname(bridgeScript), { recursive: true });
  await fs.writeFile(subreaperScript, SUBREAPER_SOURCE);
  await fs.writeFile(backendScript, BACKEND_SOURCE);
  await fs.writeFile(bridgeScript, BRIDGE_SOURCE);

  const subreaper = Bun.spawn([process.execPath, subreaperScript, backendScript, bridgeScript], {
    // Not a Bun program by argv[0], as `/usr/lib/systemd/systemd --user` is not.
    argv0: "test-subreaper",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const started: Fixture = {
    root,
    bridgeScript,
    subreaper,
    lines: readLines(subreaper.stdout)[Symbol.asyncIterator](),
  };
  fixture = started;
  const backendPid = Number((await nextLine(started, /^backend (\d+)$/))[1]);
  const bridgePid = Number((await nextLine(started, /^bridge (\d+)$/))[1]);
  started.bridgePid = bridgePid;
  return { ...started, backendPid, bridgePid };
}

function readParentPid(pid: number): number | null {
  try {
    // Field 4 of /proc/<pid>/stat, after the parenthesised command name.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return null;
  }
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

function storageFor(bridgePid: number) {
  const updates: Array<Record<string, unknown>> = [];
  const environment = {
    id: "env-subreaper",
    projectId: "project-1",
    name: "env",
    status: "running",
    order: 0,
    codexBridgePid: bridgePid,
    localCodexPort: 5111,
  } as Environment;
  return {
    updates,
    storage: {
      loadEnvironments: async () => [environment],
      updateEnvironment: async (_id: string, fields: Partial<Environment>) => {
        updates.push(fields as Record<string, unknown>);
      },
    },
  };
}

describe.skipIf(process.platform !== "linux")("reaper under a Linux subreaper", () => {
  test("leaves a live backend's bridge alone, then reaps it once a subreaper adopts it", async () => {
    const current = await startFixture();
    expect(readParentPid(current.bridgePid)).toBe(current.backendPid);

    // The stand-in backend is alive and runs under Bun: it owns the bridge.
    const owned = storageFor(current.bridgePid);
    expect(await reapOrphanedLocalServers({ storage: owned.storage })).toEqual([
      {
        environmentId: "env-subreaper",
        kind: "codex",
        pid: current.bridgePid,
        outcome: "skipped-live-owner",
      },
    ]);
    expect(owned.updates).toEqual([]);
    expect(isPidAlive(current.bridgePid)).toBe(true);

    // Kill the backend without its shutdown path; the subreaper adopts the
    // bridge, so its parent is alive and is not PID 1.
    current.subreaper.stdin.write("kill-backend\n");
    current.subreaper.stdin.flush();
    await nextLine(current, /^backend-killed$/);
    await waitFor(
      () => readParentPid(current.bridgePid) === current.subreaper.pid,
      "the subreaper to adopt the bridge",
    );
    expect(isPidAlive(current.subreaper.pid)).toBe(true);

    const orphaned = storageFor(current.bridgePid);
    expect(await reapOrphanedLocalServers({ storage: orphaned.storage })).toEqual([
      { environmentId: "env-subreaper", kind: "codex", pid: current.bridgePid, outcome: "reaped" },
    ]);
    expect(orphaned.updates).toEqual([{ codexBridgePid: null, localCodexPort: null }]);
    expect(isPidAlive(current.bridgePid)).toBe(false);
  }, 30_000);
});
