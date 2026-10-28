// Live and dead owner pids for the identity tests. Every pid here belongs to a
// child the test spawned, and is stopped through its handle: tests never
// signal a process they did not start (AGENTS.md, "Production Orkestrator
// shares this host").

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Subprocess } from "bun";

export const HAS_PROC = existsSync(`/proc/${process.pid}/stat`);
export const HAS_PS =
  spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { stdio: "ignore" }).status === 0;

export interface LiveOwner {
  pid: number;
  /** Epoch ms just before the spawn, within `ps`'s tolerance of the real start. */
  startedAt: number;
  /** Linux only. */
  procStart?: string;
  /** Linux only. */
  bootId?: string;
}

const children: Subprocess[] = [];

function procStartOf(pid: number): string | undefined {
  if (!HAS_PROC) return undefined;
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

function bootId(): string | undefined {
  return HAS_PROC ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : undefined;
}

/** A live pid this test owns, with the identity a bridge would record for it. */
export function spawnLiveOwner(): LiveOwner {
  const startedAt = Date.now();
  const child = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  children.push(child);
  const procStart = procStartOf(child.pid);
  const boot = bootId();
  return {
    pid: child.pid,
    startedAt,
    ...(procStart ? { procStart } : {}),
    ...(boot ? { bootId: boot } : {}),
  };
}

/** The recorded identity fields of a live owner, as a lock or mark stores them. */
export function recordedIdentity(owner: LiveOwner): {
  procStart?: string;
  bootId?: string;
  processStartedAt: number;
} {
  return {
    ...(owner.procStart ? { procStart: owner.procStart } : {}),
    ...(owner.bootId ? { bootId: owner.bootId } : {}),
    processStartedAt: owner.startedAt,
  };
}

/** A pid that belonged to a child of this test that has exited. */
export async function exitedChildPid(): Promise<number> {
  const child = Bun.spawn(["true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

export async function stopLiveOwners(): Promise<void> {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
}
