import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  Hourglass,
  Loader2,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  MessagesSquare,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import {
  AGENT_PLATFORM_LABELS,
  AGENT_PLATFORMS,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { AgentNativeTab } from "@/components/native-agent";
import { TAB_ICON_CLASS, TAB_STRIP_CLASS, TabShell } from "@/components/pane-layout/TabShell";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as backend from "@/lib/backend";
import { cn, createSessionKey } from "@/lib/utils";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useNativeNoticeDismissalStore } from "@/stores/nativeNoticeDismissalStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";

interface CoordinatorPanelProps {
  projectId: string;
}

function gitSummary(status: ProjectGitStatus | null): string {
  if (!status) return "Reading repository…";
  if (!status.upstream) return status.detached ? "Detached HEAD" : "No upstream configured";
  if (status.remoteState !== "fresh") return "Remote status is stale";
  if ((status.ahead ?? 0) > 0 && (status.behind ?? 0) > 0) {
    return `${status.ahead} ahead, ${status.behind} behind — diverged`;
  }
  if ((status.behind ?? 0) > 0) return `${status.behind} commits behind`;
  if ((status.ahead ?? 0) > 0) return `${status.ahead} commits ahead`;
  return "Up to date";
}

export function CoordinatorPanel({ projectId }: CoordinatorPanelProps) {
  const project = useProjectStore((state) => state.projects.find((item) => item.id === projectId));
  const [snapshot, setSnapshot] = useState<CoordinatorSnapshot | null>(null);
  const [git, setGit] = useState<ProjectGitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<"fetch" | "sync" | "switch" | "conversation" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<{
    conversationId: string;
    prompt: string;
    modelId?: string;
    reasoningId?: string;
    fastMode: boolean;
    mode?: "build" | "plan";
    executionProfileId?: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const coordinator = await backend.ensureProjectCoordinator(projectId);
      setSnapshot(coordinator);
      const local = await backend.getProjectGitStatus(projectId);
      setGit(local);
      void backend
        .fetchProjectGit(projectId)
        .then(setGit)
        .catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Coordinator could not be opened");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void Promise.all([
        backend.getProjectGitStatus(projectId),
        backend.getProjectCoordinator(projectId),
      ])
        .then(([status, coordinator]) => {
          setGit(status);
          if (coordinator) setSnapshot(coordinator);
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(interval);
    };
  }, [projectId]);

  const runGit = useCallback(
    async (kind: "fetch" | "sync" | "switch", ref?: string) => {
      setOperation(kind);
      setError(null);
      try {
        const next =
          kind === "fetch"
            ? await backend.fetchProjectGit(projectId, true)
            : kind === "sync"
              ? await backend.syncProjectGit(projectId)
              : await backend.switchProjectGitBranch(projectId, ref!);
        setGit(next);
        const refreshed = await backend.getProjectCoordinator(projectId);
        if (refreshed) setSnapshot(refreshed);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `Git ${kind} failed`);
        void backend
          .getProjectGitStatus(projectId)
          .then(setGit)
          .catch(() => undefined);
      } finally {
        setOperation(null);
      }
    },
    [projectId],
  );

  const conversations = useMemo(
    () => snapshot?.workspace.conversations.filter((item) => !item.closedAt) ?? [],
    [snapshot],
  );
  const availablePlatforms = useMemo(
    () =>
      AGENT_PLATFORMS.filter(
        (platform) => snapshot?.providerAvailability[platform]?.available === true,
      ),
    [snapshot],
  );
  // Only the caveats that come with an *available* platform. A reason attached
  // to one the user cannot pick is an explanation of an absence, and belongs
  // nowhere near the picker. These are shown inside the model picker, so the
  // limitation is readable at the moment the platform is chosen — including a
  // mailbox that cannot deliver a worker's reply, and a read-only boundary
  // nothing outside the agent verifies.
  const platformNotes = useMemo(() => {
    const notes: Partial<Record<AgentPlatform, string>> = {};
    for (const platform of availablePlatforms) {
      const qualification = snapshot?.providerAvailability[platform];
      if (!qualification?.reason) continue;
      notes[platform] =
        qualification.tier === "enforced"
          ? qualification.reason
          : `${qualification.reason} Orkestrator cannot verify this boundary independently.`;
    }
    return notes;
  }, [availablePlatforms, snapshot]);
  const assignAgent = useCallback(
    async (
      conversationId: string,
      platform: AgentPlatform,
      launch: {
        modelId?: string;
        reasoningId?: string;
        fastMode: boolean;
        mode?: "build" | "plan";
        executionProfileId?: string;
      },
      prompt: string,
    ) => {
      const next = await backend.assignCoordinatorConversationAgent(
        projectId,
        conversationId,
        platform,
      );
      // Held only until the assigned tab mounts and consumes them. They are not
      // durable state: the backend owns the conversation, and a reload before
      // the first dispatch legitimately returns the user to the composer with
      // their draft rather than replaying a prompt that was never sent.
      setPendingLaunch({ conversationId, prompt, ...launch });
      setSnapshot(next);
    },
    [projectId],
  );
  const selected = conversations.find(
    (item) => item.id === snapshot?.workspace.selectedConversationId,
  );
  const environments = useEnvironmentStore((state) => state.environments);
  /*
   * Workers this coordinator is still owed an answer by.
   *
   * Derived from the snapshot's durable associations rather than anything this
   * component observed, so it is correct on a fresh mount, after a reload, and
   * after the page was closed for an hour — the coordinator keeps waiting while
   * nobody is looking at it.
   *
   * Associations are project-wide, so the selected conversation identity is a
   * load-bearing filter rather than presentation state.
   */
  const awaitingWorkers = useMemo(() => {
    if (!snapshot || !selected) return [];
    return snapshot.workflows.flatMap((association) => {
      if (
        association.coordinatorId !== snapshot.workspace.id ||
        association.conversationId !== selected.id ||
        association.delegation?.state !== "running"
      )
        return [];
      const environment = environments.find((item) => item.id === association.resourceId);
      return [
        {
          id: association.id,
          environmentId: association.resourceId,
          label: environment?.name ?? association.resourceId,
        },
      ];
    });
  }, [snapshot, selected, environments]);
  // Scoped to the conversation that produced it, so switching tabs during
  // assignment cannot replay one conversation's first prompt into another.
  const launchForSelected =
    selected && pendingLaunch?.conversationId === selected.id ? pendingLaunch : null;

  const selectedSessionKey =
    snapshot && selected
      ? createSessionKey(coordinatorRuntimeId(snapshot.workspace.id, selected.id), selected.tabId)
      : null;
  const selectedTurnPhase = useNativeAgentProjectionStore((state) =>
    selectedSessionKey ? state.projections.get(selectedSessionKey)?.turn.phase : undefined,
  );
  // The conversation's own tab id, never a reconstructed one: the workspace
  // assigns it, and a key that does not match leaves the prompt held for good.
  const launchConversation = pendingLaunch
    ? snapshot?.workspace.conversations.find((item) => item.id === pendingLaunch.conversationId)
    : undefined;
  const launchSessionKey =
    snapshot && launchConversation
      ? createSessionKey(
          coordinatorRuntimeId(snapshot.workspace.id, launchConversation.id),
          launchConversation.tabId,
        )
      : null;
  // Either half is enough: a turn that has started, or a message already in the
  // transcript. A slow first read shows neither, which is precisely when the
  // prompt still has to be held.
  const launchObserved = useNativeAgentProjectionStore((state) => {
    if (!launchSessionKey) return false;
    const projection = state.projections.get(launchSessionKey);
    if (!projection) return false;
    return projection.turn.phase !== "idle" || projection.messages.length > 0;
  });
  const coordinatorTurnActive =
    selectedTurnPhase === "running" ||
    selectedTurnPhase === "blocked" ||
    selectedTurnPhase === "cancelling" ||
    selectedTurnPhase === "recovering";
  const blocked = git?.repositoryOperationBlockedReason ?? null;
  const dirty = Boolean(git && (git.trackedChanges > 0 || git.untrackedChanges > 0));
  const newestContextEvent = snapshot?.workspace.repositoryContextEvents?.at(-1);
  const contextNoticeSessionIdentity = snapshot
    ? `coordinator\u0000${projectId}\u0000${snapshot.workspace.id}\u0000${selected?.id ?? "none"}`
    : undefined;
  const contextNoticeOccurrenceId = newestContextEvent
    ? `repository-context\u0000${newestContextEvent.revision}`
    : undefined;
  const contextNoticeDismissed = useNativeNoticeDismissalStore((state) =>
    contextNoticeSessionIdentity && contextNoticeOccurrenceId
      ? (state.sessions
          .find((session) => session.sessionIdentity === contextNoticeSessionIdentity)
          ?.occurrenceIds.includes(contextNoticeOccurrenceId) ?? false)
      : false,
  );
  const dismissNotice = useNativeNoticeDismissalStore((state) => state.dismiss);
  const latestContextEvent =
    newestContextEvent &&
    (selected?.repositoryContextRevisionAcknowledged ?? 0) < newestContextEvent.revision &&
    !contextNoticeDismissed
      ? newestContextEvent
      : undefined;

  /*
   * Held until the turn is observed, not until the tab has rendered once.
   *
   * The agent tab dispatches an opening prompt only after its first
   * authoritative read, so dropping the prompt on the next render — which the
   * snapshot poll triggers within a second or two — raced that read and left
   * the text sitting in the composer unsent. Evidence of the turn is the
   * authoritative signal, and re-dispatch is safe in the meantime because the
   * opening submit carries a deterministic idempotency key.
   */
  useEffect(() => {
    if (!pendingLaunch || !launchObserved) return;
    setPendingLaunch(null);
  }, [launchObserved, pendingLaunch]);

  useEffect(() => {
    if (!selectedSessionKey || coordinatorTurnActive) return;
    void backend
      .getProjectCoordinator(projectId)
      .then((coordinator) => {
        if (coordinator) setSnapshot(coordinator);
      })
      .catch(() => undefined);
  }, [coordinatorTurnActive, projectId, selectedSessionKey]);

  if (!project?.localPath) {
    return (
      <div
        id="project-panel-coordinator"
        role="tabpanel"
        className="grid h-full place-items-center p-8"
      >
        <div className="max-w-lg rounded-xl border border-border bg-card p-6 text-center">
          <GitBranch className="mx-auto mb-3 size-8 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Connect a local checkout</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Coordinator reads the project’s real local checkout. Set a valid local path in
            Repository settings to continue.
          </p>
        </div>
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div
        id="project-panel-coordinator"
        role="tabpanel"
        className="grid h-full place-items-center"
      >
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div
        id="project-panel-coordinator"
        role="tabpanel"
        className="grid h-full place-items-center p-8"
      >
        <div className="max-w-lg rounded-xl border border-destructive/40 bg-card p-6 text-center">
          <AlertCircle className="mx-auto mb-3 size-8 text-destructive" />
          <h2 className="font-semibold">Coordinator unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button className="mt-4" variant="outline" onClick={() => void load()}>
            <RotateCcw className="size-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const providerState = selected?.agent ? snapshot.providerAvailability[selected.agent] : undefined;
  const gitMutationDisabled = operation !== null || Boolean(blocked) || coordinatorTurnActive;
  const canSync = Boolean(git?.upstream && git.behind && git.behind > 0 && !git.ahead && !blocked);

  return (
    <div
      id="project-panel-coordinator"
      role="tabpanel"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="shrink-0 border-b border-border/70 bg-chrome px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="flex min-w-0 items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200">
            <LockKeyhole className="size-3.5" />
            Read-only coordinator
          </span>
          <code
            className="max-w-[28rem] truncate text-xs text-muted-foreground"
            title={snapshot.projectPath}
          >
            {snapshot.projectPath}
          </code>
          <span
            className="rounded bg-elevated px-1.5 py-1 text-[11px] text-muted-foreground"
            title="Branch or HEAD changes increment this context. Earlier analysis may describe an older revision."
          >
            Context r{snapshot.workspace.repositoryContextRevision}
          </span>
          {awaitingWorkers.length > 0 ? (
            <span
              className="flex items-center gap-1.5 rounded bg-elevated px-1.5 py-1 text-[11px] text-muted-foreground"
              title={`Coordinator is idle. It will be woken once each of these workers finishes.\n${awaitingWorkers
                .map((worker) => worker.label)
                .join("\n")}`}
            >
              <Hourglass className="size-3" />
              Waiting on {awaitingWorkers.length}{" "}
              {awaitingWorkers.length === 1 ? "worker" : "workers"}
            </span>
          ) : null}
          <div className="min-w-3 flex-1" />
          <Select
            value={git?.branch ? `refs/heads/${git.branch}` : undefined}
            onValueChange={(value) => void runGit("switch", value)}
            disabled={gitMutationDisabled}
          >
            <SelectTrigger size="sm" className="max-w-56" title={blocked ?? "Switch branch"}>
              <GitBranch className="size-3.5" />
              <SelectValue placeholder={git?.detached ? "Detached HEAD" : "Choose branch"} />
            </SelectTrigger>
            <SelectContent align="end">
              {git?.branches.map((branch) => (
                <SelectItem
                  key={branch.ref}
                  value={branch.ref}
                  disabled={Boolean(branch.occupiedWorktreePath)}
                >
                  {branch.name}
                  {branch.occupiedWorktreePath ? " (in another worktree)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span
            className={cn(
              "text-xs text-muted-foreground",
              git?.remoteState === "fresh" && !git.lastError && "text-emerald-300",
            )}
          >
            {git?.remoteState === "fresh" && !git.lastError ? (
              <CheckCircle2 className="mr-1 inline size-3.5" />
            ) : null}
            {gitSummary(git)}
          </span>
          {canSync ? (
            <Button
              size="sm"
              variant="outline"
              disabled={gitMutationDisabled}
              onClick={() => void runGit("sync")}
            >
              <RotateCcw className="size-3.5" />
              Sync
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            aria-label="Refresh repository status"
            title="Fetch and refresh"
            disabled={operation !== null}
            onClick={() => void runGit("fetch")}
          >
            <RefreshCw className={cn("size-4", operation === "fetch" && "animate-spin")} />
          </Button>
        </div>
        {dirty ? (
          <p className="mt-1 text-xs text-amber-300">
            The checkout has {git?.trackedChanges} tracked and {git?.untrackedChanges} untracked
            changes. Conversations remain read-only; Git mutations are blocked.
          </p>
        ) : null}
        {blocked && !dirty ? <p className="mt-1 text-xs text-amber-300">{blocked}</p> : null}
        {git?.lastError || error ? (
          <details className="mt-1 text-xs text-red-300">
            <summary className="cursor-pointer">Repository or coordinator error</summary>
            <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap">
              {git?.lastError?.stderr ?? git?.lastError?.message ?? error}
            </pre>
          </details>
        ) : null}
        {!snapshot.controlMcp.enabled || !snapshot.controlMcp.running ? (
          <p className="mt-1 text-xs text-amber-300">
            Orchestration controls are unavailable because Control MCP is{" "}
            {snapshot.controlMcp.enabled ? "not running" : "disabled"}
            {snapshot.controlMcp.error ? `: ${snapshot.controlMcp.error}` : "."}
          </p>
        ) : null}
      </div>

      {/* Coordinator conversations are tabs, so they use the same tab chrome as
          the pane tab strip rather than a look of their own. */}
      <div className={cn(TAB_STRIP_CLASS, "shrink-0 pr-2")}>
        {conversations.map((item) => (
          <TabShell
            key={item.id}
            isActive={selected?.id === item.id}
            className="cursor-pointer"
            onClick={() => {
              setError(null);
              void backend
                .selectCoordinatorConversation(projectId, item.id)
                .then(setSnapshot)
                .catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : "Could not select conversation",
                  ),
                );
            }}
            closeLabel={`Close ${item.title}`}
            onClose={() => {
              setOperation("conversation");
              void backend
                .closeCoordinatorConversation(projectId, item.id)
                .then(setSnapshot)
                .catch((cause) =>
                  setError(cause instanceof Error ? cause.message : "Could not close conversation"),
                )
                .finally(() => setOperation(null));
            }}
          >
            <button
              type="button"
              className="flex max-w-44 items-center gap-1.5"
              // The badge is part of what identifies the tab, so it belongs in
              // the accessible name rather than being read as loose text after it.
              aria-label={
                item.agent
                  ? `${item.title}, ${AGENT_PLATFORM_LABELS[item.agent]}`
                  : `${item.title}, no agent chosen yet`
              }
            >
              {/* Which agent a conversation belongs to is fixed at its first
                  prompt and cannot be changed afterwards, so the tab strip is
                  where that has to be legible: the brand mark once assigned,
                  and an explicit prompt while it is not. */}
              {item.agent ? (
                <AgentPlatformIcon platform={item.agent} accent className={TAB_ICON_CLASS} />
              ) : (
                <MessagesSquare className={cn(TAB_ICON_CLASS, "text-muted-foreground")} />
              )}
              <span className="truncate">{item.title}</span>
              {item.agent ? null : (
                <span className="shrink-0 text-[10px] text-muted-foreground">Choose agent</span>
              )}
            </button>
          </TabShell>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="ml-1 shrink-0"
          disabled={operation !== null}
          onClick={() => {
            setOperation("conversation");
            void backend
              .createCoordinatorConversation(projectId)
              .then(setSnapshot)
              .catch((cause) =>
                setError(cause instanceof Error ? cause.message : "Could not create conversation"),
              )
              .finally(() => setOperation(null));
          }}
        >
          <Plus className="size-3.5" />
          New conversation
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          disabled={operation !== null}
          onClick={() => {
            setOperation("conversation");
            setError(null);
            const action =
              snapshot.workspace.lifecycleState === "paused"
                ? backend.resumeProjectCoordinator
                : backend.pauseProjectCoordinator;
            void action(projectId)
              .then(setSnapshot)
              .catch((cause) =>
                setError(cause instanceof Error ? cause.message : "Could not update Coordinator"),
              )
              .finally(() => setOperation(null));
          }}
        >
          {snapshot.workspace.lifecycleState === "paused" ? (
            <Play className="size-3.5" />
          ) : (
            <Pause className="size-3.5" />
          )}
          {snapshot.workspace.lifecycleState === "paused" ? "Resume" : "Pause"}
        </Button>
      </div>

      {latestContextEvent ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b border-blue-400/20 bg-blue-400/5 px-3 py-1.5 text-xs text-blue-200"
        >
          <span className="min-w-0 flex-1">
            Repository context changed to {latestContextEvent.branch ?? "detached HEAD"} at{" "}
            <code>{latestContextEvent.headCommit?.slice(0, 12) ?? "an unborn commit"}</code>{" "}
            (context r{latestContextEvent.revision}). Earlier analysis may be stale; the next turn
            receives the new context.
          </span>
          <button
            type="button"
            aria-label="Dismiss repository context notice"
            title="Dismiss notice"
            className="shrink-0 cursor-pointer rounded-sm opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
            onClick={() => {
              if (contextNoticeSessionIdentity && contextNoticeOccurrenceId) {
                dismissNotice(contextNoticeSessionIdentity, contextNoticeOccurrenceId);
              }
            }}
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {!selected ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <p className="text-sm text-muted-foreground">No open coordinator conversation.</p>
              <Button
                className="mt-3"
                variant="outline"
                disabled={operation !== null}
                onClick={() => {
                  setOperation("conversation");
                  setError(null);
                  void backend
                    .createCoordinatorConversation(projectId)
                    .then(setSnapshot)
                    .catch((cause) =>
                      setError(
                        cause instanceof Error ? cause.message : "Could not create conversation",
                      ),
                    )
                    .finally(() => setOperation(null));
                }}
              >
                <Plus className="size-4" />
                New conversation
              </Button>
            </div>
          </div>
        ) : selected.agent && !providerState?.available ? (
          <div className="grid h-full place-items-center p-8 text-center">
            <div className="max-w-lg">
              <AlertCircle className="mx-auto mb-3 size-7 text-amber-300" />
              <h2 className="font-semibold">
                {AGENT_PLATFORM_LABELS[selected.agent]} is unavailable for Coordinator
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {providerState?.reason ?? snapshot.workspace.lastStartupError}
              </p>
            </div>
          </div>
        ) : snapshot.workspace.lifecycleState === "error" ? (
          <div className="grid h-full place-items-center p-8 text-center">
            <div className="max-w-lg">
              <AlertCircle className="mx-auto mb-3 size-7 text-destructive" />
              <h2 className="font-semibold">Coordinator startup failed</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {snapshot.workspace.lastStartupError ?? "The coordinator could not be started."}
              </p>
              <Button className="mt-4" variant="outline" onClick={() => void load()}>
                <RotateCcw className="size-4" />
                Retry
              </Button>
            </div>
          </div>
        ) : snapshot.workspace.lifecycleState === "paused" ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <Pause className="mx-auto mb-3 size-7 text-muted-foreground" />
              <p>Coordination is paused. Messages and new turns will wait.</p>
            </div>
          </div>
        ) : (
          <AgentNativeTab
            key={selected.id}
            tabId={selected.tabId}
            data={{
              platform: selected.agent,
              environmentId: coordinatorRuntimeId(snapshot.workspace.id, selected.id),
              isLocal: true,
              sessionId: selected.providerSessionId,
            }}
            isActive
            ownsGlobalShortcuts
            executionPolicy="coordinator-read-only"
            coordinatorProjectId={projectId}
            coordinatorWorkspacePath={snapshot.projectPath}
            availablePlatforms={availablePlatforms}
            platformNotes={platformNotes}
            unassignedPlaceholder="Ask the coordinator to inspect or plan…"
            emptyPlatformsMessage="No agent platform meets this coordinator's read-only requirement on this machine. Enable a qualified platform, or lower the coordinator safety level in Settings."
            onAssignPlatform={
              selected.agent
                ? undefined
                : (platform, prompt, options) => assignAgent(selected.id, platform, options, prompt)
            }
            {...(launchForSelected
              ? {
                  initialPrompt: launchForSelected.prompt,
                  initialAgentModel: launchForSelected.modelId,
                  initialReasoningEffort: launchForSelected.reasoningId,
                  initialConversationMode: launchForSelected.mode,
                  initialFastMode: launchForSelected.fastMode,
                  initialExecutionProfileId: launchForSelected.executionProfileId,
                }
              : {})}
          />
        )}
      </div>
      <div className="shrink-0 border-t border-border/60 px-3 py-1 text-center text-[11px] text-muted-foreground">
        Coordinator can inspect and plan against this checkout. Code changes, commands, builds, and
        fixes run in disposable worker environments.
      </div>
    </div>
  );
}
