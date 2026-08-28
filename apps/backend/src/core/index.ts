import {
  closeLocalServerAdmission,
  createCommandRegistry,
  shutdownDiffStatsTracking,
  shutdownLocalServers,
  shutdownPrMonitorTracking,
  type BackendEmit,
  type CommandContext,
} from "./commands.js";
import { reapOrphanedClaudeTmuxRuntimes, reapOrphanedLocalServers } from "./local-server-reaper.js";
import { claudeTmuxRuntimeRootPrefix } from "./tmux.js";
import { StorageService } from "./storage.js";
import { AgentToolsServer } from "./agent-tools.js";
import {
  ControlMcpServer,
  type ControlMcpInfo,
  type ControlMcpSettings,
} from "./control-mcp-server.js";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { FRONTEND_AGENT_ACTIVITY_LEASE_MS } from "@orkestrator/protocol/agent-activity";
import { BuildPipelineService } from "./build-pipeline-service.js";
import { isAgentTurnEndTransition, NativeAgentService } from "./native-agent-service.js";
import { LoopedReviewService } from "./looped-review-service.js";
import { dispatchMultiReviewAddressPrompt } from "./multi-review-address-dispatch.js";
import { MultiReviewService } from "./multi-review-service.js";
import { FeaturePlanningService } from "./feature-planning.js";
import { PromptQueueDrainer } from "./prompt-queue-drainer.js";
import {
  ENVIRONMENT_LIFECYCLE_DRAIN_TIMEOUT_MS,
  EnvironmentLifecycleTaskTracker,
  reconcileInterruptedEnvironmentLifecycleTasks,
} from "./environment-lifecycle-tasks.js";

export class OrkestratorBackend {
  private readonly commands = createCommandRegistry();
  private readonly context: CommandContext;
  private readonly buildPipelines: BuildPipelineService;
  private readonly nativeAgents: NativeAgentService;
  private readonly loopedReviews: LoopedReviewService;
  private readonly multiReviews: MultiReviewService;
  private readonly featurePlanning: FeaturePlanningService;
  private readonly promptQueues: PromptQueueDrainer;
  private readonly environmentLifecycleTasks: EnvironmentLifecycleTaskTracker;
  private readonly environmentLifecycleDrainTimeoutMs: number;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private activityLeaseSweep: ReturnType<typeof setInterval> | null = null;
  private nativeActivitySweep: ReturnType<typeof setInterval> | null = null;
  private tabResourceSweep: ReturnType<typeof setInterval> | null = null;
  private setupStartupReconciled = false;
  private readonly reapPidServers: typeof reapOrphanedLocalServers;
  private readonly reapTmuxRuntimes: typeof reapOrphanedClaudeTmuxRuntimes;
  private readonly agentTools: Pick<
    AgentToolsServer,
    "connection" | "revokeEnvironment" | "start" | "stop"
  >;
  private readonly controlMcp: Pick<
    ControlMcpServer,
    "getInfo" | "getSettings" | "rotateToken" | "start" | "stop"
  >;

