import { promises as fs } from "node:fs";
import { isGitRemoteUrl } from "@orkestrator/protocol/git-remote-url";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { publicActionNestedKeys } from "@orkestrator/protocol/public-api-inputs";
import {
  addExistingProject,
  createProjectFromScratch,
  initLocalProject,
  ProjectCreationStageError,
  readOriginUrl,
} from "../commands-projects.js";
import { cleanupProjectForRemoval } from "../commands-registry-projects.js";
import { ProjectHasEnvironmentsError } from "../storage-projects.js";
import type { Environment } from "../models.js";
import { requireProject } from "./actions-discovery.js";
import { runWithContinuation } from "./background.js";
import { boundedMessage, PublicActionError } from "./errors.js";
import {
  absolutePath,
  invalid,
  onlyActionKeys,
  onlyKeys,
  optionalBoolean,
  optionalString,
  requiredId,
} from "./input.js";
import { publicProjectSummary } from "./summaries.js";
import type {
  ExecuteOutcome,
  MutationActionHandler,
  OperationHandle,
  PublicActionContext,
  PublicActionHandler,
} from "./types.js";

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
    onlyActionKeys(input, "project.add");
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
    onlyActionKeys(input, "project.create");
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

const projectInit: MutationActionHandler<{ path: string }> = {
  kind: "mutation",
  action: "project.init",
  parse(input) {
    onlyActionKeys(input, "project.init");
    const path = absolutePath(input, "path");
    if (!path) throw invalid("path is required");
    return { value: { path }, scope: "installation", intent: { path } };
  },
  async prepare(input, context) {
    const projects = await context.command.storage.loadProjects();
    if (projects.some((project) => project.localPath === input.path)) {
      throw new PublicActionError("conflict", "A project already uses that path");
    }
    return {
      resources: { path: input.path },
      async execute(operation) {
        await operation.update({ stage: "initializing" });
        // Local Git only: no remote, no GitHub, no network.
        const project = await initLocalProject(
          input.path,
          context.command.storage,
          context.dependencies.runProjectCreationCommand,
        );
        return {
          state: "succeeded",
          result: { project: publicProjectSummary(project, 0), remote: null },
          resources: { projectId: project.id, path: project.localPath ?? input.path },
        };
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
    onlyActionKeys(input, "project.update");
    const projectId = requiredId(input, "projectId");
    const expectedRevision = optionalString(input, "expectedRevision", 64);
    const raw = input.set;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw invalid("set must be an object");
    const set = raw as Record<string, unknown>;
    onlyKeys(set, publicActionNestedKeys("project.update", "set"));
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
        const updated = await context.command.storage.publicOperations.updateProjectAtRevision(
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

/** Per-environment results kept in the operation record (which is size-bounded). */
const CASCADE_RESULT_LIMIT = 50;
// Leave room in the 8 KiB ledger record for identity, resources and errors.
const CASCADE_SUMMARY_MAX_BYTES = 3_500;

interface CascadeEntry {
  environmentId: string;
  name: string;
  state: "deleted" | "failed";
  error?: string;
}

/**
 * Delete each environment through the normal lifecycle (`delete_environment`:
 * stop, cleanup ledger, worktree or container removal; a project home never
 * schedules its checkout), one at a time, recording a result for each. Never
 * touches the project checkout or its remote.
 */
async function deleteEnvironments(
  context: PublicActionContext,
  operation: OperationHandle,
  environments: readonly Environment[],
): Promise<CascadeEntry[]> {
  const results: CascadeEntry[] = [];
  for (const environment of environments) {
    try {
      await context.invoke("delete_environment", { environmentId: environment.id });
      const remaining = await context.command.storage.getEnvironment(environment.id);
      results.push(
        remaining
          ? {
              environmentId: environment.id,
              name: environment.name,
              state: "failed",
              error: "The environment still exists after deletion",
            }
          : { environmentId: environment.id, name: environment.name, state: "deleted" },
      );
    } catch (error) {
      results.push({
        environmentId: environment.id,
        name: environment.name,
        state: "failed",
        error: boundedMessage(error).slice(0, 200),
      });
    }
    await operation.update({
      stage: "deleting-environments",
      result: cascadeSummary(results, environments.length),
    });
  }
  return results;
}

export function cascadeSummary(
  results: readonly CascadeEntry[],
  total: number,
): Record<string, unknown> {
  const summary = {
    environments: {
      total,
      deleted: results.filter((entry) => entry.state === "deleted").length,
      failed: results.filter((entry) => entry.state === "failed").length,
      results: [] as CascadeEntry[],
      truncated: false,
      omitted: 0,
    },
  };
  for (const entry of results.slice(0, CASCADE_RESULT_LIMIT)) {
    summary.environments.results.push(entry);
    if (Buffer.byteLength(JSON.stringify(summary)) > CASCADE_SUMMARY_MAX_BYTES) {
      summary.environments.results.pop();
      break;
    }
  }
  summary.environments.omitted = results.length - summary.environments.results.length;
  summary.environments.truncated = summary.environments.omitted > 0;
  return summary;
}

/** Fence, clean up and drop the registration of a project with no environments. */
async function removeEmptyProject(
  context: PublicActionContext,
  operation: OperationHandle,
  projectId: string,
  extra: Record<string, unknown> = {},
): Promise<ExecuteOutcome> {
  const storage = context.command.storage;
  await operation.update({ stage: "fencing" });
  try {
    await storage.fenceEmptyProjectForRemoval(projectId);
  } catch (error) {
    if (error instanceof ProjectHasEnvironmentsError) {
      return {
        state: extra.environments ? "partial" : "failed",
        ...(extra.environments ? { result: extra } : {}),
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
    await cleanupProjectForRemoval(projectId, context.command, context.dependencies.commands);
    await storage.removeProject(projectId);
  } catch (error) {
    // Nothing was deleted from projects.json: lift the fence so the
    // project remains usable, and report the cleanup failure.
    const removed = !(await storage.getProject(projectId));
    if (!removed) await storage.releaseProjectRemovalFence(projectId).catch(() => undefined);
    if (removed) return { state: "succeeded", result: { removed: projectId, ...extra } };
    throw error;
  }
  return {
    state: "succeeded",
    // Registration only: checkouts on disk and remote repositories are untouched.
    result: { removed: projectId, effects: "registration-only", ...extra },
  };
}

const projectRemove: MutationActionHandler<{ projectId: string; cascade?: true }> = {
  kind: "mutation",
  action: "project.remove",
  parse(input) {
    onlyActionKeys(input, "project.remove");
    const projectId = requiredId(input, "projectId");
    const cascade = optionalBoolean(input, "cascade") === true ? true : undefined;
    return {
      value: { projectId, ...(cascade ? { cascade } : {}) },
      scope: `project:${projectId}`,
      // Absent without cascade, so earlier fingerprints still match.
      intent: { cascade },
    };
  },
  async prepare(input, context) {
    await requireProject(context, input.projectId);
    const environments = await context.command.storage.getEnvironmentsByProject(input.projectId);
    if (!input.cascade) {
      if (environments.length > 0) {
        throw new PublicActionError(
          "not-empty",
          `The project has ${environments.length} environment(s); delete them first or pass cascade`,
          { details: { environmentCount: environments.length } },
        );
      }
      return {
        resources: { projectId: input.projectId },
        execute: (operation) => removeEmptyProject(context, operation, input.projectId),
      };
    }
    // Deleting environments is a destructive grant of its own; a Control MCP
    // credential holding only `projects` must not reach it through here.
    if (context.authority !== "operator") {
      throw new PublicActionError(
        "capability-unavailable",
        "Cascade removal is available to the operator only; delete the environments first",
      );
    }
    // The set reviewed at admission. An environment created afterwards is
    // not deleted: the fence then refuses and the operation is partial.
    const reviewed = environments;
    return {
      resolved: { environmentCount: reviewed.length },
      resources: { projectId: input.projectId },
      async execute(operation) {
        await operation.update({
          stage: "deleting-environments",
          result: cascadeSummary([], reviewed.length),
        });
        const task = (async (): Promise<ExecuteOutcome> => {
          const results = await deleteEnvironments(context, operation, reviewed);
          const summary = cascadeSummary(results, reviewed.length);
          if (results.some((entry) => entry.state === "failed")) {
            return {
              state: "partial",
              stage: "completed",
              result: summary,
              error: {
                code: "partial-failure",
                message:
                  "Some environments could not be deleted; the project was kept. Retry with a new request ID after fixing them.",
              },
            };
          }
          return removeEmptyProject(context, operation, input.projectId, summary);
        })();
        // Backend-owned: a dropped client never cancels the cascade.
        return runWithContinuation(operation, task, {
          graceMs: 5_000,
          runningStage: "deleting-environments",
          runningResult: () => operation.current().result ?? cascadeSummary([], reviewed.length),
          onSuccess: (outcome) => outcome,
        });
      },
    };
  },
};

export const PROJECT_HANDLERS: PublicActionHandler[] = [
  projectAdd,
  projectCreate,
  projectInit,
  projectUpdate,
  projectRemove,
];
