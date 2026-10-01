import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommand } from "./shell.js";
import type { StorageService } from "./storage.js";

export async function resolveProjectGitRoot(
  storage: StorageService,
  projectId: string,
): Promise<string> {
  const project = await storage.getProject(projectId);
  if (!project?.localPath?.trim()) throw new Error("This project has no local checkout configured");
  const requested = await fs.realpath(project.localPath).catch(() => null);
  if (!requested) throw new Error("The configured local checkout is unavailable");
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: requested,
    timeoutMs: 10_000,
  }).catch(() => {
    throw new Error("The configured local checkout is not a Git repository");
  });
  const root = await fs.realpath(result.stdout.trim());
  if (path.normalize(root) !== path.normalize(requested)) {
    throw new Error("Project.localPath must identify the repository root");
  }
  return root;
}
