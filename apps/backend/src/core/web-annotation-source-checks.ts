/**
 * Containment and existence checks for repository-relative paths named by an
 * agent report (and optional development source hints).
 *
 * The checks never read file contents and never follow a path outside the
 * environment workspace: a symlink that resolves elsewhere is reported as
 * `outside-workspace`. They are evidence about the paths, not verification of
 * the change. Local worktrees are checked from the host. Container workspaces
 * are checked inside the container by `CONTAINER_PATH_CHECKER` (through the
 * `check_container_workspace_paths` command), which resolves symlinks against
 * the container's own `/workspace`; when that check cannot run, the paths are
 * reported as `unavailable` rather than guessed.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  WebAnnotationFileCheck,
  WebAnnotationFileCheckStatus,
} from "@orkestrator/protocol/web-annotations";
import { isSafeRelativePath } from "@orkestrator/protocol/web-annotations-validation";
import type { DispatchEnvironment } from "./web-annotation-contracts.js";

export const MAX_WORKSPACE_PATH_CHECKS = 200;
const CONCURRENCY = 8;
/** Budget for the checks themselves, on the host or inside the container. */
export const WORKSPACE_PATH_CHECK_DEADLINE_MS = 2_000;
/**
 * Hard stop for the container check, measured on the host. It adds `docker
 * exec` and Node start-up to the 2 s check budget; a check still running then
 * is killed and every path reads `unavailable`.
 */
export const CONTAINER_PATH_CHECK_TIMEOUT_MS = 5_000;
/** stdin of the container check: at most 200 JSON-quoted repository paths. */
const MAX_CONTAINER_CHECK_INPUT_BYTES = 256 * 1024;

const STATUSES: ReadonlySet<WebAnnotationFileCheckStatus> = new Set([
  "exists",
  "missing",
  "outside-workspace",
  "unavailable",
]);

