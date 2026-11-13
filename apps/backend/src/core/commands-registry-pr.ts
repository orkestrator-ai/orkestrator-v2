import { projectHomePrTarget } from "./commands-pr-monitor.js";
import {
  isProjectHomeEnvironment,
  reconcileProjectHomeEnvironment,
} from "./project-home-environment.js";
import type {
  CommandRegistrar,
  DefinedCommandHandler,
  RegistryDependencies,
} from "./commands-registry-types.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type { AnyCommandDef } from "@orkestrator/protocol/contract/command";
import {
  armPrRefreshAfterAgentCompletionCommand,
  detectPrCommand,
  detectPrLocalCommand,
  disarmPrRefreshAfterAgentCompletionCommand,
  generateReviewPackageCommand,
  getPrMonitorStateCommand,
  mergeEnvironmentPrCommand,
  mergePrCommand,
  prMonitorAgentTurnCompletedCommand,
  prMonitorProbeEnvironmentCommand,
  prMonitorWatchCommand,
  setEnvironmentAutoMergeCommand,
  verifyReviewPackageCommand,
} from "@orkestrator/protocol/contract/domains/pull-requests";
import {
  isReviewPackageReference,
  parseReviewValidationPlan,
} from "@orkestrator/protocol/review-workflow";
import {
  isAgentBridgeKind,
  isStructuredCommandError,
} from "@orkestrator/protocol/bridge-readiness";
import { isPrMonitorMode } from "@orkestrator/protocol/pr-monitor";
import type { AwaitBridgeReadyResult } from "@orkestrator/protocol/bridge-readiness";
import type { PrMonitorSnapshot } from "@orkestrator/protocol/pr-monitor";
import type { PrMonitorSnapshotOutcome } from "@orkestrator/protocol/pr-monitor";
import {
  parseViewSnapshotRequest,
  resolveViewSnapshotOutcome,
} from "@orkestrator/protocol/view-sync";
import {
  LOCAL_SERVER_KINDS,
  environmentToPrMonitorTarget,
  asString,
  asRecord,
  assertOnlyKeys,
  asBoolean,
  asRequiredBoolean,
  asNumber,
  asStringArray,
  asNonBlankString,
  parseMergeMethod,
  parseReviewPackageId,
  parseReviewRound,
  parseReviewPreparationValidation,
  parseReviewPreparationFileNotes,
  verifyEnvironmentReviewPackage,
  generateReviewPackage,
  mergePullRequestInContainer,
  runStoredEnvironmentMerge,
  validatePrDetectionBranch,
  detectEnvironmentPullRequest,
  findEnvironmentByContainerId,
  deleteMergedEnvironmentRemoteBranch,
  asLocalServerKind,
  peekLocalAgentBridgeState,
  peekContainerAgentBridge,
  startLocalServer,
  stopLocalServer,
  deleteEnvironmentTask,
  getLocalServerStatus,
  cleanupErrorMessage,
  toClientEnvironment,
} from "./commands-helpers.js";
import type { MergeEnvironmentPrResult } from "./commands-helpers.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { classifyCommandFailure } from "@orkestrator/protocol/node/command-failure-reason";
import {
  awaitBridgeReadyCommand,
  cleanupStaleLocalServersCommand,
  getLocalClaudeServerStatusCommand,
  getLocalCodexServerStatusCommand,
  getLocalCursorServerStatusCommand,
  getLocalGrokServerStatusCommand,
  getLocalOpencodeServerStatusCommand,
  getLocalPiServerStatusCommand,
  peekContainerAgentBridgeCommand,
  peekLocalAgentBridgeCommand,
  startLocalClaudeServerCommand,
  startLocalCodexServerCommand,
  startLocalCursorServerCommand,
  startLocalGrokServerCommand,
  startLocalOpencodeServerCommand,
  startLocalPiServerCommand,
  stopLocalClaudeServerCommand,
  stopLocalCodexServerCommand,
  stopLocalCursorServerCommand,
  stopLocalGrokServerCommand,
  stopLocalOpencodeServerCommand,
  stopLocalPiServerCommand,
} from "@orkestrator/protocol/contract/domains/agent-servers";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import type { LocalServerKind } from "./local-server-runtime.js";

const log = createLogger("pull-request");

