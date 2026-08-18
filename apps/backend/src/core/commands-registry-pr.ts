import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  isAgentBridgeKind,
  isStructuredCommandError,
  isPrMonitorMode,
  runCommand,
} from "./commands-dependencies.js";
import type { AwaitBridgeReadyResult, PrMonitorSnapshot } from "./commands-dependencies.js";
import {
  LOCAL_SERVER_KINDS,
  withContainerRuntimeCredential,
  setPrMonitorRuntime,
  prMonitorService,
  environmentToPrMonitorTarget,
  syncPrMonitorTracking,
  reconcileConfirmedMerge,
  asString,
  asRecord,
  assertOnlyKeys,
  asBoolean,
  asNumber,
  asStringArray,
  asNonBlankString,
  quoteShell,
  parseMergeMethod,
  parseReviewPackageId,
  parseReviewRound,
  parseReviewPreparationValidation,
  parseReviewPreparationFileNotes,
  verifyEnvironmentPullRequest,
  generateLoopedReviewPackage,
  mergePullRequestInContainer,
  runStoredEnvironmentMerge,
  parsePrDetectionOutput,
  validatePrDetectionBranch,
  findEnvironmentByContainerId,
  deleteMergedEnvironmentRemoteBranch,
  dockerExec,
  asLocalServerKind,
  peekLocalAgentBridge,
  peekContainerAgentBridge,
  startLocalServer,
  stopLocalServer,
  deleteEnvironmentTask,
  getLocalServerStatus,
  conciseError,
  cleanupErrorMessage,
} from "./commands-helpers.js";
import type { MergeEnvironmentPrResult } from "./commands-helpers.js";

