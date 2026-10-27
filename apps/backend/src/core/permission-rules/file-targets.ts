import { promises as fs } from "node:fs";
import path from "node:path";
import {
  PERMISSION_RULE_LIMITS,
  workspaceRelativePath,
} from "@orkestrator/protocol/permission-rules";
import { dockerExec } from "../commands-container-exec.js";
import type { Environment } from "../models.js";

/** Reject links rather than letting a lexical rule authorize their targets.
 * Check the filesystem where the agent runs, including existing ancestors of
 * new files. No result is cached between approval reads and answers.
 */
export async function safeFileTargets(
  environment: Environment,
  root: string,
  targets: readonly string[],
  exec: typeof dockerExec = dockerExec,
): Promise<boolean> {
  if (!targets.length || targets.length > PERMISSION_RULE_LIMITS.maxPaths) return false;
  const relatives: string[] = [];
  for (const target of targets) {
    // Do not normalize away traversal before inspecting filesystem components.
    if (target.split("/").includes("..")) return false;
    const relative = workspaceRelativePath(root, target);
    if (!relative) return false;
    relatives.push(relative);
  }
  try {
    if (environment.environmentType === "containerized") {
      if (!environment.containerId || environment.status !== "running") return false;
      // Only single-quoted data reaches the fixed script; no path is executable.
      const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
      const prefixes = new Set<string>([root]);
      for (const relative of relatives) {
        const segments = relative.split("/");
        for (let count = 1; count <= segments.length; count += 1) {
          prefixes.add(`${root}/${segments.slice(0, count).join("/")}`);
        }
      }
      const script = `for p in ${[...prefixes].map(quote).join(" ")}; do [ ! -L "$p" ] || exit 1; done; printf safe`;
      return (await exec(environment.containerId, script, 5_000)) === "safe";
    }
    // Resolve only the trusted workspace root (e.g. macOS /var -> /private/var).
    const canonicalRoot = await fs.realpath(root);
    for (const relative of relatives) {
      let current = canonicalRoot;
      for (const segment of relative.split("/")) {
        current = path.join(current, segment);
        try {
          if ((await fs.lstat(current)).isSymbolicLink()) return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
