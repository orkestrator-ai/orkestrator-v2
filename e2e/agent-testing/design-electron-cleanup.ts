import { spawnSync } from "node:child_process";
import type { ElectronApplication } from "playwright";
import { processAlive, signalProcess, waitForStopped, withCleanup } from "../process-cleanup";

/** Snapshot exact owned descendants before quitting, while parent links still exist. */
export function electronProcessTree(app: Pick<ElectronApplication, "process">): number[] {
  const root = app.process().pid;
  if (!root) return [];
  const processes = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (processes.status !== 0) throw new Error("Could not enumerate Electron descendants");
  const rows = processes.stdout.split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const pids = [root];
  for (let index = 0; index < pids.length; index++) {
    for (const [pid, parent] of rows) {
      if (parent === pids[index] && pid && !pids.includes(pid)) pids.push(pid);
    }
    if (pids.length > 512) throw new Error("Electron process tree exceeds cleanup bound");
  }
  return pids;
}

async function bounded(work: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Failed graceful shutdown fails qualification, even when forced cleanup succeeds. */
export async function closeElectron(
  app: Pick<ElectronApplication, "evaluate" | "close">,
  owned: number[],
  timeoutMs = 30_000,
): Promise<void> {
  await withCleanup(async () => {
    // Quitting can disconnect evaluate before its response is delivered.
    await bounded(
      app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined),
      Math.min(5_000, timeoutMs),
    );
    await waitForStopped(owned, timeoutMs);
  }, [
    async () => {
      const remaining = owned.filter(processAlive);
      for (const pid of remaining) signalProcess(pid, "SIGTERM");
      try {
        await waitForStopped(remaining, Math.min(5_000, timeoutMs));
      } catch {
        for (const pid of remaining.filter(processAlive)) signalProcess(pid, "SIGKILL");
        await waitForStopped(remaining, Math.min(5_000, timeoutMs));
      }
    },
    // Playwright may have already lost the connection after app.quit().
    () =>
      bounded(
        app.close().catch(() => undefined),
        Math.min(10_000, timeoutMs),
      ),
  ]);
}
