import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { addExistingProject } from "./commands-projects.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { assertOnlyKeys } from "./commands-validation.js";
import { sanitizeCoordinatorError } from "./coordinator-service.js";
import {
  listProjectCopyCandidates,
  listProjectCopyFiles,
} from "./nodes/node-project-copy-files.js";
import type { StorageService } from "./storage.js";

/**
 * The per-machine half of copying a project between machines (see
 * `@orkestrator/protocol/project-copy`). Every node registers these; the
 * command node calls them on the source and the target, locally or through
 * the node link.
 *
 * - `get_default_project_location`: where a copy of a project lands here.
 * - `list_project_copy_candidates` / `list_project_copy_files`: the files
 *   Git does not carry, and the files under a selection.
 * - `start_project_clone` / `get_project_clone`: a clone that runs in the
 *   background, because cloning can take longer than one node call.
 */

const MAX_CLONE_JOBS = 50;
const FINISHED_CLONE_TTL_MS = 60 * 60 * 1_000;
const MAX_NAME_CHARS = 200;

function commonParent(localPaths: ReadonlyArray<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  let best: { directory: string; count: number } | undefined;
  for (const localPath of localPaths) {
    if (!localPath?.trim() || !path.isAbsolute(localPath)) continue;
    const directory = path.dirname(localPath);
    if (!directory || directory === localPath) continue;
    const count = (counts.get(directory) ?? 0) + 1;
    counts.set(directory, count);
    if (!best || count > best.count) best = { directory, count };
  }
  return best?.directory;
}

function safeDirectoryName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .slice(0, MAX_NAME_CHARS);
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("Expected a project name.");
  return cleaned;
}

async function exists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false,
  );
}

/**
 * `<default folder>/<name>`, the first free one of `<name>`, `<name>-2`, ….
 * The default folder is the configured one, else the most common parent of
 * this machine's projects, else `~/Projects`.
 */
export async function defaultProjectLocation(
  storage: Pick<StorageService, "loadConfig" | "loadProjects">,
  name: string,
): Promise<{
  directory: string;
  location: string;
  source: "setting" | "projects" | "home";
}> {
  const folder = safeDirectoryName(name);
  const configured = (await storage.loadConfig()).global.defaultProjectsDirectory;
  const fromProjects = configured
    ? undefined
    : commonParent((await storage.loadProjects()).map((project) => project.localPath ?? undefined));
  const directory = configured ?? fromProjects ?? path.join(os.homedir(), "Projects");
  const source = configured ? "setting" : fromProjects ? "projects" : "home";
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const location = path.join(directory, attempt === 1 ? folder : `${folder}-${attempt}`);
    if (!(await exists(location))) return { directory, location, source };
  }
  return { directory, location: path.join(directory, folder), source };
}

type CloneJob = {
  requestKey: string;
  gitUrl: string;
  localPath: string;
  state: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  finishedAtMs?: number;
  projectId?: string;
  error?: string;
};

function view(job: CloneJob) {
  return {
    requestKey: job.requestKey,
    state: job.state,
    localPath: job.localPath,
    startedAt: job.startedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.projectId ? { projectId: job.projectId } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

export function registerProjectCopyCommands(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "runProjectCreationCommand">,
): void {
  const jobs = new Map<string, CloneJob>();

  const prune = () => {
    const now = Date.now();
    for (const [key, job] of jobs) {
      if (job.finishedAtMs !== undefined && now - job.finishedAtMs > FINISHED_CLONE_TTL_MS)
        jobs.delete(key);
    }
  };

  register("get_default_project_location", async (args, { storage }) => {
    assertOnlyKeys(args, ["name"], "arguments");
    if (typeof args.name !== "string") throw new Error("Expected name.");
    return defaultProjectLocation(storage, args.name);
  });

  register("list_project_copy_candidates", async (args, { storage }) => {
    assertOnlyKeys(args, ["projectId"], "arguments");
    if (typeof args.projectId !== "string") throw new Error("Expected projectId.");
    const project = await storage.getProject(args.projectId);
    if (!project?.localPath) throw new Error("That project has no local checkout on this machine.");
    const config = await storage.getRepositoryConfig(project.id);
    return listProjectCopyCandidates(project.localPath, config.filesToCopy);
  });

  register("list_project_copy_files", async (args, { storage }) => {
    assertOnlyKeys(args, ["projectId", "paths"], "arguments");
    if (typeof args.projectId !== "string") throw new Error("Expected projectId.");
    if (
      !Array.isArray(args.paths) ||
      args.paths.length > 2_000 ||
      !args.paths.every((entry) => typeof entry === "string" && entry.length <= 1_024)
    ) {
      throw new Error("Expected paths.");
    }
    const project = await storage.getProject(args.projectId);
    if (!project?.localPath) throw new Error("That project has no local checkout on this machine.");
    return listProjectCopyFiles(project.localPath, args.paths as string[]);
  });

  register("start_project_clone", async (args, { storage }) => {
    assertOnlyKeys(args, ["requestKey", "gitUrl", "localPath"], "arguments");
    const { requestKey, gitUrl, localPath } = args;
    if (typeof requestKey !== "string" || !requestKey || requestKey.length > 200) {
      throw new Error("Expected requestKey.");
    }
    // `add_project` validates the remote itself, as it does for the Add Project dialog.
    if (typeof gitUrl !== "string" || !gitUrl.trim() || gitUrl.length > 2_048) {
      throw new Error("Expected the project's Git remote.");
    }
    if (typeof localPath !== "string" || !path.isAbsolute(localPath) || localPath.includes("\0")) {
      throw new Error("Expected an absolute location on this machine.");
    }
    prune();
    const existing = jobs.get(requestKey);
    if (existing) {
      if (existing.gitUrl !== gitUrl || existing.localPath !== localPath) {
        throw new Error("That requestKey was already used for a different clone.");
      }
      return view(existing);
    }
    if (jobs.size >= MAX_CLONE_JOBS) throw new Error("Too many clones are running; retry later.");
    const job: CloneJob = {
      requestKey,
      gitUrl,
      localPath,
      state: "running",
      startedAt: new Date().toISOString(),
    };
    jobs.set(requestKey, job);
    void addExistingProject(
      gitUrl,
      localPath,
      storage,
      dependencies.runProjectCreationCommand,
      undefined,
      true,
    )
      .then(
        (project) => {
          job.state = "completed";
          job.projectId = project.id;
        },
        (error: unknown) => {
          job.state = "failed";
          job.error = sanitizeCoordinatorError(error).slice(0, 500);
        },
      )
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        job.finishedAtMs = Date.now();
      });
    return view(job);
  });

  register("get_project_clone", async (args) => {
    assertOnlyKeys(args, ["requestKey"], "arguments");
    if (typeof args.requestKey !== "string") throw new Error("Expected requestKey.");
    const job = jobs.get(args.requestKey);
    return job ? view(job) : { requestKey: args.requestKey, state: "unknown" as const };
  });
}
