import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  formatContainerLifecycleError,
  parseContainerLifecycle,
} from "@orkestrator/protocol/container-lifecycle";
import { classifyCommandFailure } from "@orkestrator/protocol/node/command-failure-reason";
import { promises as seedFs } from "node:fs";
import type { CommandContext } from "./commands-context.js";
import { cleanupErrorMessage } from "./commands-error-text.js";
import {
  assertDockerContainerOwned,
  cleanupEnvironmentSetupState,
  deleteMergedEnvironmentRemoteBranch,
  enqueueEnvironmentLifecycleOperation,
} from "./commands-environment.js";
import { stopLocalServersForEnvironmentUnlocked } from "./commands-local-server-lifecycle.js";
import { drainContainerProcesses } from "./container-readiness.js";
import { environmentCleanupLedger } from "./environment-cleanup-ledger.js";
import { buildEnvironmentCleanupEntry, runEnvironmentCleanupStep } from "./environment-cleanup.js";
import { scheduleEnvironmentCleanupReconcile } from "./environment-cleanup-reconciler.js";
import { removeEnvironmentGraphArtifactFiles } from "./graph-artifacts.js";
import { removeEnvironmentGraphBranchWorktrees } from "./graph-branch-worktrees.js";
import { removeProjectHomeMailAttachments } from "./mail-attachments.js";
import { seedFilesDir } from "./nodes/index.js";
import { removeOpenCodeCommandChangeJournals } from "./opencode-command-changes.js";
import { stopEnvironmentExecWorkers } from "./public-api/exec-control.js";
import { stopEnvironmentReviewValidation } from "./review-validation-service.js";
import { cleanupEnvironmentTmux, shutdownClaudeStatePolling } from "./tmux.js";
import { transcriptMediaPins } from "./transcript-media-pins.js";
import { environmentDeletionSteps } from "./environment-deletion-steps.js";
import type { EnvironmentDeletionStep } from "@orkestrator/protocol/node-summaries";

/**
 * Deleting an environment: `deleteEnvironmentTask` is the queued entry point
 * (merge cleanup uses it too), `deleteEnvironment` the ordered teardown. See
 * docs/architecture/environment-deletion.md.
 */

const environmentLog = createLogger("environment");

/** Deletion drains briefly: the container is removed right after. */
const DELETION_DRAIN_GRACE_SECONDS = 5;

export type DeleteEnvironmentOptions = {
  allowWhileMerging?: boolean;
  /** Tests shorten the step deadlines; see `ENVIRONMENT_DELETION_STEP_DEADLINES_MS`. */
  stepDeadlinesMs?: Partial<Record<EnvironmentDeletionStep, number>>;
};

