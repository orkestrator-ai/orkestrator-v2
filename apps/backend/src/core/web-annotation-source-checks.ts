/**
 * Containment and existence checks for repository-relative paths named by an
 * agent report (and optional development source hints).
 *
 * The checks never read file contents and never follow a path outside the
 * environment workspace: a symlink that resolves elsewhere is reported as
 * `outside-workspace`. They are evidence about the paths, not verification of
 * the change. Container workspaces are not inspected from the host here, so
 * their paths are reported as `unavailable` rather than guessed.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WebAnnotationFileCheck } from "@orkestrator/protocol/web-annotations";
import { isSafeRelativePath } from "@orkestrator/protocol/web-annotations-validation";
import type { DispatchEnvironment } from "./web-annotation-contracts.js";

const MAX_PATHS = 200;
const CONCURRENCY = 8;
const CHECK_DEADLINE_MS = 2_000;

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

export async function checkWebAnnotationWorkspacePaths(
  environment: DispatchEnvironment,
  paths: readonly string[],
): Promise<WebAnnotationFileCheck[]> {
  const unique = Array.from(new Set(paths)).slice(0, MAX_PATHS);
  const unavailable = () =>
    unique.map((relative) => ({
      path: relative,
      status: isSafeRelativePath(relative)
        ? ("unavailable" as const)
        : ("outside-workspace" as const),
    }));
  if (environment.environmentType !== "local" || !environment.worktreePath) return unavailable();
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
  const deadline = Date.now() + CHECK_DEADLINE_MS;
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
