import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  Loader2,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import { AgentNativeTab } from "@/components/native-agent";
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
  const selected = conversations.find(
    (item) => item.id === snapshot?.workspace.selectedConversationId,
  );
  const selectedSessionKey =
    snapshot && selected
      ? createSessionKey(coordinatorRuntimeId(snapshot.workspace.id, selected.id), selected.tabId)
      : null;
  const selectedTurnPhase = useNativeAgentProjectionStore((state) =>
    selectedSessionKey ? state.projections.get(selectedSessionKey)?.turn.phase : undefined,
  );
  const coordinatorTurnActive =
    selectedTurnPhase === "running" ||
    selectedTurnPhase === "blocked" ||
    selectedTurnPhase === "cancelling" ||
    selectedTurnPhase === "recovering";
  const blocked = git?.repositoryOperationBlockedReason ?? null;
  const dirty = Boolean(git && (git.trackedChanges > 0 || git.untrackedChanges > 0));
  const newestContextEvent = snapshot?.workspace.repositoryContextEvents?.at(-1);
  const latestContextEvent =
    newestContextEvent &&
    (selected?.repositoryContextRevisionAcknowledged ?? 0) < newestContextEvent.revision
      ? newestContextEvent
      : undefined;

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

  const providerState = selected ? snapshot.providerAvailability[selected.agent] : undefined;
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

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-2 py-1.5">
        {conversations.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex items-center rounded-md",
              selected?.id === item.id
                ? "bg-elevated text-foreground"
                : "text-muted-foreground hover:bg-elevated/60",
            )}
          >
            <button
              type="button"
              className="max-w-44 truncate px-3 py-1.5 text-xs"
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
            >
              {item.title}
            </button>
            <button
              type="button"
              className="mr-1 rounded p-1 hover:bg-background/60"
              aria-label={`Close ${item.title}`}
              onClick={() => {
                setOperation("conversation");
                void backend
                  .closeCoordinatorConversation(projectId, item.id)
                  .then(setSnapshot)
                  .catch((cause) =>
                    setError(
                      cause instanceof Error ? cause.message : "Could not close conversation",
                    ),
                  )
                  .finally(() => setOperation(null));
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
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
        <div className="shrink-0 border-b border-blue-400/20 bg-blue-400/5 px-3 py-1.5 text-xs text-blue-200">
          Repository context changed to {latestContextEvent.branch ?? "detached HEAD"} at{" "}
          <code>{latestContextEvent.headCommit?.slice(0, 12) ?? "an unborn commit"}</code> (context
          r{latestContextEvent.revision}). Earlier analysis may be stale; the next turn receives the
          new context.
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
        ) : !providerState?.available ? (
          <div className="grid h-full place-items-center p-8 text-center">
            <div className="max-w-lg">
              <AlertCircle className="mx-auto mb-3 size-7 text-amber-300" />
              <h2 className="font-semibold">{selected.agent} is unavailable for Coordinator</h2>
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
            coordinatorWorkspacePath={snapshot.projectPath}
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
