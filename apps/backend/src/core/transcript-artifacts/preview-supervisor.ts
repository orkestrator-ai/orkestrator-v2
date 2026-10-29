/**
 * External supervisor for one preview worker.
 *
 * The supervisor lives in the backend process, never in the renderer or the
 * worker. It owns the worker boundary (a child process tree, or a container),
 * all hard deadlines (worker wall time from before launch, readiness after
 * navigation starts, Mermaid parse/layout after render starts), a memory
 * watchdog for process mode, bounded stdout parsing, and termination with
 * verified exit. The outcome resolves exactly once; exit verification is
 * reported separately so the runner releases capacity only afterwards.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { PREVIEW_ADMISSION_POLICY } from "@orkestrator/protocol/rich-content-policy";

import { isProcessAlive, processStartIdentity } from "../process-identity.js";
import { killTree, treeResidentBytes } from "./preview-process-tree.js";
import type { WorkerEvent, WorkerJobPackage, WorkerResult } from "./preview-worker-protocol.js";

export const PREVIEW_CONTAINER_LABEL = "orkestrator.artifact-preview";
export const PREVIEW_CONTAINER_OWNER_LABEL = "orkestrator.artifact-preview.owner";

/** Owner label value for one backend data directory; never the path itself. */
export function previewContainerOwner(dataDir: string): string {
  return createHash("sha256")
    .update(`artifact-preview-owner\0${dataDir}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Remove preview worker containers a previous run of this backend left
 * behind (a crash between `docker run` and its exit). Only containers with
 * this backend's owner label are touched: at startup none of them can belong
 * to a live job, and another backend's workers are never affected.
 */
export async function reapOrphanPreviewContainers(docker: string, owner: string): Promise<number> {
  if (!/^[0-9a-f]{24}$/.test(owner)) return 0;
  const listed = await runDocker(docker, [
    "ps",
    "-aq",
    "--filter",
    `label=${PREVIEW_CONTAINER_LABEL}=1`,
    "--filter",
    `label=${PREVIEW_CONTAINER_OWNER_LABEL}=${owner}`,
  ]);
  if (listed.code !== 0) return 0;
  const ids = listed.stdout
    .split(/\s+/)
    .filter((id) => /^[0-9a-f]{6,64}$/.test(id))
    .slice(0, 64);
  if (ids.length === 0) return 0;
  const removed = await runDocker(docker, ["rm", "-f", ...ids]);
  return removed.code === 0 ? ids.length : 0;
}

export interface SupervisorDeadlines {
  workerWallMs: number;
  /** Hard bound from the worker's `navigating` event to `ready` (the worker waits readinessMs itself). */
  readinessHardMs: number;
  /** Hard bound from `render-start` to the result for Mermaid. */
  mermaidRenderMs: number;
  cleanupGraceMs: number;
}

export type ProcessWorkerLaunch = {
  isolation: "process";
  command: string;
  /** Worker arguments; the supervisor appends a private scratch ownership argument. */
  args: string[];
  /** Parent of the per-job private scratch directory (default: the OS temp directory). */
  scratchRoot?: string;
};

export type ContainerWorkerLaunch = {
  isolation: "container";
  docker: string;
  image: string;
  /** Host path of the seccomp profile that permits Chromium's user-namespace sandbox. */
  seccompProfile?: string;
  user: string;
  /** Value of the owner label (a hash of the backend's data directory). */
  owner?: string;
  memoryBytes: number;
  cpus: number;
  pids: number;
};

export type WorkerLaunch = ProcessWorkerLaunch | ContainerWorkerLaunch;

export type SupervisedOutcome =
  | { type: "result"; result: WorkerResult }
  | { type: "timeout"; phase: "wall" | "readiness" | "mermaid-render" }
  | { type: "memory" }
  | { type: "cancelled" }
  | { type: "crashed"; reason: "exit" | "protocol" | "output-limit" | "spawn" };

export interface ExitReport {
  verified: boolean;
  pids: number[];
  browserPid: number | null;
}

export interface SupervisedJob {
  outcome: Promise<SupervisedOutcome>;
  /** Resolves after the whole boundary has exited (or termination was attempted and checked). */
  exited: Promise<ExitReport>;
  cancel(): void;
  browserPid(): number | null;
  workerPid(): number | null;
  /**
   * Terminate again and re-check that the boundary is gone (the bounded
   * reaper for an unverified exit). Resolves true only on positive evidence:
   * no owned process remains, or Docker answers that the container no longer
   * exists. Removes the private scratch directory once verified.
   */
  reap(): Promise<boolean>;
  /** Process mode: path of the job's private HOME/TMPDIR (the directory is removed after a verified exit). */
  scratchDir(): string | null;
}

/**
 * Prefix of a process-mode worker's scratch directory, named
 * `<prefix><backend pid>-<random>` so a later backend can tell whose it is.
 */
export const PREVIEW_SCRATCH_PREFIX = "ork-artifact-preview-";
const PREVIEW_SCRATCH_NAME = /^ork-artifact-preview-([1-9]\d*)-[A-Za-z0-9]{6}$/;
/** The name used before the backend PID was embedded; only age can decide for these. */
const LEGACY_PREVIEW_SCRATCH_NAME = /^ork-artifact-preview-[A-Za-z0-9]{6}$/;
/** How long the scratch of a backend that has exited is kept before startup recovery removes it. */
export const PREVIEW_SCRATCH_STALE_MS = 60 * 60_000;
/** How long a legacy-named scratch directory is kept; a job is bounded to minutes. */
export const LEGACY_PREVIEW_SCRATCH_STALE_MS = 24 * 60 * 60_000;
const SCRATCH_OWNER_FILE = ".ork-preview-owner";

let backendStartIdentity: string | null | undefined;

/**
 * Startup recovery for process isolation, the counterpart of
 * `reapOrphanPreviewContainers`. A scratch directory outlives its backend when
 * the backend is killed during a job, or stops while a worker's exit is still
 * unverified (the reaper stops with it). Removes those whose backend has
 * exited or whose PID has been recycled and that are past the age limit.
 * Scratch without a recorded start identity uses the legacy day-long limit
 * if its PID is live. Never throws; returns what it removed.
 */
export async function sweepStalePreviewScratch(
  options: {
    root?: string;
    now?: number;
    maxAgeMs?: number;
    isProcessAlive?: (pid: number) => boolean;
    processStartIdentity?: (pid: number) => string | null;
  } = {},
): Promise<string[]> {
  const root = options.root ?? tmpdir();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? PREVIEW_SCRATCH_STALE_MS;
  const alive = options.isProcessAlive ?? isProcessAlive;
  const identity = options.processStartIdentity ?? processStartIdentity;
  const identities = new Map<number, string | null>();
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    const owner = PREVIEW_SCRATCH_NAME.exec(name);
    let ageLimit: number;
    if (owner) {
      const pid = Number(owner[1]);
      ageLimit = maxAgeMs;
      if (alive(pid)) {
        let recorded: string | null = null;
        try {
          recorded =
            (await readFile(path.join(root, name, SCRATCH_OWNER_FILE), "utf8")).trim() || null;
        } catch {
          // Older backends did not record identity; use the legacy age bound.
        }
        if (recorded) {
          if (!identities.has(pid)) identities.set(pid, identity(pid));
          const current = identities.get(pid);
          // Failure to inspect a live owner is not evidence it has exited.
          if (current == null || current === recorded) continue;
        } else {
          ageLimit = Math.max(maxAgeMs, LEGACY_PREVIEW_SCRATCH_STALE_MS);
        }
      }
    } else if (LEGACY_PREVIEW_SCRATCH_NAME.test(name)) {
      ageLimit = LEGACY_PREVIEW_SCRATCH_STALE_MS;
    } else continue;
    const target = path.join(root, name);
    try {
      const info = await lstat(target);
      if (!info.isDirectory() || now - info.mtimeMs <= ageLimit) continue;
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      // Removed concurrently, or not ours to remove; the next start retries.
    }
  }
  return removed;
}

/**
 * Environment for a process-mode worker: nothing inherited from the backend
 * (no tokens, credentials, proxies or user configuration), a fixed PATH, and
 * HOME/TMPDIR/XDG directories inside the job's private scratch directory.
 */
export function processWorkerEnv(
  scratch: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    XDG_CONFIG_HOME: path.join(scratch, ".config"),
    XDG_CACHE_HOME: path.join(scratch, ".cache"),
    XDG_DATA_HOME: path.join(scratch, ".local", "share"),
    XDG_RUNTIME_DIR: scratch,
    LANG: "C.UTF-8",
    NODE_ENV: "production",
    // Only a directory location (no secret): Playwright's bundled browsers when no executable is passed.
    ...(inherited.PLAYWRIGHT_BROWSERS_PATH
      ? { PLAYWRIGHT_BROWSERS_PATH: inherited.PLAYWRIGHT_BROWSERS_PATH }
      : {}),
  };
}

/**
 * Positive evidence that a named container is gone: Docker answered the
 * query successfully and listed nothing. An unreachable daemon is not
 * evidence (its non-zero exit used to read as "gone").
 */
export async function containerGone(docker: string, name: string): Promise<boolean> {
  const listed = await runDocker(docker, [
    "ps",
    "-aq",
    "--no-trunc",
    "--filter",
    `name=^/${name}$`,
  ]);
  return listed.code === 0 && listed.stdout.trim() === "";
}

const MAX_STDOUT_BYTES = 48 * 1024 * 1024;
const MEMORY_SAMPLE_MS = 500;
/** Shared pages are counted once per Chromium process, so the summed RSS gets a looser bound. */
const TREE_MEMORY_FACTOR = 4;
const DOCKER_COMMAND_TIMEOUT_MS = 10_000;

/** The fixed `docker run` argument vector. Nothing comes from artifact content. */
export function containerRunArgs(launch: ContainerWorkerLaunch, name: string): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--label",
    `${PREVIEW_CONTAINER_LABEL}=1`,
    ...(launch.owner ? ["--label", `${PREVIEW_CONTAINER_OWNER_LABEL}=${launch.owner}`] : []),
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--memory",
    String(launch.memoryBytes),
    "--memory-swap",
    String(launch.memoryBytes),
    "--cpus",
    String(launch.cpus),
    "--pids-limit",
    String(launch.pids),
    "--shm-size",
    "256m",
    "--ipc",
    "private",
    "--user",
    launch.user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...(launch.seccompProfile ? ["--security-opt", `seccomp=${launch.seccompProfile}`] : []),
    "--log-driver",
    "none",
    "--env",
    "HOME=/tmp",
    "--stop-timeout",
    "2",
    "--init",
    launch.image,
  ];
}

function runDocker(
  docker: string,
  args: string[],
  timeoutMs = DOCKER_COMMAND_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(docker, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

export { runDocker };

export function superviseWorker(
  launch: WorkerLaunch,
  pkg: WorkerJobPackage,
  deadlines: SupervisorDeadlines,
  options: { memoryLimitBytes?: number; onEvent?: (event: WorkerEvent) => void } = {},
): SupervisedJob {
  const memoryLimit = options.memoryLimitBytes ?? PREVIEW_ADMISSION_POLICY.workerMemoryBytes;
  const containerName =
    launch.isolation === "container" ? `ork-artifact-preview-${randomUUID()}` : null;
  let scratch: string | null = null;
  let scratchPath: string | null = null;
  const removeScratch = () => {
    if (!scratch) return;
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 2 });
      scratch = null;
    } catch {
      // Retried by the next verified reap.
    }
  };
  let child: ChildProcess | null = null;
  let browserPid: number | null = null;
  let settled = false;
  let resolveOutcome!: (outcome: SupervisedOutcome) => void;
  const outcome = new Promise<SupervisedOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  let resolveExited!: (report: ExitReport) => void;
  const exited = new Promise<ExitReport>((resolve) => {
    resolveExited = resolve;
  });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let memoryTimer: ReturnType<typeof setInterval> | undefined;
  let childExited = false;
  let childExit: Promise<void> = Promise.resolve();
  let terminating: Promise<void> | null = null;

  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (memoryTimer) clearInterval(memoryTimer);
    memoryTimer = undefined;
  };

  const settle = (value: SupervisedOutcome) => {
    if (settled) return;
    settled = true;
    resolveOutcome(value);
  };

  const arm = (ms: number, onFire: () => void) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        onFire();
      },
      Math.max(0, ms),
    );
    timers.add(timer);
    return timer;
  };

  /** One kill-and-verify pass over the owned boundary. */
  const killAndVerify = async (): Promise<ExitReport> => {
    if (launch.isolation === "container") {
      // The docker CLI is not the container: stop the container by its owned name.
      await runDocker(launch.docker, ["kill", containerName!]);
      await runDocker(launch.docker, ["rm", "-f", containerName!]);
      if (child?.pid && !childExited) child.kill("SIGKILL");
      await Promise.race([childExit, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      const gone = await containerGone(launch.docker, containerName!);
      return { verified: gone && childExited, pids: child?.pid ? [child.pid] : [], browserPid };
    }
    const roots = child?.pid ? [child.pid] : [];
    if (browserPid) roots.push(browserPid);
    const groups = [...(child?.pid ? [child.pid] : []), ...(browserPid ? [browserPid] : [])];
    // The worker carries the scratch marker from launch. A forked child
    // inherits it before exec, then Chromium carries it in --user-data-dir.
    // Ownership therefore survives an orphaning worker exit during launch.
    const tree = await killTree(roots, groups, undefined, scratchPath ?? undefined);
    if (child?.pid && !childExited) child.kill("SIGKILL");
    await Promise.race([childExit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    return { verified: tree.verified && childExited, pids: tree.pids, browserPid };
  };

  /** Terminate the owned boundary; grace lets the worker close Chromium itself. */
  const terminate = (graceMs: number): Promise<void> => {
    if (terminating) return terminating;
    clearTimers();
    terminating = (async () => {
      if (graceMs > 0 && !childExited) {
        await Promise.race([childExit, new Promise((resolve) => setTimeout(resolve, graceMs))]);
      }
      const report = await killAndVerify();
      // Scratch files go only once nothing can still be writing them.
      if (report.verified) removeScratch();
      resolveExited(report);
    })().catch(() => {
      resolveExited({ verified: false, pids: [], browserPid });
    });
    return terminating;
  };

  const reap = async (): Promise<boolean> => {
    if (terminating) await terminating;
    const report = await killAndVerify().catch(() => null);
    if (report?.verified) removeScratch();
    return report?.verified === true;
  };

  const fail = (value: SupervisedOutcome, graceMs = 0) => {
    settle(value);
    void terminate(graceMs);
  };

  try {
    if (launch.isolation === "process") {
      // A private, owner-only scratch directory is the worker's HOME, TMPDIR
      // and cwd, so neither the worker nor Chromium sees the user's home.
      scratch = mkdtempSync(
        path.join(launch.scratchRoot ?? tmpdir(), `${PREVIEW_SCRATCH_PREFIX}${process.pid}-`),
      );
      scratchPath = scratch;
      backendStartIdentity ??= processStartIdentity(process.pid);
      if (backendStartIdentity) {
        writeFileSync(path.join(scratch, SCRATCH_OWNER_FILE), backendStartIdentity, {
          mode: 0o600,
        });
      }
      // A child paused between fork and exec still has the worker's argv,
      // even after setsid and reparenting. Mark the worker before it can fork;
      // HOME/TMPDIR alone are not visible in the process listing.
      child = spawn(launch.command, [...launch.args, `--ork-preview-scratch=${scratch}`], {
        stdio: ["pipe", "pipe", "ignore"],
        // Own process group so the whole worker group can be signalled.
        detached: true,
        windowsHide: true,
        cwd: scratch,
        env: processWorkerEnv(scratch),
      });
    } else {
      child = spawn(launch.docker, containerRunArgs(launch, containerName!), {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    }
  } catch {
    removeScratch();
    settle({ type: "crashed", reason: "spawn" });
    resolveExited({ verified: true, pids: [], browserPid: null });
    return {
      outcome,
      exited,
      cancel: () => undefined,
      browserPid: () => null,
      workerPid: () => null,
      reap: () => Promise.resolve(true),
      scratchDir: () => null,
    };
  }

  const spawned = child;
  childExit = new Promise<void>((resolve) => {
    spawned.once("exit", () => {
      childExited = true;
      resolve();
    });
    spawned.once("error", () => {
      childExited = true;
      resolve();
    });
  });

  // Wall time starts before the browser launches.
  arm(deadlines.workerWallMs, () =>
    fail({ type: "timeout", phase: "wall" }, deadlines.cleanupGraceMs),
  );

  if (launch.isolation === "process") {
    memoryTimer = setInterval(() => {
      const roots = [spawned.pid, browserPid].filter(
        (pid): pid is number => typeof pid === "number",
      );
      treeResidentBytes(roots)
        .then(({ total, largest }) => {
          // Process mode is approximate (see treeResidentBytes); container mode has a cgroup hard limit.
          if (largest > memoryLimit || total > memoryLimit * TREE_MEMORY_FACTOR)
            fail({ type: "memory" });
        })
        .catch(() => undefined);
    }, MEMORY_SAMPLE_MS);
  }

  let readySeen = false;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let received = 0;
  spawned.stdout?.on("data", (chunk: Buffer) => {
    received += chunk.byteLength;
    if (received > MAX_STDOUT_BYTES) {
      fail({ type: "crashed", reason: "output-limit" });
      spawned.stdout?.destroy();
      return;
    }
    buffered += decoder.write(chunk);
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      let event: WorkerEvent;
      try {
        event = JSON.parse(line) as WorkerEvent;
      } catch {
        fail({ type: "crashed", reason: "protocol" });
        return;
      }
      options.onEvent?.(event);
      if (event.t === "launched") {
        browserPid = typeof event.browserPid === "number" ? event.browserPid : null;
      } else if (event.t === "phase") {
        if (event.phase === "navigating") {
          arm(deadlines.readinessHardMs, () => {
            if (!readySeen) fail({ type: "timeout", phase: "readiness" });
          });
        } else if (event.phase === "ready") {
          readySeen = true;
        } else if (event.phase === "render-start") {
          renderTimer = arm(deadlines.mermaidRenderMs, () =>
            fail({ type: "timeout", phase: "mermaid-render" }),
          );
        } else if (event.phase === "render-done" && renderTimer) {
          clearTimeout(renderTimer);
          timers.delete(renderTimer);
        }
      } else if (event.t === "result") {
        settle({ type: "result", result: event.result });
        // The worker closes Chromium and exits on its own; it gets the grace period.
        void terminate(deadlines.cleanupGraceMs);
      }
    }
  });
  // `close` fires after stdout is drained, so a final result line is never lost.
  spawned.on("close", () => {
    if (!settled) fail({ type: "crashed", reason: "exit" });
  });
  spawned.on("error", () => {
    if (!settled) fail({ type: "crashed", reason: "spawn" });
  });

  spawned.stdin?.on("error", () => undefined);
  spawned.stdin?.end(JSON.stringify(pkg));

  return {
    outcome,
    exited,
    cancel: () => fail({ type: "cancelled" }),
    browserPid: () => browserPid,
    workerPid: () => spawned.pid ?? null,
    reap,
    scratchDir: () => scratchPath,
  };
}
