/**
 * To-dos 8101 and 8093 (retired), with real processes: on a Linux desktop session an
 * orphan is adopted by the session's subreaper (`systemd --user`), not PID 1,
 * so the startup reaper used to read a killed backend's bridge as owned by a
 * live backend and leave it running.
 *
 * The fixture reproduces that tree. A process whose `argv[0]` is chosen per
 * test marks itself a child subreaper with `prctl(PR_SET_CHILD_SUBREAPER)` and
 * starts a stand-in backend (a Bun program), which starts a detached stand-in
 * bridge whose command line carries the codex bridge's markers. The subreaper
 * SIGKILLs the backend on request and, like systemd, waits for the adopted
 * bridge once it exits. Named `/usr/lib/systemd/systemd` it is the session
 * manager the reaper recognises; named `/bin/bash` it stands for a shell or
 * native supervisor that may own the server, which the reaper must leave alone.
 *
 * Every process here is spawned by this file; the backend and the bridge are
 * signalled only by the reaper under test, or in cleanup after their command
 * lines are checked. Cleanup runs whether or not the test got far enough to
 * kill the backend itself, so a failing test leaks nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs, readdirSync, readFileSync } from "node:fs";
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
  backendScript: string;
  bridgeScript: string;
  subreaper: Subprocess<"pipe", "pipe", "inherit">;
  lines: AsyncIterator<string>;
  /** Set as soon as the subreaper reports it, so cleanup can find it early. */
  backendPid?: number;
  bridgePid?: number;
}

let fixture: Fixture | undefined;

function readCommandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return ""; // Gone already.
  }
}

/** Direct children of a live process, from every thread's `children` list. */
function childPids(pid: number): number[] {
  const children: number[] = [];
  let tasks: string[] = [];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return children;
  }
  for (const task of tasks) {
    try {
      const listed = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8");
      for (const entry of listed.split(/\s+/)) if (entry) children.push(Number(entry));
    } catch {
      // The thread exited, or the kernel has no children lists.
    }
  }
  return children;
}

/** SIGKILLs `pid` (or its group) only while it is still the script this fixture started. */
function killIfStillOurs(pid: number | undefined, script: string, group: boolean): void {
  if (pid === undefined || !isPidAlive(pid)) return;
  if (!readCommandLine(pid).includes(script)) return;
  try {
    process.kill(group ? -pid : pid, "SIGKILL");
  } catch {
    // Exited between the check and the signal.
  }
}

/**
 * Stops every process the fixture started, however far setup got. The backend
 * goes first: it has no watchdog, and SIGKILLing the subreaper skips its own
 * `backend.kill`, so killing the subreaper alone would orphan a live backend.
 */
async function stopFixture(current: Fixture): Promise<void> {
  const backends = new Set<number>(childPids(current.subreaper.pid));
  if (current.backendPid !== undefined) backends.add(current.backendPid);
  for (const pid of backends) killIfStillOurs(pid, current.backendScript, false);
  current.subreaper.kill("SIGKILL");
  await current.subreaper.exited;
  killIfStillOurs(current.bridgePid, current.bridgeScript, true);
  await fs.rm(current.root, { recursive: true, force: true });
}

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  if (current) await stopFixture(current);
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

async function startFixture(
  subreaperArgv0: string,
): Promise<Fixture & { backendPid: number; bridgePid: number }> {
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
    argv0: subreaperArgv0,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const started: Fixture = {
    root,
    backendScript,
    bridgeScript,
    subreaper,
    lines: readLines(subreaper.stdout)[Symbol.asyncIterator](),
  };
  fixture = started;
  const backendPid = Number((await nextLine(started, /^backend (\d+)$/))[1]);
  started.backendPid = backendPid;
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

const SYSTEMD = "/usr/lib/systemd/systemd";

/** Kills the stand-in backend without its shutdown path and waits for the adoption. */
async function killBackend(current: Fixture & { bridgePid: number }): Promise<void> {
  current.subreaper.stdin.write("kill-backend\n");
  current.subreaper.stdin.flush();
  await nextLine(current, /^backend-killed$/);
  await waitFor(
    () => readParentPid(current.bridgePid) === current.subreaper.pid,
    "the subreaper to adopt the bridge",
  );
  expect(isPidAlive(current.subreaper.pid)).toBe(true);
}

describe.skipIf(process.platform !== "linux")("reaper under a Linux subreaper", () => {
  test("leaves a live backend's bridge alone, then reaps it once systemd adopts it", async () => {
    const current = await startFixture(SYSTEMD);
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

    // Kill the backend; the subreaper adopts the bridge, so its parent is
    // alive and is not PID 1.
    await killBackend(current);

    const orphaned = storageFor(current.bridgePid);
    expect(await reapOrphanedLocalServers({ storage: orphaned.storage })).toEqual([
      { environmentId: "env-subreaper", kind: "codex", pid: current.bridgePid, outcome: "reaped" },
    ]);
    expect(orphaned.updates).toEqual([{ codexBridgePid: null, localCodexPort: null }]);
    expect(isPidAlive(current.bridgePid)).toBe(false);
  }, 30_000);

  test("leaves a group-leading server alone under a live parent that is not systemd", async () => {
    // A shell or native supervisor may own a matching server outright (a
    // background `opencode serve` job, or one a stale recorded PID now names).
    // Not being a Bun program is no evidence that it adopted the server.
    const current = await startFixture("/bin/bash");
    await killBackend(current);

    const unproven = storageFor(current.bridgePid);
    expect(await reapOrphanedLocalServers({ storage: unproven.storage })).toEqual([
      {
        environmentId: "env-subreaper",
        kind: "codex",
        pid: current.bridgePid,
        outcome: "skipped-live-owner",
      },
    ]);
    expect(unproven.updates).toEqual([]);
    expect(isPidAlive(current.bridgePid)).toBe(true);
  }, 30_000);

  test("cleanup stops the backend, bridge and subreaper when a test fails before killing the backend", async () => {
    const current = await startFixture(SYSTEMD);
    fixture = undefined; // Run the afterEach path here, mid-test, as a failed assertion would.
    expect(isPidAlive(current.backendPid)).toBe(true);
    expect(isPidAlive(current.bridgePid)).toBe(true);

    await stopFixture(current);

    // A zombie still answers signal 0 until its new parent reaps it.
    await waitFor(() => !isPidAlive(current.backendPid), "the stand-in backend to exit");
    await waitFor(() => !isPidAlive(current.bridgePid), "the stand-in bridge to exit");
    expect(current.subreaper.exitCode !== null || current.subreaper.signalCode !== null).toBe(true);
  }, 30_000);

  test("cleanup finds a backend the fixture never recorded", async () => {
    const current = await startFixture(SYSTEMD);
    fixture = undefined;
    const backendPid = current.backendPid;
    // As if setup had failed before the subreaper's report was read.
    await stopFixture({ ...current, backendPid: undefined });
    await waitFor(() => !isPidAlive(backendPid), "the unrecorded stand-in backend to exit");
    await waitFor(() => !isPidAlive(current.bridgePid), "the stand-in bridge to exit");
  }, 30_000);
});