/** Runs the container check for already-validated relative paths. */
export type ContainerPathCheck = (
  containerId: string,
  paths: readonly string[],
) => Promise<unknown>;

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function checkLocalPath(root: string, relative: string): Promise<WebAnnotationFileCheck> {
  if (!isSafeRelativePath(relative)) return { path: relative, status: "outside-workspace" };
  const resolved = path.resolve(root, relative);
  if (!within(root, resolved)) return { path: relative, status: "outside-workspace" };
  try {
    const real = await realpath(resolved);
    if (!within(root, real)) return { path: relative, status: "outside-workspace" };
    await stat(real);
    return { path: relative, status: "exists" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return {
      path: relative,
      status: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable",
    };
  }
}

/**
 * `node -e SCRIPT -- <root> <budget ms>`; a JSON array of relative paths on
 * stdin. Prints a JSON array of statuses in the same order. The same rules as
 * the local check: the root is canonicalized first, each path must stay inside
 * it both lexically and after `realpath` (so a symlink is resolved inside the
 * container and refused if it leaves the workspace), and existence is a
 * `stat` only. No file is opened or read. Paths left when the budget runs out
 * are `unavailable`.
 */
export const CONTAINER_PATH_CHECKER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const started = Date.now();
const root = path.resolve(process.argv[1]);
const budget = Number(process.argv[2]);
const limit = ${MAX_CONTAINER_CHECK_INPUT_BYTES};
function inside(rootPath, targetPath) {
  const child = path.relative(rootPath, targetPath);
  return child === "" || (child !== ".." && !child.startsWith(".." + path.sep) && !path.isAbsolute(child));
}
const chunks = [];
let size = 0;
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > limit) {
    process.stderr.write("Path check input is too large\n");
    process.exit(3);
  }
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  let paths;
  try {
    paths = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.stderr.write("Path check input is invalid\n");
    process.exit(3);
  }
  if (!Array.isArray(paths) || paths.length > ${MAX_WORKSPACE_PATH_CHECKS}) {
    process.stderr.write("Path check input is invalid\n");
    process.exit(3);
  }
  let canonical = null;
  try {
    canonical = fs.realpathSync(root);
  } catch {}
  const statuses = paths.map((relative) => {
    if (canonical === null || typeof relative !== "string") return "unavailable";
    if (Date.now() - started > budget) return "unavailable";
    if (!relative || path.isAbsolute(relative)) return "outside-workspace";
    const resolved = path.resolve(canonical, relative);
    if (!inside(canonical, resolved)) return "outside-workspace";
    try {
      const real = fs.realpathSync(resolved);
      if (!inside(canonical, real)) return "outside-workspace";
      fs.statSync(real);
      return "exists";
    } catch (error) {
      const code = error && error.code;
      return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
    }
  });
  process.stdout.write(JSON.stringify(statuses));
});
`;

type SpawnPipe = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

/**
 * Run `CONTAINER_PATH_CHECKER` in a container (`docker exec -i ... node -e`).
 * Bounded: stdout is capped, and the exec is killed after `timeoutMs`.
 * Resolves with the parsed status array; rejects on any failure, which the
 * caller turns into `unavailable`.
 */
export function runContainerPathCheck(
  spawn: SpawnPipe,
  containerId: string,
  paths: readonly string[],
  options: { timeoutMs?: number; budgetMs?: number } = {},
): Promise<WebAnnotationFileCheckStatus[]> {
  const input = JSON.stringify(paths.slice(0, MAX_WORKSPACE_PATH_CHECKS));
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", [
      "exec",
      "-i",
      containerId,
      "node",
      "-e",
      CONTAINER_PATH_CHECKER,
      "--",
      "/workspace",
      String(options.budgetMs ?? WORKSPACE_PATH_CHECK_DEADLINE_MS),
    ]);
    let stdout = "";
    let settled = false;
    const finish = (error: Error | null, value?: WebAnnotationFileCheckStatus[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Container path check timed out"));
    }, options.timeoutMs ?? CONTAINER_PATH_CHECK_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      // 200 statuses of at most 19 characters each fit in well under 8 KiB.
      if (stdout.length < 8_192) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) return finish(new Error(`Container path check exited with ${code}`));
      try {
        finish(null, parseContainerPathStatuses(JSON.parse(stdout), paths.length));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Container path check failed"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** Strict parse of the checker's answer: one known status per path, in order. */
export function parseContainerPathStatuses(
  value: unknown,
  count: number,
): WebAnnotationFileCheckStatus[] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    !value.every((status) => STATUSES.has(status as WebAnnotationFileCheckStatus))
  ) {
    throw new Error("Container path check returned an invalid answer");
  }
  return value as WebAnnotationFileCheckStatus[];
}

async function checkContainerPaths(
  containerId: string,
  unique: readonly string[],
  checkContainer: ContainerPathCheck,
): Promise<WebAnnotationFileCheck[]> {
  const results: WebAnnotationFileCheck[] = unique.map((relative) => ({
    path: relative,
    status: isSafeRelativePath(relative) ? "unavailable" : "outside-workspace",
  }));
  // Only lexically safe paths are sent; the rest are already answered.
  const safe = unique.filter((relative) => isSafeRelativePath(relative));
  if (safe.length === 0) return results;
  let statuses: WebAnnotationFileCheckStatus[];
  try {
    statuses = parseContainerPathStatuses(await checkContainer(containerId, safe), safe.length);
  } catch {
    return results;
  }
  const byPath = new Map(safe.map((relative, index) => [relative, statuses[index]!] as const));
  return results.map((result) => {
    const status = byPath.get(result.path);
    return status ? { path: result.path, status } : result;
  });
}

export async function checkWebAnnotationWorkspacePaths(
  environment: DispatchEnvironment,
  paths: readonly string[],
  options: { checkContainer?: ContainerPathCheck } = {},
): Promise<WebAnnotationFileCheck[]> {
  const unique = Array.from(new Set(paths)).slice(0, MAX_WORKSPACE_PATH_CHECKS);
  const unavailable = () =>
    unique.map((relative) => ({
      path: relative,
      status: isSafeRelativePath(relative)
        ? ("unavailable" as const)
        : ("outside-workspace" as const),
    }));
  if (environment.environmentType !== "local") {
    if (!environment.containerId || !options.checkContainer) return unavailable();
    return checkContainerPaths(environment.containerId, unique, options.checkContainer);
  }
  if (!environment.worktreePath) return unavailable();
  let root: string;
  try {
    root = await realpath(environment.worktreePath);
  } catch {
    return unavailable();
  }
  const results: WebAnnotationFileCheck[] = unique.map((relative) => ({
    path: relative,
    status: "unavailable" as const,
  }));
  let cursor = 0;
  const deadline = Date.now() + WORKSPACE_PATH_CHECK_DEADLINE_MS;
  const worker = async () => {
    while (cursor < unique.length) {
      const index = cursor++;
      const relative = unique[index]!;
      results[index] =
        Date.now() > deadline
          ? { path: relative, status: "unavailable" }
          : await checkLocalPath(root, relative);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return results;
}