export async function deleteEnvironment(
  environmentId: string,
  context: CommandContext,
  options: DeleteEnvironmentOptions = {},
): Promise<void> {
  if (context.runtime.localServers.isShuttingDown()) {
    throw new Error("Backend is shutting down; environments cannot be deleted");
  }
  if (context.runtime.environments.isMerging(environmentId) && !options.allowWhileMerging) {
    throw new Error(`Environment is currently being merged: ${environmentId}`);
  }
  try {
    await context.runtime.localServers.enqueueEnvironmentOperation(environmentId, async () => {
      const { storage } = context;
      const environment = await storage.getEnvironment(environmentId);
      // A lifecycle record written by a newer version may reference storage
      // this version cannot recognise; deleting around it could orphan data.
      if (environment && !parseContainerLifecycle(environment.containerLifecycle).supported) {
        throw new Error(
          formatContainerLifecycleError(
            "unsupported-format",
            "This environment was changed by a newer version of Orkestrator. Update Orkestrator before deleting it.",
          ),
        );
      }
      // Deleting removes the container, its volumes and its network, so it
      // needs the registry writer like every other container mutation. A
      // backend opened over a newer writer's data directory is read-only.
      if (environment?.environmentType === "containerized") {
        context.registryWriterLease?.assertHeld();
      }
      if (environment?.containerId) {
        await assertDockerContainerOwned(environment.containerId, context);
      }
      // Persist the deletion intent before any durable child-state cleanup.
      // Queue/pipeline saves consult this marker while holding their own locks:
      // a write that began earlier is swept by cleanup, and a later write is
      // rejected even if cleanup pauses or fails.
      await storage.updateEnvironment(environmentId, {
        deletionRequestedAt: new Date().toISOString(),
        cleanupAfterMergeError: null,
        deletionError: null,
        deletionStep: "stopping-work",
        lifecycleOperation: "deleting",
        lifecycleOperationStartedAt: new Date().toISOString(),
      });
      // Each step is recorded as it is reached, so a slow delete can say what
      // it is waiting for. Steps that run child processes have a deadline.
      const steps = environmentDeletionSteps({
        environmentId,
        deadlinesMs: options.stepDeadlinesMs,
        record: async (step) => {
          if (environment) await storage.updateEnvironment(environmentId, { deletionStep: step });
        },
      });
      // Record what the host still owes before anything is removed. The
      // best-effort steps below may fail after the environment record is gone;
      // the ledger is what lets the reconciler finish them later.
      const project = environment
        ? await storage.getProject(environment.projectId).catch(() => null)
        : null;
      const cleanup = environment
        ? buildEnvironmentCleanupEntry(environment, project, storage.getDataDir())
        : null;
      if (cleanup) await environmentCleanupLedger(storage.getDataDir()).record(cleanup);
      // Agents lose tool access first: nothing an agent calls back into may act
      // on an environment that is being taken apart.
      context.agentTools?.revokeEnvironment(environmentId);
      await context.suborks?.deleteEnvironment(environmentId);
      await stopEnvironmentReviewValidation(environmentId, context);
      await stopEnvironmentExecWorkers(environmentId, context);
      // The user's `!` commands run in the worktree too.
      await context.userCommands?.terminateForEnvironment(environmentId);
      context.humanPrompts?.clearEnvironment(environmentId);
      await steps.enter("terminals");
      // Waits for every terminal tree, including setup's build descendants, so
      // nothing re-creates files in the worktree after it is removed below.
      const survivingTerminals =
        await context.runtime.terminals.terminateSessionsForEnvironment(environmentId);
      if (survivingTerminals.length > 0) {
        environmentLog.warn("delete.terminals-survived", {
          environmentId,
          count: survivingTerminals.length,
        });
        throw new Error(
          "Terminal process trees are still running; environment deletion can be retried",
        );
      }
      await steps.enter("workspace-files");
      await context.runtime.terminals.history.deleteHistories({
        dataDir: storage.getDataDir(),
        environmentId,
      });
      if (environment)
        await deleteMergedEnvironmentRemoteBranch(
          environment,
          storage,
          context.runtime.gitHubCli,
        ).catch(() => undefined);
      if (environment?.worktreePath)
        context.runtime.diffStats.gitFetchScheduler.forget(environment.worktreePath);
      // Graph runs' reference artifacts live in the workspace: remove them
      // while the worktree and container still exist (a project home's
      // worktree is kept). Their records go with the other records below.
      if (environment && storage.graphRuns) {
        const files = await removeEnvironmentGraphArtifactFiles(environment, {
          storage,
          fence: context.runtime.environments.fence,
        });
        if (files.failed > 0) {
          environmentLog.warn("delete.artifacts-left", { environmentId, failed: files.failed });
        }
        // Isolated branch worktrees and branches (item 403): for a local
        // environment the branches live in the shared repository, so they
        // must go before the worktree does.
        const branches = await removeEnvironmentGraphBranchWorktrees(environment, {
          storage,
          fence: context.runtime.environments.fence,
        });
        if (branches.failed > 0) {
          environmentLog.warn("delete.worktrees-kept", { environmentId, failed: branches.failed });
        }
      }
      // Before the container is removed and before the worktree is deleted:
      // killing the tmux sessions needs the container alive, and restoring the
      // user's `.claude/settings.local.json` from the tmux-mode backup needs
      // the worktree still on disk. Best-effort — a tmux server that has
      // already gone must not strand the rest of the deletion.
      await cleanupEnvironmentTmux(environmentId, context).catch((error: unknown) => {
        environmentLog.warn("delete.step-failed", {
          environmentId,
          step: "claude-tmux",
          ...classifyCommandFailure(error, { tools: ["tmux"] }),
          error: formatLogError(error),
        });
      });
      context.previews?.registry.beforeEnvironmentTargetChange(environmentId);
      const ownsContainerWork =
        !!environment?.containerId ||
        !!cleanup?.pending.some((step) => ["container", "volumes", "network"].includes(step));
      if (ownsContainerWork) {
        await steps.run("container", async (signal) => {
          if (environment?.containerId) {
            // Retire state polling before removing the container, or the next tick
            // execs into something that no longer exists.
            shutdownClaudeStatePolling(context, environment.containerId);
            context.runtime.localServers.openCodeAgentTools.cancel(
              `container:${environment.containerId}`,
            );
            // Bridges and agents get the drain's SIGTERM, so they settle their
            // journals and deny parked approvals before the forced removal. A
            // stopped container has nothing to drain and is not exec'd into.
            if (environment.status === "running") {
              await drainContainerProcesses(environment.containerId, DELETION_DRAIN_GRACE_SECONDS, {
                signal,
              }).catch(() => null);
            }
            // Ownership was asserted before the tombstone, above.
            if (cleanup) {
              await runEnvironmentCleanupStep(cleanup, "container", context, {
                containerOwnershipVerified: true,
                signal,
              });
            }
          }
          // Recovery copies are owed even when no current runtime exists.
          if (!environment?.containerId && cleanup?.pending.includes("container")) {
            await runEnvironmentCleanupStep(cleanup, "container", context, { signal });
          }
          // Persistent storage and the environment's network go after its
          // containers; a failure stays pending in the ledger and is retried by
          // the reconciler.
          if (cleanup?.pending.includes("volumes")) {
            await runEnvironmentCleanupStep(cleanup, "volumes", context, { signal });
          }
          if (cleanup?.pending.includes("network")) {
            await runEnvironmentCleanupStep(cleanup, "network", context, { signal });
          }
        });
      }
      await steps.enter("local-servers");
      await stopLocalServersForEnvironmentUnlocked(environmentId, context);
      let worktreeFenced = false;
      if (cleanup?.worktreePath) {
        await steps.run("worktree", async (signal) => {
          const worktreeRemoved = await runEnvironmentCleanupStep(cleanup, "worktree", context, {
            // The ownership check may retain the checkout. Fence its physical
            // readers only when the step will actually remove it.
            beforeWorktreeRemoval: () => {
              worktreeFenced = true;
              return context.runtime.diffStats.pauseForRemoval(environmentId, cleanup.worktreePath);
            },
            signal,
          });
          // A branch still checked out in a surviving worktree cannot be judged or
          // deleted; the reconciler retries it after the worktree step succeeds.
          if (worktreeRemoved && cleanup.branch) {
            await runEnvironmentCleanupStep(cleanup, "branch", context, { signal });
          }
        });
      }
      // Retained checkouts and project homes only retire this environment's
      // watcher; their other owners keep scanning. The tombstone prevents re-entry.
      if (!worktreeFenced) await context.runtime.diffStats.pauseForRemoval(environmentId);
      await steps.enter("records");
      // Damaged session metadata must not strand deletion after resources are gone.
      await storage.removeSessionsByEnvironment(environmentId).catch(() => {
        environmentLog.warn("cleanup.sessions-failed", { environmentId });
      });
      await storage.deleteMultiReviewWorkflowsByEnvironment(environmentId);
      // A pipeline whose environment is gone can never advance again; leaving it
      // behind would resurrect a dead build on the next client that hydrates.
      await storage.deleteBuildPipelinesByEnvironment(environmentId, environment?.buildPipelineId);
      // A graph run is scoped to one environment (D7) and its artifacts to the
      // run: both go with it, like a pipeline.
      if (storage.graphRuns) await storage.graphRuns.deleteGraphRunsByEnvironment(environmentId);
      if (storage.suborks) await storage.suborks.deleteSuborkBatchesByEnvironment(environmentId);
      // Its "Describe a graph" job can never run again either (item 215).
      storage.graphDescribe?.deleteGraphDescribeJob(environmentId);
      // Queued prompts for a deleted environment can never be dispatched.
      await storage.deletePromptQueuesByEnvironment(environmentId);
      // StorageService owns this in production. Keep the deletion seam tolerant
      // of legacy/embedded command adapters that intentionally implement only
      // the older lifecycle subset; their absence cannot justify stranding an
      // otherwise deletable environment.
      if (typeof storage.deleteAgentMailByEnvironment === "function") {
        await storage.deleteAgentMailByEnvironment(environmentId);
      }
      // Best-effort, like its siblings: leaving a stale session mapping behind
      // is recoverable, but aborting here would strand the environment record
      // itself because `removeEnvironment` below would never run.
      //
      // Logged rather than swallowed. This call queues behind an in-flight
      // prompt dispatch, which legitimately holds the native-agent lock across
      // provider I/O, so a failure here is the one way a deleted environment
      // keeps its session record and its pending prompt on disk. The lock's
      // acquire timeout is sized to outlast that holder, so if this still fires
      // it is evidence of something else and must not be invisible.
      await storage
        .deleteNativeAgentSessionsByEnvironment(environmentId)
        .catch((error: unknown) => {
          environmentLog.warn("delete.step-failed", {
            environmentId,
            step: "native-sessions",
            error: formatLogError(error),
          });
        });
      // Measured shell-change badges of the environment's OpenCode sessions.
      // Never rejects; a leftover journal only costs disk.
      if (typeof storage.getDataDir === "function") {
        await removeOpenCodeCommandChangeJournals(storage.getDataDir(), environmentId);
      }
      context.nativeAgents?.forgetEnvironmentCommandCatalogues?.(environmentId);
      context.nativeAgents?.forgetEnvironmentProjections?.(environmentId);
      storage.deleteAutoPipelineDraftsByEnvironment(environmentId);
      await storage.deleteComposeDraftsByEnvironment(environmentId);
      await storage.deleteFileDraftsByEnvironment(environmentId);
      await storage.deleteAgentHandoffsByEnvironment(environmentId);
      // The environment's workflows were deleted above; their open result
      // slots would otherwise count against the active-entry limit forever.
      await context.deleteWorkflowResultsByEnvironment?.(environmentId);
      await context.design?.deleteEnvironment(environmentId);
      // Stops annotation writes for this environment, then removes its store.
      await context.webAnnotations?.deleteEnvironment(environmentId).catch((error: unknown) => {
        environmentLog.warn("delete.step-failed", {
          environmentId,
          step: "web-annotations",
          error: formatLogError(error, { message: false }),
        });
      });
      // Fences and removes the environment's artifact records, bytes and grants.
      await context.transcriptArtifacts
        ?.deleteEnvironment(environmentId)
        .catch((error: unknown) => {
          environmentLog.warn("delete.step-failed", {
            environmentId,
            step: "transcript-artifacts",
            error: formatLogError(error, { message: false }),
          });
        });
      // Saved copies of the images its transcripts showed.
      if (typeof storage.getDataDir === "function") {
        await transcriptMediaPins(storage.getDataDir())
          .deleteEnvironment(environmentId)
          .catch((error: unknown) => {
            environmentLog.warn("delete.step-failed", {
              environmentId,
              step: "transcript-media-pins",
              error: formatLogError(error, { message: false }),
            });
          });
      }
      // Tombstones its worktrees and records the purge of its change history and
      // evidence bodies, which the retention pass carries out in bounded batches.
      try {
        context.runtime.changeTracking?.environmentDeleted(environmentId);
      } catch (error) {
        environmentLog.warn("delete.step-failed", {
          environmentId,
          step: "change-tracking",
          error: formatLogError(error, { message: false }),
        });
      }
      // Schedules its agents own go with it; others' schedules aimed at it pause.
      try {
        context.scheduledJobs?.environmentDeleted(environmentId);
      } catch (error) {
        environmentLog.warn("delete.step-failed", {
          environmentId,
          step: "scheduled-jobs",
          error: formatLogError(error, { message: false }),
        });
      }
      // Its environment-scoped permission rules and their application record
      // go with it; project rules stay (todo 0723).
      try {
        if (typeof storage.permissionRuleStore === "function") {
          storage.permissionRuleStore().environmentDeleted(environmentId);
        }
      } catch (error) {
        environmentLog.warn("delete.step-failed", {
          environmentId,
          step: "permission-rules",
          error: formatLogError(error, { message: false }),
        });
      }
      context.agentTools?.revokeEnvironment(environmentId);
      await seedFs.rm(seedFilesDir(storage.getDataDir(), environmentId), {
        recursive: true,
        force: true,
      });
      // A project home's mailed images live outside the user's checkout and
      // go with the project home (docs/architecture/coordinator.md).
      await removeProjectHomeMailAttachments(storage.getDataDir(), environmentId);
      // A coordinator following this worker's pull request still hears the
      // merge Merge and Cleanup just recorded, once the record is gone.
      const last = await storage.getEnvironment(environmentId).catch(() => null);
      if (last)
        await context.coordinators?.statusWakes.captureFinalPullRequest(last).catch((error) => {
          environmentLog.warn("delete.step-failed", {
            environmentId,
            step: "final-pull-request",
            error: formatLogError(error),
          });
        });
      await storage.removeEnvironment(environmentId);
      // Bridges were stopped above, so nothing is writing bridge state now.
      if (cleanup) await runEnvironmentCleanupStep(cleanup, "state-dirs", context);
      await storage.deletePaneLayout(environmentId).catch(() => undefined);
      // A terminal start that began before the tombstone may have been awaiting
      // storage or filesystem I/O during the first sweep. Close anything that
      // became visible before deletion completed.
      context.runtime.terminals.cleanupSessionsForEnvironment(environmentId);
      await context.runtime.terminals.history.deleteHistories({
        dataDir: storage.getDataDir(),
        environmentId,
      });
      cleanupEnvironmentSetupState(context, environmentId);
      // Releases the watcher and discards the counts. This is the one case where
      // discarding is right: the worktree they described is gone.
      context.runtime.diffStats.invalidatePendingSync();
      context.runtime.diffStats.service.untrack(environmentId);
      // Reuse is admitted by a new tracking registration, never by a late read.
      // Keep failed ledger work fenced until the reconciler finishes it.
      if (
        cleanup?.worktreePath &&
        !(await environmentCleanupLedger(storage.getDataDir()).get(environmentId))
      ) {
        context.runtime.diffStats.service.completeRemoval({ worktreePath: cleanup.worktreePath });
      }
      // The PR belonged to a branch whose environment is gone; polling it would
      // resurrect state for an id no client can display.
      context.runtime.prMonitor.invalidatePendingSync();
      context.runtime.prMonitor.service.untrack(environmentId);
      if (environment?.worktreePath)
        context.runtime.diffStats.gitFetchScheduler.forget(environment.worktreePath);
      // Its clone is gone; a fetch still running for it can no longer stamp.
      if (environment?.containerId)
        context.runtime.diffStats.containerGitFetchPolicy.forgetContainer(environment.containerId);
    });
    // Other deletions may have left steps pending; a successful one is a cheap
    // moment to retry them without waiting for the next startup.
    scheduleEnvironmentCleanupReconcile(context);
  } catch (error) {
    const environment = await context.storage.getEnvironment(environmentId).catch(() => null);
    const message = cleanupErrorMessage(error);
    // A failed delete keeps its tombstone and its `deleting` marker, because a
    // restart recovers from them. The reason is what tells a client it stopped.
    if (environment?.cleanupAfterMergeRequestedAt || environment?.deletionRequestedAt) {
      await context.storage
        .updateEnvironment(environmentId, {
          ...(environment.cleanupAfterMergeRequestedAt ? { cleanupAfterMergeError: message } : {}),
          ...(environment.deletionRequestedAt ? { deletionError: message } : {}),
        })
        .catch(() => undefined);
    }
    throw error;
  }
}

