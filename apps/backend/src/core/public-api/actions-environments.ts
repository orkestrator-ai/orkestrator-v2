import { runCommand } from "../commands-dependencies.js";
import type { Environment } from "../models.js";
import { requireEnvironment, requireProject } from "./actions-discovery.js";
import { runWithContinuation } from "./background.js";
import { PublicActionError } from "./errors.js";
import { invalid, onlyKeys, optionalString, oneOf, requiredId, requiredOneOf } from "./input.js";
import { publicEnvironmentSummary } from "./summaries.js";
import type {
  ExecuteOutcome,
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
} from "./types.js";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";

/**
 * Environment lifecycle actions. Each wraps the same registered command the
 * desktop uses — its validation, lifecycle queue, deletion fences and shutdown
 * handling — and adds a durable receipt. Work that outlives the request keeps
 * running in the backend and completes its operation from a continuation;
 * setup completion is recorded by the reconciler (see `reconciler.ts`).
 */

const FULL_SHA = /^[0-9a-f]{40}$/i;

function assertNotDeleting(environment: Environment): void {
  if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting") {
    throw new PublicActionError("conflict", "The environment is being deleted");
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runCommand("git", ["-C", cwd, ...args], { timeoutMs: 15_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Validate an explicit base against the project's checkout: the commit must
 * exist, the branch must exist (locally or as a remote-tracking branch) and
 * contain the commit, and a container base must be published to a remote,
 * because containers clone from it. Nothing silently falls back to HEAD.
 */
async function validateBase(
  projectPath: string | null,
  type: "local" | "container",
  branch: string,
  commit: string,
): Promise<void> {
  if (!projectPath) {
    if (type === "local") throw invalid("A local environment needs a project checkout");
    // A remote-only project is validated at start, when the container clone
    // exists; an unavailable commit then fails the start with its reason.
    return;
  }
  if ((await git(projectPath, ["cat-file", "-e", `${commit}^{commit}`])) === null) {
    throw new PublicActionError(
      "not-found",
      "The base commit does not exist in the project checkout",
    );
  }
  const refs = [
    `refs/heads/${branch}`,
    ...((
      await git(projectPath, ["for-each-ref", "--format=%(refname)", `refs/remotes/*/${branch}`])
    )
      ?.split("\n")
      .filter(Boolean) ?? []),
  ];
  let found = false;
  for (const ref of refs) {
    if ((await git(projectPath, ["rev-parse", "--verify", "--quiet", ref])) === null) continue;
    found = true;
    if ((await git(projectPath, ["merge-base", "--is-ancestor", commit, ref])) !== null) return;
  }
  if (!found)
    throw new PublicActionError(
      "not-found",
      "The base branch does not exist in the project checkout",
    );
  throw new PublicActionError("conflict", "The base commit is not contained in the base branch");
}

async function assertPublished(projectPath: string | null, commit: string): Promise<void> {
  if (!projectPath) return;
  const containing = await git(projectPath, [
    "for-each-ref",
    `--contains=${commit}`,
    "--format=%(refname)",
    "refs/remotes",
  ]);
  if (!containing?.split("\n").some((ref) => ref && !ref.endsWith("/HEAD"))) {
    throw new PublicActionError(
      "conflict",
      "Container environments clone from the remote; push the base commit to a remote branch first",
    );
  }
}

interface CreateInput {
  projectId: string;
  type: "local" | "container";
  name?: string;
  baseBranch?: string;
  baseCommit?: string;
  networkAccessMode?: "restricted" | "full";
}

export function parseCreateEnvironment(
  input: Record<string, unknown>,
  extraKeys: string[] = [],
): CreateInput {
  onlyKeys(input, [
    "projectId",
    "type",
    "name",
    "baseBranch",
    "baseCommit",
    "networkAccessMode",
    ...extraKeys,
  ]);
  const baseBranch = optionalString(input, "baseBranch", 500)?.trim();
  const baseCommit = optionalString(input, "baseCommit", 40)?.toLowerCase();
  if ((baseBranch ? 1 : 0) + (baseCommit ? 1 : 0) === 1) {
    throw invalid("baseBranch and baseCommit must be given together");
  }
  if (baseCommit && !FULL_SHA.test(baseCommit))
    throw invalid("baseCommit must be a full 40-character SHA");
  const name = optionalString(input, "name", PUBLIC_API_LIMITS.nameMaxChars)?.trim();
  return {
    projectId: requiredId(input, "projectId"),
    type: requiredOneOf(input, "type", ["local", "container"] as const),
    ...(name ? { name } : {}),
    ...(baseBranch ? { baseBranch, baseCommit } : {}),
    ...(input.networkAccessMode !== undefined
      ? { networkAccessMode: oneOf(input, "networkAccessMode", ["restricted", "full"] as const) }
      : {}),
  };
}

export async function validateCreateEnvironment(
  input: CreateInput,
  context: PublicActionContext,
): Promise<void> {
  const project = await requireProject(context, input.projectId);
  if (input.type === "local" && !project.localPath) {
    throw new PublicActionError(
      "unsupported",
      "The project has no local checkout; use a container environment",
    );
  }
  if (input.baseBranch && input.baseCommit) {
    await validateBase(project.localPath ?? null, input.type, input.baseBranch, input.baseCommit);
    if (input.type === "container")
      await assertPublished(project.localPath ?? null, input.baseCommit);
  }
}

export function createEnvironmentArgs(
  input: CreateInput,
  controlRequestId: string,
  fingerprint: string,
): Record<string, unknown> {
  return {
    projectId: input.projectId,
    environmentType: input.type === "local" ? "local" : "containerized",
    ...(input.name ? { name: input.name } : {}),
    ...(input.networkAccessMode ? { networkAccessMode: input.networkAccessMode } : {}),
    ...(input.baseBranch
      ? { delegationBaseBranch: input.baseBranch, delegationBaseCommit: input.baseCommit }
      : {}),
    controlRequestId,
    controlRequestFingerprint: fingerprint,
  };
}

const environmentCreate: MutationActionHandler<CreateInput> = {
  kind: "mutation",
  action: "environment.create",
  parse(input) {
    const value = parseCreateEnvironment(input);
    return { value, scope: `project:${value.projectId}`, intent: value };
  },
  async prepare(input, context) {
    await validateCreateEnvironment(input, context);
    return {
      resources: { projectId: input.projectId },
      async execute(operation) {
        const record = operation.current();
        // The environment store converges on this ID too, so a crash between
        // creation and the receipt update is reconciled from the environment.
        const created = await context.invoke<{ id: string }>(
          "create_environment",
          createEnvironmentArgs(input, `public:${record.requestKey}`, record.fingerprint),
        );
        const environment = await requireEnvironment(context, created.id);
        return {
          state: "succeeded",
          result: { environment: publicEnvironmentSummary(environment) },
          resources: { environmentId: environment.id },
        };
      },
    };
  },
};

type LifecycleVerb = "start" | "stop" | "recreate" | "delete";

const LIFECYCLE_COMMANDS: Record<LifecycleVerb, string> = {
  start: "start_environment",
  stop: "stop_environment",
  recreate: "recreate_environment",
  delete: "delete_environment",
};

function lifecycleHandler(verb: LifecycleVerb): MutationActionHandler<{ environmentId: string }> {
  return {
    kind: "mutation",
    action: `environment.${verb}`,
    parse(input) {
      onlyKeys(input, ["environmentId"]);
      const environmentId = requiredId(input, "environmentId");
      return { value: { environmentId }, scope: `environment:${environmentId}`, intent: {} };
    },
    async prepare(input, context) {
      const environment = await requireEnvironment(context, input.environmentId);
      if (verb !== "delete") assertNotDeleting(environment);
      if (verb === "recreate" && environment.environmentType === "local") {
        throw new PublicActionError(
          "unsupported",
          "Local worktree environments cannot be recreated",
        );
      }
      return {
        resources: { environmentId: environment.id, projectId: environment.projectId },
        async execute(operation) {
          await operation.update({
            stage: verb === "delete" ? "deleting" : `${verb === "stop" ? "stopping" : "starting"}`,
          });
          const task = context.invoke(LIFECYCLE_COMMANDS[verb], { environmentId: environment.id });
          return runWithContinuation(operation, task, {
            runningStage:
              verb === "delete" ? "deleting" : verb === "stop" ? "stopping" : "starting",
            runningResult: { environmentId: environment.id },
            onSuccess: async (): Promise<ExecuteOutcome> => {
              if (verb === "start" || verb === "recreate") {
                // Setup continues in the backend; the reconciler completes
                // this operation when setup is ready or has failed.
                const current = await context.command.storage.getEnvironment(environment.id);
                if (current && isSetupReady(current)) {
                  return {
                    state: "succeeded",
                    stage: "completed",
                    result: {
                      environmentId: environment.id,
                      setup: current.setupOverride ? "overridden" : "ready",
                    },
                  };
                }
                return {
                  state: "running",
                  stage: "setup",
                  result: { environmentId: environment.id },
                };
              }
              return { state: "succeeded", result: { environmentId: environment.id } };
            },
          });
        },
      };
    },
  };
}

export function isSetupReady(environment: Environment): boolean {
  return (
    environment.status === "running" &&
    (environment.setupPhase === "ready" ||
      environment.setupScriptsComplete === true ||
      environment.setupOverride === true)
  );
}

const environmentFork: MutationActionHandler<{
  environmentId: string;
  type: "local" | "container";
}> = {
  kind: "mutation",
  action: "environment.fork",
  parse(input) {
    onlyKeys(input, ["environmentId", "type"]);
    const environmentId = requiredId(input, "environmentId");
    const type = requiredOneOf(input, "type", ["local", "container"] as const);
    return {
      value: { environmentId, type },
      scope: `environment:${environmentId}`,
      intent: { type },
    };
  },
  async prepare(input, context) {
    const source = await requireEnvironment(context, input.environmentId);
    assertNotDeleting(source);
    return {
      resources: { forkedFromEnvironmentId: source.id, projectId: source.projectId },
      async execute(operation) {
        await operation.update({ stage: "forking" });
        const task = context.invoke<{ id: string }>("fork_environment", {
          environmentId: source.id,
          environmentType: input.type === "local" ? "local" : "containerized",
        });
        return runWithContinuation(operation, task, {
          runningStage: "forking",
          onSuccess: async (forked) => {
            const environment = await requireEnvironment(context, forked.id);
            return {
              state: "succeeded",
              result: { environment: publicEnvironmentSummary(environment) },
              resources: { environmentId: environment.id },
            };
          },
        });
      },
    };
  },
};

const environmentRename: MutationActionHandler<{ environmentId: string; name: string }> = {
  kind: "mutation",
  action: "environment.rename",
  parse(input) {
    onlyKeys(input, ["environmentId", "name"]);
    const environmentId = requiredId(input, "environmentId");
    const name = optionalString(input, "name", PUBLIC_API_LIMITS.nameMaxChars)?.trim();
    if (!name) throw invalid("name is required");
    return {
      value: { environmentId, name },
      scope: `environment:${environmentId}`,
      intent: { name },
    };
  },
  async prepare(input, context) {
    const environment = await requireEnvironment(context, input.environmentId);
    assertNotDeleting(environment);
    return {
      resources: { environmentId: environment.id, projectId: environment.projectId },
      async execute(operation) {
        await operation.update({ stage: "renaming" });
        // The registered command renames the branch with the environment; a
        // metadata-only rename would desynchronize them.
        await context.invoke("rename_environment", {
          environmentId: environment.id,
          name: input.name,
        });
        const renamed = await requireEnvironment(context, environment.id);
        return {
          state: "succeeded",
          result: {
            environment: publicEnvironmentSummary(renamed),
            branch: renamed.branch,
          },
        };
      },
    };
  },
};

export const ENVIRONMENT_HANDLERS: PublicActionHandler[] = [
  environmentCreate,
  lifecycleHandler("start"),
  lifecycleHandler("stop"),
  lifecycleHandler("recreate"),
  lifecycleHandler("delete"),
  environmentFork,
  environmentRename,
];
