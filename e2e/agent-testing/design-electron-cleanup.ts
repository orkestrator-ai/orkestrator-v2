import { spawnSync } from "node:child_process";
import type { ElectronApplication } from "playwright";
import { processAlive, signalProcess, waitForStopped, withCleanup } from "../process-cleanup";

/** Snapshot exact owned descendants before quitting, while parent links still exist. */
export function electronProcessTree(app: Pick<ElectronApplication, "process">): number[] {
  let root: number | undefined;
  try {
    root = app.process().pid;
  } catch {
    // Playwright disposes the handle once Electron has exited (a caller that
    // quit it first, as the service-preview spec's relaunch does): nothing to own.
    return [];
  }
  if (!root) return [];
  const rows = processTable();
  const started = new Map(rows.map(([pid, , start]) => [pid, start]));
  const pids = [root];
  for (let index = 0; index < pids.length; index++) {
    for (const [pid, parent, start] of rows) {
      if (parent !== pids[index] || !pid || pids.includes(pid)) continue;
      // Windows keeps a dead parent's id on its children, and reuses ids: a
      // process older than its parent belonged to an earlier owner of the id.
      const parentStart = started.get(parent);
      if (start !== undefined && parentStart !== undefined && start < parentStart) continue;
      pids.push(pid);
    }
    if (pids.length > 512) throw new Error("Electron process tree exceeds cleanup bound");
  }
  return pids;
}

/** `[pid, ppid, start]` rows; the start time is only read on Windows. */
function processTable(): [number, number, number?][] {
  if (process.platform !== "win32") {
    const processes = spawnSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
    });
    if (processes.status !== 0) throw new Error("Could not enumerate Electron descendants");
    return processes.stdout.split("\n").map((line) => {
      const [pid, parent] = line.trim().split(/\s+/).map(Number);
      return [pid!, parent!];
    });
  }
  // Git Bash's ps has no -o; read the parent links from WMI instead.
  const processes = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // The System Idle Process has no creation date.
      "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process | ForEach-Object { " +
        "$start = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }; " +
        '"$($_.ProcessId) $($_.ParentProcessId) $start" }',
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (processes.status !== 0) throw new Error("Could not enumerate Electron descendants");
  return processes.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, parent, start] = line.trim().split(/\s+/).map(Number);
      return [pid!, parent!, start];
    });
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

/**
 * Close Playwright's Electron handle, waiting at most `timeoutMs`.
 *
 * `ElectronApplication.close()` can hang (a wedged quit, a lost connection),
 * and an unbounded wait in a cleanup path holds everything after it, such as
 * stopping the spec's Vite group. When `close()` does not finish in time, or
 * returns with Electron still running, the Electron process tree is killed.
 */
export async function closeElectronWithin(
  app: Pick<ElectronApplication, "close" | "process"> | null | undefined,
  timeoutMs = 20_000,
): Promise<"closed" | "killed"> {
  if (!app) return "closed";
  // Preserve ownership while parent links and the Playwright handle still exist.
  const owned = electronProcessTree(app);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    // A rejected close is settled too; whether Electron still runs is checked below.
    app.close().then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
  ]).finally(() => clearTimeout(timer));
  if (!owned.length && !settled) {
    throw new Error("Electron did not close and exposes no process to stop");
  }
  if (!owned.some(processAlive)) return "closed";
  for (const pid of owned.filter(processAlive)) signalProcess(pid, "SIGKILL");
  await waitForStopped(owned, 5_000);
  return "killed";
}
