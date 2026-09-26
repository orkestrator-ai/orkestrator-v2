import { promises as fs } from "node:fs";
import { isGitRemoteUrl } from "@orkestrator/protocol/git-remote-url";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import {
  addExistingProject,
  createProjectFromScratch,
  ProjectCreationStageError,
  readOriginUrl,
} from "../commands-projects.js";
import { cleanupProjectForRemoval } from "../commands-registry-projects.js";
import { ProjectHasEnvironmentsError } from "../storage-projects.js";
import { requireProject } from "./actions-discovery.js";
import { boundedMessage, PublicActionError } from "./errors.js";
import { absolutePath, invalid, onlyKeys, optionalString, requiredId } from "./input.js";
import { publicProjectSummary } from "./summaries.js";
import type { MutationActionHandler, PublicActionHandler } from "./types.js";

async function environmentCount(
  context: Parameters<MutationActionHandler["prepare"]>[1],
  projectId: string,
): Promise<number> {
  return (await context.command.storage.getEnvironmentsByProject(projectId)).length;
}

const projectAdd: MutationActionHandler<{ remote?: string; path?: string }> = {
  kind: "mutation",
  action: "project.add",
  parse(input) {
    onlyKeys(input, ["remote", "path"]);
    const remote = optionalString(input, "remote", PUBLIC_API_LIMITS.gitUrlMaxChars)?.trim();
    const path = absolutePath(input, "path");
    if (!remote && !path) throw invalid("Pass remote, path, or both");
    if (remote && !isGitRemoteUrl(remote)) throw invalid("remote is not a Git remote URL");
    return { value: { remote, path }, scope: "installation", intent: { remote, path } };
  },
  async prepare(input, context) {
    const run = context.dependencies.runProjectCreationCommand;
    let remote = input.remote;
    if (!remote) {
      // A checkout supplies its own origin, read on the backend host (never
      // the client's working directory).
      const stat = await fs.stat(input.path!).catch(() => null);
      if (!stat?.isDirectory()) {
        throw new PublicActionError("not-found", "No checkout exists at that backend path");
      }
      remote = (await readOriginUrl(input.path!, run).catch(() => "")) || undefined;
      if (!remote) {
        throw new PublicActionError(
          "invalid-input",
          "The checkout has no origin remote; pass remote explicitly",
        );
      }
    }
    const projects = await context.command.storage.loadProjects();
    if (projects.some((project) => project.gitUrl === remote)) {
      throw new PublicActionError("conflict", "A project with that remote is already registered");
    }
    if (input.path && projects.some((project) => project.localPath === input.path)) {
      throw new PublicActionError("conflict", "A project already uses that checkout path");
    }
    const gitUrl = remote;
    return {
      resolved: { remote: gitUrl },
      resources: { remote: gitUrl, ...(input.path ? { path: input.path } : {}) },
      async execute(operation) {
        await operation.update({ stage: input.path ? "attaching-or-cloning" : "registering" });
        const project = await addExistingProject(gitUrl, input.path, context.command.storage, run);
        return {
          state: "succeeded",
          result: { project: publicProjectSummary(project, 0) },
          resources: {
            projectId: project.id,
            remote: project.gitUrl,
            ...(project.localPath ? { path: project.localPath } : {}),
          },
        };
      },
    };
  },
};

const projectCreate: MutationActionHandler<{ path: string }> = {
  kind: "mutation",
  action: "project.create",
  parse(input) {
    onlyKeys(input, ["path", "githubPrivate"]);
    if (input.githubPrivate !== true) {
      throw invalid(
        "project.create creates a private GitHub repository and pushes to it; set githubPrivate to true to confirm",
      );
    }
    const path = absolutePath(input, "path");
    if (!path) throw invalid("path is required");
    return { value: { path }, scope: "installation", intent: { path, githubPrivate: true } };
  },
  async prepare(input, context) {
    const projects = await context.command.storage.loadProjects();
    if (projects.some((project) => project.localPath === input.path)) {
      throw new PublicActionError("conflict", "A project already uses that path");
    }
    return {
      resources: { path: input.path },
      async execute(operation) {
        await operation.update({ stage: "creating" });
        try {
          const project = await createProjectFromScratch(
            input.path,
            context.command.storage,
            context.dependencies.runProjectCreationCommand,
          );
          return {
            state: "succeeded",
            result: { project: publicProjectSummary(project, 0) },
            resources: { projectId: project.id, remote: project.gitUrl, path: input.path },
          };
        } catch (error) {
          if (error instanceof ProjectCreationStageError) {
            // Never retried automatically: the local repository is preserved
            // and the remote's existence must be verified by the operator.
            return error.remoteState === "ambiguous"
              ? {
                  state: "unknown",
                  stage: "creating-remote",
                  error: { code: "run-unknown", message: boundedMessage(error) },
                }
              : {
                  state: "partial",
                  stage: "registering",
                  error: { code: "partial-failure", message: boundedMessage(error) },
                };
          }
          throw error;
        }
      },
    };
  },
};

