/**
 * Entry bundle for `orkestrator serve --supervised` (dist/supervisor.js). It
 * imports no backend code: the supervisor must stay small and keep working
 * against backends newer than itself.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { defaultDataDir } from "../../../../apps/backend/src/data-dir.js";
import { runtimeLayout } from "./layout.js";
import { createSupervisorRuntime } from "./runtime.js";
import { Supervisor } from "./supervisor.js";

export function dataDirFromArgs(args: readonly string[], env: NodeJS.ProcessEnv): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--data-dir" && args[index + 1]) return path.resolve(args[index + 1]!);
    if (arg.startsWith("--data-dir=")) return path.resolve(arg.slice("--data-dir=".length));
  }
  return path.resolve(env.ORKESTRATOR_DATA_DIR ?? defaultDataDir(process.platform, env));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One supervisor per data directory; a stale lock from a dead process is taken over. */
export function acquireSupervisorLock(lockFile: string): () => void {
  mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(lockFile, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number.parseInt(readFileSync(lockFile, "utf8"), 10);
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && processAlive(owner)) {
        throw new Error(
          `Another supervisor (pid ${owner}) already runs this data directory (${path.dirname(path.dirname(lockFile))})`,
        );
      }
      rmSync(lockFile, { force: true });
    }
  }
  throw new Error(`Could not take the supervisor lock ${lockFile}`);
}

export async function runSupervisor(
  args: readonly string[],
  packageRoot: string,
  version: string,
): Promise<number> {
  installFatalRejectionGuard({ label: "[Supervisor]" });
  const dataDir = dataDirFromArgs(args, process.env);
  const layout = runtimeLayout(dataDir);
  const releaseLock = acquireSupervisorLock(layout.lock);
  const supervisor = new Supervisor({
    ownPackageRoot: packageRoot,
    ownVersion: version,
    serveArgs: args,
    runtime: createSupervisorRuntime({ dataDir, layout, bunPath: process.execPath }),
  });
  const stop = () => supervisor.stop();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.info(`[Supervisor] Supervising Orkestrator for ${dataDir}`);
  try {
    return await supervisor.run();
  } finally {
    releaseLock();
  }
}