  constructor(options: {
    dataDir: string;
    toolchainBinDir: string;
    appRoot: string;
    resourceRoot: string;
    runtimeFlavor?: "production" | "development" | "agent-test";
    worktreeDir?: string;
    dockerImage?: string;
    strictDockerOwner?: boolean;
    credentialSources?: import("@orkestrator/protocol/agent-platforms").AgentPlatform[];
    emit: BackendEmit;
    startupReapers?: {
      localServers?: typeof reapOrphanedLocalServers;
      claudeTmuxRuntimes?: typeof reapOrphanedClaudeTmuxRuntimes;
    };
    agentTools?: Pick<AgentToolsServer, "connection" | "revokeEnvironment" | "start" | "stop">;
    controlMcp?: Pick<
      ControlMcpServer,
      "getInfo" | "getSettings" | "rotateToken" | "start" | "stop"
    >;
    environmentLifecycleTasks?: EnvironmentLifecycleTaskTracker;
    environmentLifecycleDrainTimeoutMs?: number;
  }) {
    const storage = new StorageService(options.dataDir);
    this.agentTools = options.agentTools ?? new AgentToolsServer(storage);
    this.controlMcp =
      options.controlMcp ??
      new ControlMcpServer(options.dataDir, (command, args) => this.invoke(command, args), {
        // Fixed in the application, ephemeral in the test runner so concurrently
        // executing backend fixtures cannot contend for the user-facing port.
        port: process.env.NODE_ENV === "test" ? 0 : undefined,
      });
    this.environmentLifecycleTasks =
      options.environmentLifecycleTasks ?? new EnvironmentLifecycleTaskTracker();
    this.environmentLifecycleDrainTimeoutMs =
      options.environmentLifecycleDrainTimeoutMs ?? ENVIRONMENT_LIFECYCLE_DRAIN_TIMEOUT_MS;
    // Every committed mutation fans out to all connected clients, so a second
    // window or browser converges without polling. `emit` is read lazily by the
    // caller's closure, which is how this survives the gateway not existing yet.
    storage.setResourceChangeListener((change) => {
      options.emit(RESOURCE_CHANGED_EVENT, change);
    });
    const context = {
      storage,
      toolchainBinDir: options.toolchainBinDir,
      appRoot: options.appRoot,
      resourceRoot: options.resourceRoot,
      runtimeFlavor: options.runtimeFlavor ?? "production",
      worktreeDir: options.worktreeDir,
      dockerImage: options.dockerImage,
      strictDockerOwner: options.strictDockerOwner ?? false,
      credentialSources: new Set(options.credentialSources ?? []),
      emit: options.emit,
      agentTools: this.agentTools,
      controlMcp: this.controlMcp,
      environmentLifecycleTasks: this.environmentLifecycleTasks,
    } as CommandContext;
    context.notifyAgentTurnCompleted = async (environmentId: string) => {
      const handler = this.commands.get("pr_monitor_agent_turn_completed");
      if (!handler) return;
      await handler({ environmentId }, context);
    };
    context.probeAgentCreatedPullRequest = async (environmentId: string) => {
      const handler = this.commands.get("pr_monitor_probe_environment");
      if (!handler) return;
      await handler({ environmentId }, context);
    };
    this.context = context;
    const interactionMonitorMode =
      process.env.ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY === "1"
        ? ("observe-only" as const)
        : ("disabled" as const);
    this.nativeAgents = new NativeAgentService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
      {
        interactionMonitorMode,
        interactionMonitorAdoptionEnabled:
          process.env.ORKESTRATOR_AGENT_INTERACTION_MONITOR_KILL_SWITCH !== "1",
        onActivityTransition: (event) => {
          options.emit("native-agent-session-activity", {
            environment_id: event.environmentId,
            previous_state: event.previousState,
            state: event.state,
          });
          // An agent that just ended a turn may have run `gh pr create` itself,
          // and an environment with no stored PR carries no polling timer that
          // would ever notice. Probe once here rather than standing one up.
          //
          // This deliberately hangs off the *transition*, not the observation:
          // the activity sweep reports idle every two seconds, so probing every
          // idle reading would be a `gh` call per idle environment per sweep.
          // A first observation (`previousState === undefined`) is a backend
          // restart or a newly adopted session, not a turn that ended here.
          if (isAgentTurnEndTransition(event)) {
            this.probeForAgentCreatedPullRequest(event.environmentId, context);
          }
        },
      },
    );
    context.nativeAgents = this.nativeAgents;
    this.buildPipelines = new BuildPipelineService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
      {
        onInteractionObservation: (event) => {
          this.nativeAgents.recordProviderInteractionObservation(event);
        },
      },
    );
    context.buildPipelines = this.buildPipelines;
    this.loopedReviews = new LoopedReviewService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
      {
        onInteractionObservation: (event) => {
          this.nativeAgents.recordProviderInteractionObservation(event);
        },
      },
    );
    context.loopedReviews = this.loopedReviews;
    this.multiReviews = new MultiReviewService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
      {
        dispatchAddressPrompt: (workflow) =>
          dispatchMultiReviewAddressPrompt(this.nativeAgents, workflow),
      },
    );
    context.multiReviews = this.multiReviews;
    this.featurePlanning = new FeaturePlanningService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
    );
    context.featurePlanning = this.featurePlanning;
    // Native agent queues are drained by NativeAgentService; this covers the
    // claude-tmux queues, whose dispatch types into a pane rather than calling
    // a bridge and so had no server-side drainer at all.
    this.promptQueues = new PromptQueueDrainer(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
    );
    this.reapPidServers = options.startupReapers?.localServers ?? reapOrphanedLocalServers;
    this.reapTmuxRuntimes =
      options.startupReapers?.claudeTmuxRuntimes ?? reapOrphanedClaudeTmuxRuntimes;
  }

  /**
   * Fire-and-forget one-shot PR discovery after an agent turn ended.
   *
   * Deliberately not awaited: the activity sweep that produced this edge must
   * not slow down, or fail, because GitHub is slow. The probe itself is
   * idempotent — an environment already being monitored just gets its next
   * check brought forward.
   */
  private probeForAgentCreatedPullRequest(environmentId: string, context: CommandContext): void {
    void Promise.resolve(context.probeAgentCreatedPullRequest?.(environmentId)).catch(
      (error: unknown) => {
        console.warn(
          `[backend] Failed to probe for an agent-created PR in ${environmentId}:`,
          error instanceof Error ? error.message : error,
        );
      },
    );
  }

  async init(): Promise<void> {
    await this.context.storage.init();
    // Do not accept commands while durable state claims work is still running
    // from a previous process. If this write fails, startup fails closed rather
    // than exposing progress that this backend can never complete.
    const lifecycleRecovery = await reconcileInterruptedEnvironmentLifecycleTasks(
      this.context.storage,
    );
    await this.agentTools.start();
    // No renderer can be alive yet, so every persisted `frontend` activity
    // snapshot belongs to a process that is gone. They cannot be retracted
    // later — the aggregate is a max — so a renderer that quit mid-turn would
    // otherwise leave its environment showing "working" forever.
    await this.context.storage.clearFrontendAgentActivity().catch((error) => {
      console.warn("[backend] Failed to clear stale agent activity:", error);
    });
    this.activityLeaseSweep ??= setInterval(() => {
      void this.context.storage.expireFrontendAgentActivityLeases().catch((error) => {
        console.warn("[backend] Failed to expire agent activity leases:", error);
      });
    }, FRONTEND_AGENT_ACTIVITY_LEASE_MS / 2);
    this.activityLeaseSweep.unref?.();
    // Before the gateway can accept a start command: bridges left behind by a
    // backend that died without draining must be reaped first, or the codex
    // pidfile they still hold blocks this instance's app-server ownership.
    await this.reapPidServers({ storage: this.context.storage }).catch((error) => {
      console.warn("[backend] Failed to reap orphaned local servers:", error);
    });
    // claude-tmux leaves no PID behind — its sessions belong to a tmux server
    // we do not own — so its orphans are found by their runtime roots instead.
    await this.reapTmuxRuntimes({
      storage: this.context.storage,
      runtimeRootPrefix: claudeTmuxRuntimeRootPrefix(this.context.storage.getDataDir()),
    }).catch((error) => {
      console.warn("[backend] Failed to reap orphaned claude-tmux runtimes:", error);
    });
    // The durable deletion tombstone stays in place across a crash so queues,
    // pipelines, and starts remain blocked. Once orphaned processes have been
    // reaped, re-admit the ordinary idempotent delete path; it owns every child
    // cleanup and removes the tombstone only by removing the environment.
    const deleteEnvironment = this.commands.get("delete_environment");
    if (!deleteEnvironment && lifecycleRecovery.deletionRecoveryEnvironmentIds.length > 0) {
      throw new Error("Delete command is unavailable during lifecycle recovery");
    }
    for (const environmentId of lifecycleRecovery.deletionRecoveryEnvironmentIds) {
      const recovery = Promise.resolve(deleteEnvironment?.({ environmentId }, this.context));
      void recovery.catch(() => {
        // Detailed subprocess failures are logged at their owning boundary.
        // Keep this coordination log free of paths, command output, or secrets.
        console.warn(`[backend] Interrupted deletion remains pending for ${environmentId}`);
      });
    }
    const reconcileTabTeardowns = this.commands.get("reconcile_tab_teardowns");
    if (reconcileTabTeardowns) {
      await Promise.resolve(reconcileTabTeardowns({}, this.context)).catch((error: unknown) => {
        console.warn("[backend] Failed to reconcile tab teardowns:", error);
      });
    }

    // Start durable pipelines only after stale bridge ownership and interrupted
    // environment deletion have been reconciled. A doomed pipeline is skipped
    // without preventing the gateway from becoming available.
    await this.buildPipelines.init().catch((error) => {
      console.warn("[backend] Failed to restore build pipelines:", error);
    });
    await this.loopedReviews.init().catch((error) => {
      console.warn("[backend] Failed to restore looped reviews:", error);
    });
    await this.multiReviews.init().catch((error) => {
      console.warn("[backend] Failed to restore multi reviews:", error);
    });
    const reconcilePendingEnvironmentRenames = this.commands.get(
      "reconcile_pending_environment_renames",
    );
    if (reconcilePendingEnvironmentRenames) {
      // Naming intent is durable backend work. Complete startup reconciliation
      // before native launch recovery, even when no renderer has mounted the
      // environment. First-prompt preparation itself only schedules this work:
      // it may be called while environment start already owns the lifecycle queue.
      await Promise.resolve(reconcilePendingEnvironmentRenames({}, this.context)).catch(
        (error: unknown) => {
          console.warn("[backend] Failed to reconcile pending environment renames:", error);
        },
      );
    }
    await this.nativeAgents.init().catch((error) => {
      console.warn("[backend] Failed to restore native agent launches:", error);
    });
    const reconcileOrphanedTabResources = this.commands.get("reconcile_orphaned_tab_resources");
    if (reconcileOrphanedTabResources) {
      await Promise.resolve(reconcileOrphanedTabResources({}, this.context)).catch(
        (error: unknown) => {
          console.warn("[backend] Failed to reconcile orphaned tab resources:", error);
        },
      );
    }
    if (!this.setupStartupReconciled) {
      const environments = await this.context.storage.loadEnvironments();
      // Mark before starting any pending setup. If init is retried on this same
      // backend instance, a live setup task must not be mistaken for work left
      // by a dead process or admitted a second time.
      this.setupStartupReconciled = true;
      const ensureEnvironmentSetup = this.commands.get("ensure_environment_setup");
      for (const environment of environments) {
        if (
          environment.status !== "running" ||
          environment.setupScriptsComplete ||
          environment.setupOverride
        )
          continue;
        if (environment.setupPhase === "running") {
          // A persisted `running` phase belongs to the process that owned its
          // PTY. Repository-controlled setup may not be idempotent, so fence
          // that interrupted attempt and require an explicit retry or override.
          await this.context.storage
            .updateEnvironment(environment.id, {
              setupPhase: "failed",
              setupCompletedAt: new Date().toISOString(),
              lifecycleError: "Environment setup was interrupted. Retry setup to continue.",
            })
            .catch((error: unknown) => {
              console.warn(
                `[backend] Failed to fence interrupted setup for ${environment.id}:`,
                error,
              );
            });
          continue;
        }
        if (environment.setupPhase !== "pending" || !ensureEnvironmentSetup) continue;
        // Pending means no setup attempt was published, so there is no side
        // effect to replay. Adopt it once now that setup no longer depends on a
        // mounted terminal component.
        void Promise.resolve(
          ensureEnvironmentSetup({ environmentId: environment.id }, this.context),
        ).catch((error: unknown) => {
          console.warn(`[backend] Failed to adopt pending setup for ${environment.id}:`, error);
        });
      }
    }
    // Adopts planning conversations the previous renderer-driven controller
    // left in flight, then advances every durable record on its own timer.
    await this.featurePlanning.init().catch((error) => {
      console.warn("[backend] Failed to restore feature planning:", error);
    });
    // Hydrate the sidebar from bridge-owned session snapshots before the
    // gateway accepts a renderer. A refresh therefore sees active environments
    // immediately, without mounting each tab to recreate client state.
    await this.nativeAgents.reconcileAgentActivity().catch((error) => {
      console.warn("[backend] Failed to restore native agent activity:", error);
    });
    const reconcileClaudeState = this.commands.get("reconcile_claude_state_polling");
    if (reconcileClaudeState) {
      await Promise.resolve(reconcileClaudeState({}, this.context)).catch((error: unknown) => {
        console.warn("[backend] Failed to restore Claude terminal activity:", error);
      });
    }
    // Queued tmux prompts left behind by a quit or crash drain from here, with
    // no renderer involved. NativeAgentService drains its own queues on its own
    // sweep; this one shares the activity sweep rather than adding a third
    // interval over the same store.
    await this.promptQueues.drainAll().catch((error) => {
      console.warn("[backend] Failed to drain tmux prompt queues:", error);
    });
    let tabTeardownReconcileInFlight: Promise<void> | null = null;
    const reconcileTabTeardownsOnce = (): void => {
      if (!reconcileTabTeardowns || tabTeardownReconcileInFlight) return;
      tabTeardownReconcileInFlight = Promise.resolve(reconcileTabTeardowns({}, this.context))
        .then(() => undefined)
        .catch((error: unknown) => {
          console.warn("[backend] Failed to reconcile tab teardowns:", error);
        })
        .finally(() => {
          tabTeardownReconcileInFlight = null;
        });
    };
    let orphanReconcileInFlight: Promise<void> | null = null;
    const reconcileOrphanedTabResourcesOnce = (): void => {
      if (!reconcileOrphanedTabResources || orphanReconcileInFlight) return;
      orphanReconcileInFlight = Promise.resolve(reconcileOrphanedTabResources({}, this.context))
        .then(() => undefined)
        .catch((error: unknown) => {
          console.warn("[backend] Failed to reconcile orphaned tab resources:", error);
        })
        .finally(() => {
          orphanReconcileInFlight = null;
        });
    };
    this.nativeActivitySweep ??= setInterval(() => {
      void this.nativeAgents.reconcileAgentActivity().catch((error) => {
        console.warn("[backend] Failed to reconcile native agent activity:", error);
      });
      if (reconcileClaudeState) {
        void Promise.resolve(reconcileClaudeState({}, this.context)).catch((error: unknown) => {
          console.warn("[backend] Failed to reconcile Claude terminal activity:", error);
        });
      }
      void this.promptQueues.drainAll().catch((error) => {
        console.warn("[backend] Failed to drain tmux prompt queues:", error);
      });
      if (reconcilePendingEnvironmentRenames) {
        void Promise.resolve(reconcilePendingEnvironmentRenames({}, this.context)).catch(
          (error: unknown) => {
            console.warn("[backend] Failed to reconcile pending environment renames:", error);
          },
        );
      }
    }, 2_000);
    this.nativeActivitySweep.unref?.();
    // Interrupted tab cleanup is durable and orphan reaping has a one-hour
    // grace period. A one-minute, coalesced sweep is responsive enough without
    // repeatedly parsing layouts or overlapping destructive work.
    this.tabResourceSweep ??= setInterval(() => {
      reconcileTabTeardownsOnce();
      reconcileOrphanedTabResourcesOnce();
    }, 60_000);
    this.tabResourceSweep.unref?.();
    // This credential persists across restarts, so an already configured MCP
    // client can reconnect the instant the listener binds. Publish it only
    // after every authoritative recovery and service initializer above has
    // completed; accepting mutations earlier would race stale backend state.
    await this.controlMcp.start().catch((error) => {
      // MCP is an optional local control surface. A port conflict should be
      // visible in Settings, but must not prevent the rest of Orkestrator from
      // opening so the user can diagnose it.
      console.warn("[backend] Failed to start control MCP:", error);
    });
  }

  /**
   * Whether `command` is registered, independent of whether it can run now.
   *
   * The gateway gates metric labels on this so a name it rejects is never
   * retained, including when `invoke` refuses for an unrelated reason such as
   * shutdown and so never reaches the registry lookup below.
   */
  hasCommand(command: string): boolean {
    return this.commands.has(command);
  }

  getControlMcpInfo(): ControlMcpInfo | null {
    return this.controlMcp.getInfo();
  }

  getControlMcpSettings(): ControlMcpSettings {
    return this.controlMcp.getSettings();
  }

  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.shuttingDown) throw new Error("Backend is shutting down");
    const handler = this.commands.get(command);
    if (!handler) throw new Error(`Unknown backend command: ${command}`);
    return (await handler(args, this.context)) as T;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    if (this.activityLeaseSweep) {
      clearInterval(this.activityLeaseSweep);
      this.activityLeaseSweep = null;
    }
    if (this.nativeActivitySweep) {
      clearInterval(this.nativeActivitySweep);
      this.nativeActivitySweep = null;
    }
    if (this.tabResourceSweep) {
      clearInterval(this.tabResourceSweep);
      this.tabResourceSweep = null;
    }
    // Synchronous and cannot fail, so it runs before the awaited drain rather
    // than racing it: every watcher holds a file descriptor and a debounce timer.
    shutdownDiffStatsTracking();
    shutdownPrMonitorTracking();
    const attempt = (async () => {
      try {
        const lifecycleDeadline = Date.now() + this.environmentLifecycleDrainTimeoutMs;
        // Close both admission gates before waiting on any in-flight work.
        // Starting the pipeline drain immediately also prevents its scheduler
        // from admitting more backend-owned work during shutdown.
        closeLocalServerAdmission();
        const lifecycleDrain = this.environmentLifecycleTasks.beginShutdown(
          this.environmentLifecycleDrainTimeoutMs,
        );
        // Pipeline passes may still be writing snapshots or using a bridge.
        // Drain them before terminating backend-owned local servers — but never
        // let a failed drain skip that teardown, or every backend-owned bridge
        // process outlives the backend as an orphan.
        try {
          await this.nativeAgents.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain native agent work:", error);
        }
        try {
          await this.buildPipelines.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain build pipelines:", error);
        }
        try {
          await this.loopedReviews.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain looped reviews:", error);
        }
        try {
          await this.multiReviews.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain multi reviews:", error);
        }
        try {
          await this.featurePlanning.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain feature planning:", error);
        }
        try {
          await this.promptQueues.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain tmux prompt queues:", error);
        }
        await lifecycleDrain;
        await shutdownLocalServers({
          operationDrainTimeoutMs: Math.max(0, lifecycleDeadline - Date.now()),
        });
      } finally {
        await this.controlMcp.stop();
        await this.agentTools.stop();
      }
    })();
    this.shutdownPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.shutdownPromise === attempt) this.shutdownPromise = null;
      throw error;
    }
  }
}
