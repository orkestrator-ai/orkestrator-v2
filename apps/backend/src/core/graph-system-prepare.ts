/**
 * Environments for graph runs (plan P2.7, D7), reusing the Build Pipeline's
 * provisioning: `create_environment`, `start_environment`,
 * `run_environment_setup` — the commands its supervisor's provisioning
 * phases invoke.
 *
 * - {@link GraphRunEnvironmentProvisioner} is the run's `provisioner` hook
 *   (item 202): a run whose template asks for a new environment
 *   (`workspace.create`) is launched `provisioning`; each pass creates the
 *   environment once (idempotent across restarts through
 *   `create_environment`'s `controlRequestId`, `graph-run:<run id>`), starts
 *   it in the background, and reports it ready once it runs.
 * - `prepare-environment` (the node) starts the run's environment if it is
 *   not running, runs its setup script once, and reports the commit work
 *   starts from as `workspace@1`. Once per run, node and iteration: a retry or
 *   restart replays the recorded commit.
 */
import type { GraphRunProvisioner } from "./graph-run-pass.js";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import {
  GraphSystemActionError,
  type GraphSystemActionHandler,
  type GraphSystemInvoke,
} from "./graph-system-action.js";
import type { GraphWorkspaceValue } from "./graph-system-push.js";
import type { Environment } from "./models.js";

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** `create_environment`'s idempotency key for a run's own environment. */
export function graphRunEnvironmentRequestId(runId: string): string {
  return `graph-run:${runId}`;
}

export const prepareEnvironmentAction: GraphSystemActionHandler = {
  action: "prepare-environment",
  async run(ctx) {
    const prepared = await ctx.effect<{ branch: string; headRef: string }>(
      ctx.slotKey(),
      async () => {
        let environment = await ctx.environment();
        if (environment.status !== "running") {
          await ctx.deps.invoke("start_environment", { environmentId: environment.id });
          environment = await ctx.environment();
        }
        if (ctx.params.setup !== false && !environment.setupScriptsComplete) {
          await ctx.deps.invoke("run_environment_setup", { environmentId: environment.id });
          environment = await ctx.environment();
          if (
            !environment.setupScriptsComplete &&
            environment.setupPhase === "failed" &&
            !environment.setupOverride
          ) {
            throw new GraphSystemActionError("The environment's setup script failed");
          }
        }
        ctx.throwIfAborted();
        const headRef = (
          await ctx.deps.shell.git(environment, ["rev-parse", "--verify", "HEAD^{commit}"])
        ).trim();
        if (!COMMIT.test(headRef)) {
          throw new GraphSystemActionError("The environment's HEAD is not a commit");
        }
        return { branch: environment.branch, headRef };
      },
    );
    const workspace: GraphWorkspaceValue = {
      branch: prepared.branch,
      headRef: prepared.headRef,
      baseRef: prepared.headRef,
    };
    await ctx.output("workspace@1", workspace, {
      workspace: { headRef: workspace.headRef, baseRef: prepared.headRef },
    });
  },
};

export interface GraphRunProvisionerDependencies {
  storage: {
    getEnvironment(environmentId: string): Promise<Environment | null>;
    getEnvironmentsByProject(projectId: string): Promise<Environment[]>;
    graphRuns: {
      getGraphArtifact(
        runId: string,
        artifactId: string,
      ): Promise<{ body: { value?: unknown } | Record<string, unknown> } | null>;
    };
  };
  invoke: GraphSystemInvoke;
  /** Monotonic milliseconds (tests). */
  monotonic?: () => number;
}

/** A background start is asked for again when the environment still is not running after this. */
export const GRAPH_RUN_START_RETRY_MS = 60_000;

/** The run's own environment, created and started for it (item 202's `provisioner`). */
export class GraphRunEnvironmentProvisioner implements GraphRunProvisioner {
  /** Run id → when this process last asked for a background start. */
  private readonly started = new Map<string, number>();
  private readonly monotonic: () => number;

  constructor(private readonly deps: GraphRunProvisionerDependencies) {
    this.monotonic = deps.monotonic ?? (() => performance.now());
  }

  /** A short naming prompt: the ticket input's title, else the template's name. */
  private async namingPrompt(run: Readonly<GraphRun>): Promise<string> {
    for (const input of run.plan.inputs) {
      if (input.type !== "ticket@1") continue;
      const id = run.bindings.inputs[input.name];
      if (typeof id !== "string") continue;
      const artifact = await this.deps.storage.graphRuns.getGraphArtifact(run.id, id);
      const value = artifact && "value" in artifact.body ? artifact.body.value : undefined;
      const title = (value as { title?: unknown } | undefined)?.title;
      if (typeof title === "string" && title.trim()) return title.trim().slice(0, 200);
    }
    return run.plan.template.name;
  }

  /**
   * Links the run's Kanban ticket to the environment it now has (item 214),
   * so `update-ticket` finds it. A launch on an existing environment links at
   * launch; this covers a run that created its own. Best-effort: a ticket
   * deleted meanwhile does not stop the run.
   */
  private async linkTicket(run: Readonly<GraphRun>, environmentId: string): Promise<void> {
    const taskId = run.launch?.ticket?.taskId;
    if (!taskId || run.mock) return;
    try {
      await this.deps.invoke("update_kanban_task", { taskId, environmentId });
    } catch (error) {
      console.warn(
        "[graphs] Could not link the run's ticket to its environment:",
        run.id,
        error instanceof Error ? error.name : "error",
      );
    }
  }

  async provision(
    run: Readonly<GraphRun>,
    _signal: AbortSignal,
  ): Promise<
    | { state: "pending" }
    | { state: "ready"; environmentId: string }
    | { state: "failed"; error: string }
  > {
    // The launch's choice (item 214) first, then the template's default.
    const kind =
      run.launch?.create ??
      (run.plan.workspace.kind === "environment" ? run.plan.workspace.create?.kind : undefined);
    const create = kind ? { kind } : undefined;
    if (!create) {
      return {
        state: "failed",
        error: "The template uses an existing environment; launch the run on one",
      };
    }
    const requestId = graphRunEnvironmentRequestId(run.id);
    let environment =
      (await this.deps.storage.getEnvironmentsByProject(run.projectId)).find(
        (candidate) => candidate.controlRequestId === requestId,
      ) ?? null;
    if (environment?.deletionRequestedAt) {
      return { state: "failed", error: "The run's environment was deleted" };
    }
    if (!environment) {
      const containerized = create.kind === "container";
      environment = await this.deps.invoke<Environment>("create_environment", {
        projectId: run.projectId,
        environmentType: containerized ? "containerized" : "local",
        // A container is restricted, the app's own default; a worktree has no firewall.
        networkAccessMode: containerized ? "restricted" : "full",
        controlRequestId: requestId,
        namingPrompt: await this.namingPrompt(run),
      });
      environment = (await this.deps.storage.getEnvironment(environment.id)) ?? environment;
    }
    if (environment.status === "running") {
      this.started.delete(run.id);
      await this.linkTicket(run, environment.id);
      return { state: "ready", environmentId: environment.id };
    }
    if (environment.status === "error") {
      return { state: "failed", error: "The run's environment could not be started" };
    }
    const asked = this.started.get(run.id);
    const now = this.monotonic();
    // A start already in flight is joined, so asking again is harmless.
    if (asked === undefined || now - asked >= GRAPH_RUN_START_RETRY_MS) {
      this.started.set(run.id, now);
      await this.deps.invoke("start_environment_background", { environmentId: environment.id });
    }
    return { state: "pending" };
  }
}