export function registerPullRequestCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { bridgeReadinessWaits, commands } = dependencies;
  register("verify_environment_pr", async ({ environmentId, prUrl, targetBranch }, context) =>
    verifyEnvironmentPullRequest(
      asString(environmentId, "environmentId"),
      asString(prUrl, "prUrl"),
      asString(targetBranch, "targetBranch"),
      context,
    ),
  );
  register(
    "generate_looped_review_package",
    async ({ environmentId, packageId, round, targetBranch, preparation }, context) => {
      const parsedPackageId = parseReviewPackageId(packageId);
      const prepared = asRecord(preparation, "preparation");
      assertOnlyKeys(prepared, ["validation", "uncommittedFiles", "limitations"], "preparation");
      const limitations = asStringArray(prepared.limitations);
      if (
        !Array.isArray(prepared.limitations) ||
        limitations.length !== prepared.limitations.length ||
        limitations.some((limitation) => limitation.trim().length === 0)
      ) {
        throw new Error("Expected preparation.limitations to contain only non-empty strings");
      }
      return generateLoopedReviewPackage(
        asString(environmentId, "environmentId"),
        parsedPackageId,
        parseReviewRound(round),
        asString(targetBranch, "targetBranch"),
        parseReviewPreparationValidation(prepared.validation, parsedPackageId),
        parseReviewPreparationFileNotes(prepared.uncommittedFiles, "uncommittedFiles"),
        limitations,
        context,
      );
    },
  );

  register("detect_pr_local", async ({ environmentId, branch }, { storage }) => {
    const env = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!env) throw new Error(`Environment not found: ${environmentId}`);
    if (!env.worktreePath)
      throw new Error("Environment is not a local environment (no worktree path)");
    const headBranch = validatePrDetectionBranch(branch);
    const { stdout } = await runCommand(
      "gh",
      [
        "pr",
        "list",
        "--head",
        headBranch,
        "--state",
        "all",
        "--limit",
        "30",
        "--json",
        "url,state,mergeable,updatedAt",
      ],
      { cwd: env.worktreePath, timeoutMs: 30_000 },
    );
    return parsePrDetectionOutput(stdout, headBranch);
  });
  register("detect_pr", async ({ containerId, branch }) => {
    const headBranch = validatePrDetectionBranch(branch);
    const output = await dockerExec(
      asString(containerId, "containerId"),
      withContainerRuntimeCredential(
        `gh pr list --head ${quoteShell(headBranch)} --state all --limit 30 --json url,state,mergeable,updatedAt`,
      ),
    );
    return parsePrDetectionOutput(output, headBranch);
  });
  register("merge_pr_local", async ({ environmentId, method, deleteBranch }, context) => {
    const id = asString(environmentId, "environmentId");
    const environment = await context.storage.getEnvironment(id);
    if (!environment?.worktreePath) throw new Error("Local environment worktree is not available");
    if (!environment.prUrl) throw new Error("Local environment PR URL is not available");
    return runStoredEnvironmentMerge(
      environment,
      parseMergeMethod(method),
      asBoolean(deleteBranch, true),
      context,
      async (result) => result,
    );
  });
  register("merge_pr", async ({ containerId, method, deleteBranch }, context) => {
    const resolvedContainerId = asString(containerId, "containerId");
    const environment = findEnvironmentByContainerId(
      await context.storage.loadEnvironments(),
      resolvedContainerId,
    );
    if (!environment) {
      return mergePullRequestInContainer(
        resolvedContainerId,
        parseMergeMethod(method),
        asBoolean(deleteBranch, true),
      );
    }
    return runStoredEnvironmentMerge(
      environment,
      parseMergeMethod(method),
      asBoolean(deleteBranch, true),
      context,
      async (result) => result,
    );
  });
  register(
    "merge_environment_pr",
    async (
      { environmentId, method, deleteBranch, cleanupAfterMerge },
      context,
    ): Promise<MergeEnvironmentPrResult> => {
      const id = asString(environmentId, "environmentId");
      const environment = await context.storage.getEnvironment(id);
      if (!environment) throw new Error(`Environment not found: ${id}`);

      const requestedCleanup = asBoolean(cleanupAfterMerge, false);
      const cleanupRequested =
        requestedCleanup || Boolean(environment.cleanupAfterMergeRequestedAt);
      if (requestedCleanup) {
        await context.storage.updateEnvironment(id, {
          cleanupAfterMergeRequestedAt: new Date().toISOString(),
          cleanupAfterMergeError: null,
        });
      }

      const armMergeReconciliation = async (): Promise<void> => {
        await syncPrMonitorTracking(context);
        const latest = await context.storage.getEnvironment(id);
        if (latest) {
          prMonitorService.requestMode(environmentToPrMonitorTarget(latest), "merge-pending");
        }
      };

      try {
        return await runStoredEnvironmentMerge(
          environment,
          parseMergeMethod(method),
          cleanupRequested ? false : asBoolean(deleteBranch, true),
          context,
          async (result): Promise<MergeEnvironmentPrResult> => {
            if (result.outcome !== "merged") {
              await armMergeReconciliation();
              return {
                ...result,
                cleanupOutcome: cleanupRequested ? "pending" : "not-requested",
              };
            }

            let mergedStatePersisted = true;
            try {
              await context.storage.updateEnvironment(id, {
                prState: "merged",
                hasMergeConflicts: false,
              });
            } catch (error) {
              mergedStatePersisted = false;
              // GitHub is already authoritative. A storage outage must not strand
              // a cleanup the user explicitly requested.
              console.warn(
                `[backend] Failed to persist merged PR state for ${id}:`,
                conciseError(error),
              );
            }

            if (!cleanupRequested) {
              await reconcileConfirmedMerge(environment, context);
              if (!mergedStatePersisted) {
                // Reconcile the service back to the still-open stored snapshot,
                // then immediately verify the exact PR URL so persistence can
                // be retried without another renderer action.
                await armMergeReconciliation().catch(() => undefined);
              }
              return { ...result, cleanupOutcome: "not-requested" };
            }

            if (!mergedStatePersisted) {
              await deleteMergedEnvironmentRemoteBranch({
                ...environment,
                prState: "merged",
              }).catch(() => undefined);
            }

            // Reconcile the linked task before deletion untracks the environment.
            // The monitor's task effects are idempotent, so a later authoritative
            // poll can safely finish a partial reconciliation.
            await reconcileConfirmedMerge(environment, context);

            try {
              await deleteEnvironmentTask(id, context, { allowWhileMerging: true });
              return { ...result, cleanupOutcome: "completed" };
            } catch (error) {
              const cleanupError = cleanupErrorMessage(error);
              await context.storage
                .updateEnvironment(id, {
                  cleanupAfterMergeError: cleanupError,
                })
                .catch(() => undefined);
              return {
                ...result,
                cleanupOutcome: "failed",
                cleanupError,
              };
            }
          },
        );
      } catch (error) {
        if (cleanupRequested) {
          await armMergeReconciliation().catch(() => undefined);
        }
        throw error;
      }
    },
  );

  /**
   * Authoritative PR-monitor snapshot.
   *
   * A client that mounts, remounts, or reconnects reads this rather than trying
   * to reconstruct state from the events it happened to be listening for. It
   * also arms tracking, so the first client to ask starts the polling even if
   * no lifecycle command has run since the backend started.
   */
  register("get_pr_monitor_state", async (_args, context) => {
    await syncPrMonitorTracking(context);
    return { entries: prMonitorService.snapshot() } satisfies PrMonitorSnapshot;
  });
  /**
   * A client pressed "Create PR" or "Merge": poll this environment faster until
   * the outcome is visible. Durable in the backend, so a renderer reload no
   * longer forgets that an answer is being waited for.
   */
  register("pr_monitor_watch", async ({ environmentId, mode }, context) => {
    const id = asString(environmentId, "environmentId");
    const requestedMode = asString(mode, "mode");
    if (!isPrMonitorMode(requestedMode)) {
      throw new Error("mode must be normal, create-pending, or merge-pending");
    }
    await syncPrMonitorTracking(context);
    const environment = await context.storage.getEnvironment(id);
    if (!environment) throw new Error(`Environment not found: ${id}`);
    prMonitorService.requestMode(environmentToPrMonitorTarget(environment), requestedMode);
  });
  /** Requests an immediate check for an environment already being monitored. */
  register("pr_monitor_refresh", async ({ environmentId }, context) => {
    await syncPrMonitorTracking(context);
    prMonitorService.requestCheck(asString(environmentId, "environmentId"));
  });
  /**
   * Durably arm the next completed agent turn to re-check a conflicting PR.
   * Kept backend-only: renderers continue to derive buttons solely from the
   * authoritative PR fields projected by environment snapshots/events.
   */
  register("arm_pr_refresh_after_agent_completion", async (args, context) => {
    assertOnlyKeys(args, ["environmentId"], "arguments");
    const id = asString(args.environmentId, "environmentId");
    const { armedAt } = await context.storage.armPrRecheckAfterAgentCompletion(id);
    if (armedAt) {
      // The durable token must still reach the caller if monitor hydration is
      // temporarily unavailable, otherwise a failed tab launch cannot roll it
      // back. Completion reconciliation retries hydration before requesting a
      // check.
      await syncPrMonitorTracking(context).catch((error) => {
        console.warn(
          `[pr-monitor] Failed to track armed environment ${id}:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
    return armedAt;
  });
  /** Rolls back a failed Resolve launch without consuming a newer request. */
  register("disarm_pr_refresh_after_agent_completion", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "armedAt"], "arguments");
    await context.storage.disarmPrRecheckAfterAgentCompletion(
      asString(args.environmentId, "environmentId"),
      asString(args.armedAt, "armedAt"),
    );
  });
  /** Internal completion edge from native, tmux, or terminal supervision. */
  register("pr_monitor_agent_turn_completed", async ({ environmentId }, context) => {
    const id = asString(environmentId, "environmentId");
    const environment = await context.storage.getEnvironment(id);
    if (!environment?.prRecheckAfterAgentCompletionArmedAt) return;
    await syncPrMonitorTracking(context);
    prMonitorService.requestCheck(id);
  });
  /**
   * One-shot PR discovery for an environment whose agent just ended a turn.
   *
   * `syncPrMonitorTracking` only polls environments that already have a stored
   * PR or a pending mode, so an agent that runs `gh pr create` itself would
   * otherwise never be discovered — and giving every environment a standing
   * timer to catch that would cost a `gh` call per environment per interval
   * forever. Probing the working→idle edge instead costs one call per completed
   * turn, and a probe that finds nothing leaves no entry and emits nothing.
   *
   * Internal: driven by the backend's own agent-idle edge (see
   * `OrkestratorBackend`'s `onActivityTransition` wiring), never by a renderer.
   */
  register("pr_monitor_probe_environment", async (args, context) => {
    assertOnlyKeys(args, ["environmentId"], "arguments");
    const id = asString(args.environmentId, "environmentId");
    setPrMonitorRuntime(context);
    const environment = await context.storage.getEnvironment(id);
    if (!environment) return;
    prMonitorService.probe(environmentToPrMonitorTarget(environment));
  });

  register("start_local_opencode_server_cmd", ({ environmentId }, context) =>
    startLocalServer(asString(environmentId, "environmentId"), context, "opencode"),
  );
  register("stop_local_opencode_server_cmd", ({ environmentId }, context) =>
    stopLocalServer(asString(environmentId, "environmentId"), context, "opencode"),
  );
  register("get_local_opencode_server_status", ({ environmentId }, context) =>
    getLocalServerStatus(asString(environmentId, "environmentId"), context, "opencode"),
  );
  register("start_local_claude_server_cmd", ({ environmentId }, context) =>
    startLocalServer(asString(environmentId, "environmentId"), context, "claude"),
  );
  register("stop_local_claude_server_cmd", ({ environmentId }, context) =>
    stopLocalServer(asString(environmentId, "environmentId"), context, "claude"),
  );
  register("get_local_claude_server_status", ({ environmentId }, context) =>
    getLocalServerStatus(asString(environmentId, "environmentId"), context, "claude"),
  );
  register("start_local_codex_server_cmd", ({ environmentId }, context) =>
    startLocalServer(asString(environmentId, "environmentId"), context, "codex"),
  );
  register("stop_local_codex_server_cmd", ({ environmentId }, context) =>
    stopLocalServer(asString(environmentId, "environmentId"), context, "codex"),
  );
  register("get_local_codex_server_status", ({ environmentId }, context) =>
    getLocalServerStatus(asString(environmentId, "environmentId"), context, "codex"),
  );
  register("start_local_cursor_server_cmd", ({ environmentId }, context) =>
    startLocalServer(asString(environmentId, "environmentId"), context, "cursor"),
  );
  register("stop_local_cursor_server_cmd", ({ environmentId }, context) =>
    stopLocalServer(asString(environmentId, "environmentId"), context, "cursor"),
  );
  register("get_local_cursor_server_status", ({ environmentId }, context) =>
    getLocalServerStatus(asString(environmentId, "environmentId"), context, "cursor"),
  );
  register("start_local_grok_server_cmd", ({ environmentId }, context) =>
    startLocalServer(asString(environmentId, "environmentId"), context, "grok"),
  );
  register("stop_local_grok_server_cmd", ({ environmentId }, context) =>
    stopLocalServer(asString(environmentId, "environmentId"), context, "grok"),
  );
  register("get_local_grok_server_status", ({ environmentId }, context) =>
    getLocalServerStatus(asString(environmentId, "environmentId"), context, "grok"),
  );
  register("cleanup_stale_local_servers_cmd", () => undefined);

  register("await_bridge_ready", (args, context) => {
    assertOnlyKeys(args, ["environmentId", "agent", "timeoutMs"], "arguments");
    const environmentId = asNonBlankString(args.environmentId, "environmentId");
    if (!isAgentBridgeKind(args.agent)) {
      throw new Error(`agent must be one of: ${LOCAL_SERVER_KINDS.join(", ")}`);
    }
    const agent = args.agent;
    const timeoutMs = asNumber(args.timeoutMs, "timeoutMs");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new Error("timeoutMs must be an integer between 1000 and 120000");
    }
    const key = `${environmentId}:${agent}`;
    const callerDeadline = Date.now() + timeoutMs;
    let shared = bridgeReadinessWaits.get(key);
    if (shared) {
      // A late coalesced caller must receive its complete requested wait time,
      // even when the existing probe is close to its original deadline.
      shared.deadline = Math.max(shared.deadline, callerDeadline);
    } else {
      const created = {
        deadline: callerDeadline,
        promise: undefined as unknown as Promise<AwaitBridgeReadyResult>,
      };
      // Publish the mutable deadline before starting the async probe so every
      // caller that joins while storage is loading can extend it.
      bridgeReadinessWaits.set(key, created);
      created.promise = Promise.resolve()
        .then(async (): Promise<AwaitBridgeReadyResult> => {
          const initial = await context.storage.getEnvironment(environmentId);
          if (!initial) {
            return {
              status: "failed",
              error: { message: "Environment not found", retryable: false },
            };
          }

          let environment = initial;
          while (
            environment.status === "creating" ||
            environment.setupPhase === "pending" ||
            environment.setupPhase === "running"
          ) {
            const retryAfterMs = Math.min(500, Math.max(0, created.deadline - Date.now()));
            if (retryAfterMs <= 0) {
              return {
                status: "timed-out",
                error: {
                  message: `${agent} bridge did not become ready before the environment startup deadline`,
                  retryable: true,
                  retryAfterMs: 1_000,
                },
              };
            }
            await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
            const refreshed = await context.storage.getEnvironment(environmentId);
            if (!refreshed) {
              return {
                status: "failed",
                error: { message: "Environment was deleted", retryable: false },
              };
            }
            environment = refreshed;
          }

          if (environment.status !== "running" || environment.setupPhase === "failed") {
            return {
              status: "failed",
              error: {
                message:
                  environment.setupPhase === "failed"
                    ? "Environment setup failed"
                    : "Environment is not running",
                retryable: false,
              },
            };
          }

          while (true) {
            try {
              const result =
                environment.environmentType === "local"
                  ? ((await commands.get(`start_local_${agent}_server_cmd`)?.(
                      { environmentId },
                      context,
                    )) as { port?: number; hostPort?: number; authToken?: string } | undefined)
                  : ((await commands.get(`start_${agent}_server`)?.(
                      { containerId: environment.containerId },
                      context,
                    )) as { port?: number; hostPort?: number; authToken?: string } | undefined);
              const port =
                environment.environmentType === "local" ? result?.port : result?.hostPort;
              if (!port || !result?.authToken) {
                return {
                  status: "failed",
                  error: {
                    message: `${agent} bridge returned an incomplete ready endpoint`,
                    retryable: false,
                  },
                };
              }
              return { status: "ready", port, authToken: result.authToken };
            } catch (error) {
              if (!isStructuredCommandError(error) || !error.retryable) {
                return {
                  status: "failed",
                  error: {
                    message: error instanceof Error ? error.message : String(error),
                    retryable: false,
                  },
                };
              }
              const remainingMs = created.deadline - Date.now();
              if (remainingMs <= 0) {
                return {
                  status: "timed-out",
                  error: {
                    message: `${agent} bridge did not become ready before the environment startup deadline`,
                    retryable: true,
                    retryAfterMs: error.retryAfterMs ?? 1_000,
                  },
                };
              }
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(error.retryAfterMs ?? 500, remainingMs)),
              );
              const refreshed = await context.storage.getEnvironment(environmentId);
              if (!refreshed) {
                return {
                  status: "failed",
                  error: { message: "Environment was deleted", retryable: false },
                };
              }
              if (refreshed.setupPhase === "failed") {
                return {
                  status: "failed",
                  error: {
                    message: "Environment setup failed",
                    retryable: false,
                  },
                };
              }
              if (
                refreshed.status === "creating" ||
                refreshed.setupPhase === "pending" ||
                refreshed.setupPhase === "running"
              ) {
                environment = refreshed;
                continue;
              }
              if (refreshed.status !== "running") {
                return {
                  status: "failed",
                  error: { message: "Environment is not running", retryable: false },
                };
              }
              environment = refreshed;
            }
          }
        })
        .finally(() => {
          if (bridgeReadinessWaits.get(key) === created) bridgeReadinessWaits.delete(key);
        });
      shared = created;
    }
    const wait = shared.promise;
    const callerTimedOut = (): AwaitBridgeReadyResult => ({
      status: "timed-out",
      error: {
        message: `${agent} bridge did not become ready before the caller deadline`,
        retryable: true,
        retryAfterMs: 1_000,
      },
    });

    return new Promise<AwaitBridgeReadyResult>((resolve, reject) => {
      let settled = false;
      const finish = (result: AwaitBridgeReadyResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The shared probe and its longest-lived caller expire at the same
        // absolute deadline. If the probe continuation wins that timer race,
        // keep its internal startup-window result from changing the caller's
        // public timeout contract.
        resolve(result.status === "timed-out" ? callerTimedOut() : result);
      };
      const timer = setTimeout(() => finish(callerTimedOut()), timeoutMs);
      timer.unref?.();
      void wait.then(finish, (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  });

  // Backend-internal observation surface. Never starts a bridge, so a
  // background reconciler can read activity without spawning one process per
  // environment or keeping every bridge alive on a poll.
  register("peek_local_agent_bridge", (args, context) => {
    assertOnlyKeys(args, ["environmentId", "agent"], "arguments");
    return peekLocalAgentBridge(
      asNonBlankString(args.environmentId, "environmentId"),
      context,
      asLocalServerKind(args.agent, "agent"),
    );
  });
  register("peek_container_agent_bridge", (args) => {
    assertOnlyKeys(args, ["containerId", "agent"], "arguments");
    return peekContainerAgentBridge(
      asNonBlankString(args.containerId, "containerId"),
      asLocalServerKind(args.agent, "agent"),
    );
  });
}