interface ProjectUpdateInput {
  projectId: string;
  expectedRevision?: string;
  set: { name?: string; folder?: string | null; remote?: string; path?: string | null };
}

const projectUpdate: MutationActionHandler<ProjectUpdateInput> = {
  kind: "mutation",
  action: "project.update",
  parse(input) {
    onlyKeys(input, ["projectId", "set", "expectedRevision"]);
    const projectId = requiredId(input, "projectId");
    const expectedRevision = optionalString(input, "expectedRevision", 64);
    const raw = input.set;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw invalid("set must be an object");
    const set = raw as Record<string, unknown>;
    onlyKeys(set, ["name", "folder", "remote", "path"]);
    const parsed: ProjectUpdateInput["set"] = {};
    if (set.name !== undefined)
      parsed.name = optionalString(set, "name", PUBLIC_API_LIMITS.nameMaxChars)!.trim();
    if (set.folder !== undefined) {
      parsed.folder =
        set.folder === null ? null : optionalString(set, "folder", PUBLIC_API_LIMITS.nameMaxChars)!;
    }
    if (set.remote !== undefined) {
      parsed.remote = optionalString(set, "remote", PUBLIC_API_LIMITS.gitUrlMaxChars)!.trim();
    }
    if (set.path !== undefined) parsed.path = set.path === null ? null : absolutePath(set, "path")!;
    if (Object.keys(parsed).length === 0) throw invalid("set must change at least one field");
    return {
      value: { projectId, set: parsed, ...(expectedRevision ? { expectedRevision } : {}) },
      scope: `project:${projectId}`,
      intent: { set: parsed, expectedRevision: expectedRevision ?? null },
    };
  },
  async prepare(input, context) {
    const project = await requireProject(context, input.projectId);
    if (
      input.set.remote !== undefined &&
      input.set.remote !== project.gitUrl &&
      !isGitRemoteUrl(input.set.remote)
    ) {
      throw invalid("remote is not a Git remote URL");
    }
    return {
      resources: { projectId: project.id },
      async execute() {
        const updated = await context.command.storage.updateProjectAtRevision(
          input.projectId,
          input.expectedRevision,
          {
            ...(input.set.name !== undefined ? { name: input.set.name } : {}),
            ...(input.set.folder !== undefined ? { folder: input.set.folder } : {}),
            ...(input.set.remote !== undefined ? { gitUrl: input.set.remote } : {}),
            ...(input.set.path !== undefined ? { localPath: input.set.path } : {}),
          },
        );
        return {
          state: "succeeded",
          result: {
            project: publicProjectSummary(updated, await environmentCount(context, updated.id)),
            // Stored metadata only: no directory moves, no .git/config rewrite.
            effects: "metadata-only",
          },
        };
      },
    };
  },
};

const projectRemove: MutationActionHandler<{ projectId: string }> = {
  kind: "mutation",
  action: "project.remove",
  parse(input) {
    onlyKeys(input, ["projectId"]);
    const projectId = requiredId(input, "projectId");
    return { value: { projectId }, scope: `project:${projectId}`, intent: {} };
  },
  async prepare(input, context) {
    await requireProject(context, input.projectId);
    const count = await environmentCount(context, input.projectId);
    if (count > 0) {
      throw new PublicActionError(
        "not-empty",
        `The project has ${count} environment(s); delete them first (no cascade)`,
        { details: { environmentCount: count } },
      );
    }
    return {
      resources: { projectId: input.projectId },
      async execute(operation) {
        const storage = context.command.storage;
        await operation.update({ stage: "fencing" });
        try {
          await storage.fenceEmptyProjectForRemoval(input.projectId);
        } catch (error) {
          if (error instanceof ProjectHasEnvironmentsError) {
            return {
              state: "failed",
              error: {
                code: "not-empty",
                message: `The project has ${error.environmentCount} environment(s); delete them first`,
              },
            };
          }
          throw error;
        }
        await operation.update({ stage: "cleanup" });
        try {
          await cleanupProjectForRemoval(
            input.projectId,
            context.command,
            context.dependencies.commands,
          );
          await storage.removeProject(input.projectId);
        } catch (error) {
          // Nothing was deleted from projects.json: lift the fence so the
          // project remains usable, and report the cleanup failure.
          const removed = !(await storage.getProject(input.projectId));
          if (!removed)
            await storage.releaseProjectRemovalFence(input.projectId).catch(() => undefined);
          if (removed) return { state: "succeeded", result: { removed: input.projectId } };
          throw error;
        }
        return {
          state: "succeeded",
          // Registration only: checkouts on disk and remote repositories are untouched.
          result: { removed: input.projectId, effects: "registration-only" },
        };
      },
    };
  },
};

export const PROJECT_HANDLERS: PublicActionHandler[] = [
  projectAdd,
  projectCreate,
  projectUpdate,
  projectRemove,
];
