import { afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ownedTempDirPrefix, sweepStaleTempDirs } from "../../../tests/temp-sweep";
import { waitForStandaloneBackendReady } from "./standalone-ready";

// Shared by the standalone*.test.ts files; each registers the cleanup below.
export const root = path.resolve(import.meta.dir, "../../..");
const temporaryDirectories: string[] = [];
export const processes: Bun.Subprocess[] = [];

// A killed run never reaches `afterAll`. Its directories carry its PID, so a
// later run removes them once that process has gone; the packaged-backend copy
// alone is tens of megabytes. Unnamed leftovers predate the PID and are only
// removed after a day.
const TEMPORARY_DIRECTORY_PREFIXES = [
  "orkestrator-standalone-test-",
  "orkestrator-packaged-backend-",
  "orkestrator-missing-sharp-",
  "orkestrator-standalone-worktree-",
  "orkestrator-tailscale-test-",
  "orkestrator-tailscale-fail-",
] as const;
sweepStaleTempDirs({
  prefix: TEMPORARY_DIRECTORY_PREFIXES,
  maxAgeMs: 60 * 60 * 1_000,
  legacyMaxAgeMs: 24 * 60 * 60 * 1_000,
});

export async function createTemporaryDirectory(
  prefix: (typeof TEMPORARY_DIRECTORY_PREFIXES)[number],
): Promise<string> {
  const directory = await mkdtemp(ownedTempDirPrefix(prefix));
  temporaryDirectories.push(directory);
  return directory;
}

export function registerStandaloneCleanup() {
  afterAll(async () => {
    const children = processes.splice(0);
    for (const process of children) process.kill("SIGTERM");
    // A backend that is still shutting down can recreate files in its data
    // directory after it has been removed.
    await Promise.all(children.map((child) => Promise.race([child.exited, Bun.sleep(5_000)])));
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
}

export async function startBackend(
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
  prepare?: (paths: { dataDir: string; rendererRoot: string }) => Promise<void>,
  launch?: { bunArgs?: string[]; entry?: string; cwd?: string; appRoot?: string },
): Promise<{
  url: string;
  token: string;
  readyMessage: Record<string, unknown>;
  child: Bun.Subprocess;
  dataDir: string;
}> {
  const dataDir = await createTemporaryDirectory("orkestrator-standalone-test-");
  const rendererRoot = path.join(dataDir, "renderer");
  await mkdir(rendererRoot);
  await writeFile(
    path.join(rendererRoot, "index.html"),
    "<!doctype html><title>Orkestrator</title>",
  );
  await prepare?.({ dataDir, rendererRoot });
  const child = Bun.spawn(
    [
      process.execPath,
      ...(launch?.bunArgs ?? []),
      launch?.entry ?? path.join(root, "apps/backend/dist/main.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--allow-non-tailscale-bind",
      "--data-dir",
      dataDir,
      "--app-root",
      launch?.appRoot ?? root,
      "--resource-root",
      launch?.appRoot ?? root,
      "--renderer-root",
      rendererRoot,
      ...extraArgs,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...extraEnv },
      ...(launch?.cwd ? { cwd: launch.cwd } : {}),
    },
  );
  processes.push(child);

  const ready = await waitForStandaloneBackendReady(child);
  return { ...ready, child, dataDir };
}

export async function invokeBackend(
  url: string,
  token: string,
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await Bun.fetch(new URL("/__orkestrator/invoke", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ command, args }),
  });
  const payload = (await response.json()) as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Backend command failed: ${response.status}`);
  return payload.result;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isProcessRunning(pid) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  if (isProcessRunning(pid)) throw new Error(`Process did not exit: ${pid}`);
}

export async function probeSharpResolution(packagedBackend: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const probe = path.join(packagedBackend, "resolve-sharp.mjs");
  await writeFile(probe, 'console.log(import.meta.resolve("sharp"));\n');
  const env = { ...process.env };
  delete env.NODE_PATH;
  const child = Bun.spawn([process.execPath, "--no-install", probe], {
    cwd: packagedBackend,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
