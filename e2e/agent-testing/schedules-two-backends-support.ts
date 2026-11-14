/**
 * Pure helpers for `schedules-two-backends-live.spec.ts` (to-do 5160 task 3):
 * the second backend's command line, copied from the profile's own backend
 * with only its gateway port changed, and the lease document that takes the
 * first backend's writer lease. Nothing here runs at import time.
 */
import { randomUUID } from "node:crypto";

/**
 * The profile backend's arguments (everything after `main.ts`) with
 * `--port` replaced, so the second backend shares the data directory,
 * worktrees, renderer and toolchain and differs only in where it listens.
 * The control port is kept only when it is `0` (an ephemeral port); a fixed
 * one would collide.
 */
export function secondBackendArgs(first: readonly string[], port: number): string[] {
  const args = [...first];
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? index + 1 : -1;
  };
  const portIndex = value("--port");
  if (portIndex < 0) throw new Error("the profile backend names no --port");
  if (value("--data-dir") < 0) throw new Error("the profile backend names no --data-dir");
  const controlIndex = value("--control-port");
  if (controlIndex >= 0 && args[controlIndex] !== "0") {
    throw new Error("the profile backend's control port is fixed; a second one would collide");
  }
  if (args[portIndex] === String(port)) throw new Error("the second backend needs its own port");
  args[portIndex] = String(port);
  return args;
}

/** `/proc/<pid>/cmdline` split, without `bun` and the entry. */
export function backendArgsFromCmdline(cmdline: string, entry: string): string[] {
  const argv = cmdline.split("\0").filter((part) => part.length > 0);
  const index = argv.indexOf(entry);
  if (index < 0) throw new Error("the process is not this checkout's backend");
  return argv.slice(index + 1);
}

/**
 * A lease document in `RegistryWriterLease`'s own shape under a token no
 * backend holds, as another process reclaiming the lease would write it.
 */
export function takeoverLease(pid: number, now = new Date()): { token: string; body: string } {
  const token = randomUUID();
  return { token, body: JSON.stringify({ token, pid, acquiredAt: now.toISOString() }) };
}