/** The local bridge commands of each agent (`agent-servers`, plan item 7009). */
const LOCAL_SERVER_COMMANDS = {
  opencode: {
    start: startLocalOpencodeServerCommand,
    stop: stopLocalOpencodeServerCommand,
    status: getLocalOpencodeServerStatusCommand,
  },
  claude: {
    start: startLocalClaudeServerCommand,
    stop: stopLocalClaudeServerCommand,
    status: getLocalClaudeServerStatusCommand,
  },
  codex: {
    start: startLocalCodexServerCommand,
    stop: stopLocalCodexServerCommand,
    status: getLocalCodexServerStatusCommand,
  },
  cursor: {
    start: startLocalCursorServerCommand,
    stop: stopLocalCursorServerCommand,
    status: getLocalCursorServerStatusCommand,
  },
  grok: {
    start: startLocalGrokServerCommand,
    stop: stopLocalGrokServerCommand,
    status: getLocalGrokServerStatusCommand,
  },
  pi: {
    start: startLocalPiServerCommand,
    stop: stopLocalPiServerCommand,
    status: getLocalPiServerStatusCommand,
  },
} as const satisfies Record<LocalServerKind, unknown>;

export function registerPullRequestCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { bridgeReadinessWaits, commands } = dependencies;
  // The environment PR commands are registered with their `pull-requests`
  // definitions (plan item 7006); every handler is `async`, so a refused
  // argument is still a rejection.
  const registerDefined = <C extends AnyCommandDef>(def: C, handler: DefinedCommandHandler<C>) =>
    register(def, handler, ASYNC_HANDLER);
  registerDefined(generateReviewPackageCommand, async (args, context) => {
    const { environmentId, packageId, round, targetBranch, preparation, additionalLimitations } =
      args;
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
    const trustedAdditionalLimitations = asStringArray(additionalLimitations);
    if (
      additionalLimitations !== undefined &&
      (!Array.isArray(additionalLimitations) ||
        trustedAdditionalLimitations.length !== additionalLimitations.length ||
        trustedAdditionalLimitations.some((limitation) => limitation.trim().length === 0))
    ) {
      throw new Error("Expected additionalLimitations to contain only non-empty strings");
    }
    return generateReviewPackage(
      asString(environmentId, "environmentId"),
      parsedPackageId,
      parseReviewRound(round),
      asString(targetBranch, "targetBranch"),
      parseReviewPreparationValidation(prepared.validation, parsedPackageId),
      parseReviewPreparationFileNotes(prepared.uncommittedFiles, "uncommittedFiles"),
      limitations,
      context,
      {
        additionalLimitations: trustedAdditionalLimitations,
        ...(args.validationPlan === undefined
          ? {}
          : { validationPlan: parseReviewValidationPlan(args.validationPlan) }),
        ...(args.expectedHead === undefined
          ? {}
          : { expectedHead: asString(args.expectedHead, "expectedHead") }),
      },
    );
  });
  registerDefined(verifyReviewPackageCommand, async (args, context) => {
    const { environmentId, reviewPackage } = args;
    if (!isReviewPackageReference(reviewPackage)) {
      throw new Error("Expected reviewPackage to be a valid review package reference");
    }
    return verifyEnvironmentReviewPackage(
      asString(environmentId, "environmentId"),
      reviewPackage,
      context,
    );
  });

  registerDefined(detectPrLocalCommand, async ({ environmentId, branch }, { storage, runtime }) => {
    let env = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!env) throw new Error(`Environment not found: ${environmentId}`);
    if (!env.worktreePath)
      throw new Error("Environment is not a local environment (no worktree path)");
    env = await reconcileProjectHomeEnvironment(env, storage);
    const target = await projectHomePrTarget(env, storage);
    if (!target.ready) return null;
    const detection = await detectEnvironmentPullRequest(
      {
        ...target,
        branch: env.projectHome ? env.branch : validatePrDetectionBranch(branch),
        prUrl: null,
        prState: null,
      },
      { storage, gitHubCli: runtime.gitHubCli },
    );
    if (!detection) return null;
    return {
      url: detection.url,
      state: detection.state,
      hasMergeConflicts: detection.hasMergeConflicts,
      checkSummary: detection.checkSummary,
    };
  });
  registerDefined(detectPrCommand, async ({ containerId, branch }) => {
    const resolvedContainerId = asString(containerId, "containerId");
    const detection = await detectEnvironmentPullRequest({
      environmentId: resolvedContainerId,
      branch: validatePrDetectionBranch(branch),
      kind: "container",
      containerId: resolvedContainerId,
      ready: true,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    });
    if (!detection) return null;
    return {
      url: detection.url,
      state: detection.state,
      hasMergeConflicts: detection.hasMergeConflicts,
      checkSummary: detection.checkSummary,
    };
  });
  registerDefined(mergePrCommand, async ({ containerId, method, deleteBranch }, context) => {
    const resolvedContainerId = asString(containerId, "containerId");
    const environment = findEnvironmentByContainerId(
      await context.storage.loadEnvironments(),
      resolvedContainerId,
    );
    if (!environment) {
      // No stored environment owns this container, so no branch is its own:
      // the merge keeps the head branch whatever `deleteBranch` says.
      const result = await mergePullRequestInContainer(
        resolvedContainerId,
        parseMergeMethod(method),
        null,
      );
      // Stored environments invalidate inside `runStoredEnvironmentMerge`.
      if (result.outcome !== "pending") {
        context.runtime.diffStats.containerGitFetchPolicy.invalidate(
          { containerId: resolvedContainerId },
          "mutation",
        );
      }
      return result;
    }
    return runStoredEnvironmentMerge(
      environment,
      parseMergeMethod(method),
      asBoolean(deleteBranch, true),
      context,
      async (result) => result,
    );
  });
  registerDefined(
    mergeEnvironmentPrCommand,
    async (
      {
        environmentId,
        method,
        deleteBranch,
        cleanupAfterMerge,
        expectedHeadSha,
        expectedPrUrl,
        autoMergeEnabledAt,
      },
      context,
    ): Promise<MergeEnvironmentPrResult> => {
      const id = asString(environmentId, "environmentId");
      if (
        expectedHeadSha !== undefined &&
        !/^[0-9a-f]{40}$/i.test(asString(expectedHeadSha, "expectedHeadSha"))
      ) {
        throw new Error("expectedHeadSha must be a full commit SHA");
      }
      const environment = await context.storage.getEnvironment(id);
      if (!environment) throw new Error(`Environment not found: ${id}`);

      const requestedCleanup = asBoolean(cleanupAfterMerge, false);
      const cleanupRequested =
        requestedCleanup || Boolean(environment.cleanupAfterMergeRequestedAt);
      if (
        expectedPrUrl !== undefined &&
        (environment.prUrl !== asString(expectedPrUrl, "expectedPrUrl") ||
          cleanupRequested !== requestedCleanup ||
          (isProjectHomeEnvironment(environment) && asBoolean(deleteBranch, true)))
      ) {
        throw new Error("The pull request or merge effects changed; confirm the merge again");
      }
      const automaticCleanup = autoMergeEnabledAt !== undefined;
      if (
        automaticCleanup &&
        (environment.autoMerge !== true ||
          environment.autoMergeEnabledAt !== autoMergeEnabledAt ||
          environment.autoMergeCleanup !== true)
      ) {
        throw new Error("Auto-merge options changed; retry with current options");
      }
      // Automatic intent remains revocable until confirmation; manual requests
      // retain their independent durable recovery timestamp.
      if (requestedCleanup && !automaticCleanup) {
        await context.storage.updateEnvironment(id, {
          cleanupAfterMergeRequestedAt: new Date().toISOString(),
          cleanupAfterMergeError: null,
        });
      }

      const armMergeReconciliation = async (): Promise<void> => {
        await context.runtime.prMonitor.sync(context);
        const latest = await context.storage.getEnvironment(id);
        if (latest) {
          context.runtime.prMonitor.service.requestMode(
            environmentToPrMonitorTarget(latest),
            "merge-pending",
          );
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
              log.warn("merged-state.persist-failed", {
                environmentId: id,
                ...classifyCommandFailure(error, { tools: ["gh"] }),
                error: formatLogError(error),
              });
            }

            if (!cleanupRequested) {
              await context.runtime.prMonitor.reconcileConfirmedMerge(environment, context);
              if (!mergedStatePersisted) {
                // Reconcile the service back to the still-open stored snapshot,
                // then immediately verify the exact PR URL so persistence can
                // be retried without another renderer action.
                await armMergeReconciliation().catch(() => undefined);
              }
              return { ...result, cleanupOutcome: "not-requested" };
            }

            if (!mergedStatePersisted) {
              await deleteMergedEnvironmentRemoteBranch(
                {
                  ...environment,
                  prState: "merged",
                },
                context.storage,
                context.runtime.gitHubCli,
              ).catch(() => undefined);
            }

            // Reconcile the linked task before deletion untracks the environment.
            // The monitor's task effects are idempotent, so a later authoritative
            // poll can safely finish a partial reconciliation.
            await context.runtime.prMonitor.reconcileConfirmedMerge(environment, context);

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
          expectedHeadSha as string | undefined,
          autoMergeEnabledAt as string | undefined,
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
  registerDefined(getPrMonitorStateCommand, async (args, context) => {
    await context.runtime.prMonitor.sync(context);
    // Without `knownGeneration`/`knownRevision` this keeps the legacy
    // `{ entries }` shape, now additively stamped. With them it answers the
    // compact conditional outcome from `view-sync.ts`. Both are captured
    // synchronously so the revision identifies exactly the returned state.
    const request = parseViewSnapshotRequest(args);
    const service = context.runtime.prMonitor.service;
    if (request.kind === "absent") {
      return service.revisionedSnapshot() satisfies PrMonitorSnapshot;
    }
    return resolveViewSnapshotOutcome(request, service.currentRevision(), () => ({
      entries: service.revisionedSnapshot().entries,
    })) satisfies PrMonitorSnapshotOutcome;
  });
  /**
   * A client pressed "Create PR" or "Merge": poll this environment faster until
   * the outcome is visible. Durable in the backend, so a renderer reload no
   * longer forgets that an answer is being waited for.
   */
  registerDefined(prMonitorWatchCommand, async ({ environmentId, mode }, context) => {
    const id = asString(environmentId, "environmentId");
    const requestedMode = asString(mode, "mode");
    if (!isPrMonitorMode(requestedMode)) {
      throw new Error("mode must be normal, create-pending, or merge-pending");
    }
    await context.runtime.prMonitor.sync(context);
    const environment = await context.storage.getEnvironment(id);
    if (!environment) throw new Error(`Environment not found: ${id}`);
    context.runtime.prMonitor.service.requestMode(
      environmentToPrMonitorTarget(environment),
      requestedMode,
    );
  });
  /**
   * Turns auto-merge on or off for an environment (`pr-auto-merge.ts`). The
   * flag is durable; turning it on also asks the monitor for a fresh reading
   * before acting, so a cached pre-request reading cannot authorize a merge.
   *
   * `cleanupAfterMerge` (the Merge PR dialog's "Auto-merge & Cleanup") also
   * deletes the environment once auto-merge has merged the PR. Every call
   * restates it, so turning auto-merge on again without it withdraws it.
   */
  registerDefined(setEnvironmentAutoMergeCommand, async (args, context) => {
    const id = asString(args.environmentId, "environmentId");
    const enabled = asRequiredBoolean(args.enabled, "enabled");
    const cleanupAfterMerge =
      args.cleanupAfterMerge === undefined
        ? false
        : asRequiredBoolean(args.cleanupAfterMerge, "cleanupAfterMerge");
    if (enabled && cleanupAfterMerge) {
      const environment = await context.storage.getEnvironment(id);
      if (!environment) throw new Error(`Environment not found: ${id}`);
      if (isProjectHomeEnvironment(environment)) {
        throw new Error("A project's home checkout cannot be deleted after merging");
      }
    }
    const current = await context.storage.getEnvironment(id);
    if (current?.lifecycleOperation === "merging" || context.runtime.environments?.isMerging(id)) {
      throw new Error("A merge is in progress; wait for its result before changing integration");
    }
    const updated = await context.storage.updateEnvironment(id, {
      autoMerge: enabled,
      autoMergeCleanup: enabled && cleanupAfterMerge,
    });
    if (enabled) {
      // Advisory: the durable flag stands even if the monitor cannot check now.
      await context.runtime.prMonitor.requestRefresh(id, context).catch((error) => {
        log.warn("refresh.failed", {
          environmentId: id,
          ...classifyCommandFailure(error, { tools: ["gh"] }),
          error: formatLogError(error),
        });
      });
      // Only the post-request monitor reading authorizes the first action.
    }
    if (!enabled) void context.prAutoMerge?.evaluate(id);
    return toClientEnvironment(updated);
  });
  /**
   * Durably arm the next completed agent turn to re-check a conflicting PR.
   * Kept backend-only: renderers continue to derive buttons solely from the
   * authoritative PR fields projected by environment snapshots/events.
   */
  registerDefined(armPrRefreshAfterAgentCompletionCommand, async (args, context) => {
    const id = asString(args.environmentId, "environmentId");
    const { armedAt } = await context.storage.armPrRecheckAfterAgentCompletion(id);
    if (armedAt) {
      // The durable token must still reach the caller if monitor hydration is
      // temporarily unavailable, otherwise a failed tab launch cannot roll it
      // back. Completion reconciliation retries hydration before requesting a
      // check.
      await context.runtime.prMonitor.sync(context).catch((error) => {
        log.warn("arm.track-failed", { environmentId: id, error: formatLogError(error) });
      });
    }
    return armedAt;
  });
  /** Rolls back a failed Resolve launch without consuming a newer request. */
  registerDefined(disarmPrRefreshAfterAgentCompletionCommand, async (args, context) => {
    await context.storage.disarmPrRecheckAfterAgentCompletion(
      asString(args.environmentId, "environmentId"),
      asString(args.armedAt, "armedAt"),
    );
  });
  /** Internal completion edge from native, tmux, or terminal supervision. */
  registerDefined(prMonitorAgentTurnCompletedCommand, async ({ environmentId }, context) => {
    const id = asString(environmentId, "environmentId");
    const environment = await context.storage.getEnvironment(id);
    if (!environment?.prRecheckAfterAgentCompletionArmedAt) return;
    const resolveCompleted =
      environment.autoMerge &&
      environment.autoMergeResolveRequestId &&
      (await context.storage.listNativeAgentSessions()).some(
        (session) =>
          session.environmentId === id &&
          session.turnOutcomes?.some(
            (outcome) => outcome.requestId === environment.autoMergeResolveRequestId,
          ),
      );
    if (resolveCompleted) {
      await context.storage.updateEnvironment(
        id,
        {
          autoMergeResolveCompletedAt: new Date().toISOString(),
        },
        (current) =>
          current.autoMergeResolveRequestId === environment.autoMergeResolveRequestId &&
          current.prRecheckAfterAgentCompletionArmedAt ===
            environment.prRecheckAfterAgentCompletionArmedAt,
      );
    }
    await context.runtime.prMonitor.requestRefresh(id, context, "completion");
  });
  /**
   * One-shot PR discovery for an environment whose agent just ended a turn.
   *
   * `PrMonitorRuntime.sync` only polls environments that already have a stored
   * PR or a pending mode, so an agent that runs `gh pr create` itself would
   * otherwise never be discovered — and giving every environment a standing
   * timer to catch that would cost a `gh` call per environment per interval
   * forever. Probing the working→idle edge instead costs one call per completed
   * turn, and a probe that finds nothing leaves no entry and emits nothing.
   *
   * Internal: driven by the backend's own agent-idle edge (see
   * `OrkestratorBackend`'s `onActivityTransition` wiring), never by a renderer.
   */
  registerDefined(prMonitorProbeEnvironmentCommand, async (args, context) => {
    await context.runtime.prMonitor.wakeForCompletion(
      asString(args.environmentId, "environmentId"),
      context,
    );
  });

  for (const [kind, local] of Object.entries(LOCAL_SERVER_COMMANDS) as [
    LocalServerKind,
    (typeof LOCAL_SERVER_COMMANDS)[LocalServerKind],
  ][]) {
    register(local.start, ({ environmentId }, context) =>
      startLocalServer(environmentId, context, kind),
    );
    register(local.stop, ({ environmentId }, context) =>
      stopLocalServer(environmentId, context, kind),
    );
    register(local.status, ({ environmentId }, context) =>
      getLocalServerStatus(environmentId, context, kind),
    );
  }
  // Retired (plan item 7009): a no-op since the Electron migration, counted
  // until it is removed.
  register(cleanupStaleLocalServersCommand, () => {
    compatibilityPathUsage.record("retired-command.cleanup-stale-local-servers");
  });

  register(awaitBridgeReadyCommand, (args, context) => {
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
                message: environment.setupApprovalRequired
                  ? (environment.lifecycleError ?? "Setup needs your approval")
                  : environment.setupPhase === "failed"
                    ? "Environment setup failed"
                    : "Environment is not running",
                retryable: environment.setupApprovalRequired === true,
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
                    message: refreshed.setupApprovalRequired
                      ? (refreshed.lifecycleError ?? "Setup needs your approval")
                      : "Environment setup failed",
                    retryable: refreshed.setupApprovalRequired === true,
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
  register(peekLocalAgentBridgeCommand, (args, context) => {
    return peekLocalAgentBridgeState(
      asNonBlankString(args.environmentId, "environmentId"),
      context,
      asLocalServerKind(args.agent, "agent"),
    ).then((state) => {
      // A live bridge that missed a probe is an unanswered read, not an absent
      // bridge: reporting it absent would have the sweep mark its turns idle.
      if (state.status === "unresponsive") {
        throw new Error("Local agent bridge is running but not answering health checks");
      }
      return state.status === "running" ? { port: state.port, authToken: state.authToken } : null;
    });
  });
  register(peekContainerAgentBridgeCommand, (args) => {
    return peekContainerAgentBridge(
      asNonBlankString(args.containerId, "containerId"),
      asLocalServerKind(args.agent, "agent"),
    );
  });
}
