import { readdirSync, readFileSync } from "node:fs";

/** Walk every thread's children; exited processes and threads are harmless races. */
export function processTree(
  root: number,
  tasks: (pid: number) => string[] = (pid) => readdirSync(`/proc/${pid}/task`),
  children: (pid: number, tid: string) => string = (pid, tid) =>
    readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8"),
): number[] {
  const seen = new Set<number>();
  const pending = [root];
  while (pending.length) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    let threads: string[];
    try {
      threads = tasks(pid);
    } catch {
      continue;
    }
    for (const tid of threads) {
      try {
        for (const child of children(pid, tid).split(/\s+/).filter(Boolean)) {
          const childPid = Number(child);
          if (Number.isSafeInteger(childPid) && childPid > 0) pending.push(childPid);
        }
      } catch {
        // A thread may exit while its siblings remain alive.
      }
    }
  }
  return Array.from(seen);
}