export function deleteEnvironmentTask(
  environmentId: string,
  context: CommandContext,
  options: DeleteEnvironmentOptions = {},
): Promise<void> {
  // Every reason to refuse the delete is evaluated before the tombstone is
  // reserved. Reserving first would block local-server starts and merges for
  // the whole queue wait on behalf of a delete that was never going to run.
  const environments = context.runtime.environments;
  if (context.runtime.localServers.isShuttingDown()) {
    return Promise.reject(new Error("Backend is shutting down; environments cannot be deleted"));
  }
  if (environments.isMerging(environmentId) && !options.allowWhileMerging) {
    return Promise.reject(new Error(`Environment is currently being merged: ${environmentId}`));
  }
  // Reserve deletion before queueing. Local server starts consult this guard,
  // so work admitted after delete cannot recreate a process behind cleanup.
  if (!environments.beginDelete(environmentId)) {
    return Promise.reject(new Error(`Environment is already being deleted: ${environmentId}`));
  }
  environments.invalidateStartDedupe(environmentId);
  try {
    return enqueueEnvironmentLifecycleOperation(environmentId, context, () =>
      deleteEnvironment(environmentId, context, options),
    ).finally(() => {
      environments.endDelete(environmentId);
    });
  } catch (error) {
    environments.endDelete(environmentId);
    throw error;
  }
}
