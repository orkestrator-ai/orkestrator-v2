import { useState } from "react";
import { CheckCircle2, GitBranch, Pause, RefreshCw, RotateCcw } from "lucide-react";
import type {
  CoordinatorSnapshot,
  ProjectGitStatus,
  ProjectGitSwitchConfirmation,
} from "@orkestrator/protocol/coordinator";
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FreshnessIndicator } from "@/components/freshness/FreshnessIndicator";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import type { FreshnessNotice } from "@/lib/view-freshness";
import {
  coordinatorGitErrorText,
  CoordinatorErrorDetails,
  CoordinatorIsolationBadge,
} from "./CoordinatorPanelNotices";

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

interface CoordinatorToolbarProps {
  snapshot: CoordinatorSnapshot;
  git: ProjectGitStatus | null;
  /** Hide only a retained error already announced by the panel. */
  announcedError?: string | null;
  gitBusy: boolean;
  fetching: boolean;
  conversationBusy: boolean;
  /** Set only while background reads are failing. */
  freshness: FreshnessNotice | null;
  runGit: (
    kind: "fetch" | "sync" | "switch",
    ref?: string,
    confirmation?: ProjectGitSwitchConfirmation,
  ) => Promise<void>;
  prepareSwitch: (
    ref: string,
    onReady: (confirmation: ProjectGitSwitchConfirmation) => void,
  ) => Promise<void>;
  /** Who is running the turn that holds the checkout, by name. */
  activeTurn: string | null;
  /** The agent of the conversation in front, once it has one. */
  selectedAgent: AgentPlatform | undefined;
  paused: boolean;
  onPause: () => void;
}

/** The panel's header: the isolation badge, the checkout's Git controls, and their notices. */
export function CoordinatorToolbar({
  snapshot,
  git,
  announcedError,
  gitBusy,
  fetching,
  conversationBusy,
  freshness,
  runGit,
  prepareSwitch,
  activeTurn,
  selectedAgent,
  paused,
  onPause,
}: CoordinatorToolbarProps) {
  const [pendingSwitch, setPendingSwitch] = useState<ProjectGitSwitchConfirmation | null>(null);
  const blocked = git?.repositoryOperationBlockedReason ?? null;
  const dirty = Boolean(git && (git.trackedChanges > 0 || git.untrackedChanges > 0));
  const discardableDirty = Boolean(
    dirty &&
    git &&
    !git.mergeInProgress &&
    !git.rebaseInProgress &&
    !git.sequencerInProgress &&
    git.conflicts === 0,
  );
  const switchBlocked = Boolean(blocked && !discardableDirty);
  const pendingSwitchBranch = git?.branches.find((branch) => branch.ref === pendingSwitch?.ref);
  const branchSwitchDisabled = gitBusy || switchBlocked || activeTurn !== null;
  const activeTurnReason = activeTurn
    ? `${activeTurn} is running a turn. Branch switching and Sync wait for it to finish.`
    : undefined;
  const syncDisabled = branchSwitchDisabled || dirty;
  const canSync = Boolean(git?.upstream && git.behind && git.behind > 0 && !git.ahead && !blocked);
  // The badge speaks for the conversation in front: its platform's read-only
  // boundary is either enforced or only something the agent is asked to keep.
  const selectedQualification = selectedAgent
    ? snapshot.providerAvailability[selectedAgent]
    : undefined;
  const advisoryPlatform =
    selectedAgent && selectedQualification && selectedQualification.tier !== "enforced"
      ? AGENT_PLATFORM_LABELS[selectedAgent]
      : null;
  const gitError = coordinatorGitErrorText(git);

  return (
    <>
      <div className="shrink-0 border-b border-border/70 bg-chrome px-3 py-2">
        {/* On a phone the badge and the buttons keep only their icons (their
        names stay in the accessible name), so the row rarely wraps. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CoordinatorIsolationBadge
            projectPath={snapshot.projectPath}
            contextRevision={snapshot.workspace.repositoryContextRevision}
            advisoryPlatform={advisoryPlatform}
          />
          <div className="min-w-3 flex-1" />
          <Select
            value={git?.branch ? `refs/heads/${git.branch}` : undefined}
            onValueChange={(value) => {
              if (!discardableDirty) {
                void runGit("switch", value);
                return;
              }
              void prepareSwitch(value, setPendingSwitch);
            }}
            disabled={branchSwitchDisabled}
          >
            <SelectTrigger
              size="sm"
              className="max-w-40 sm:max-w-56"
              title={
                activeTurnReason ??
                (switchBlocked ? blocked : null) ??
                (dirty
                  ? "Switch branch and choose whether to discard local changes"
                  : "Switch branch")
              }
            >
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
          {freshness ? (
            <span
              role="status"
              title={freshness.detail}
              data-coordinator-freshness={freshness.kind}
              className="inline-flex items-center gap-1 text-xs text-amber-300"
            >
              <FreshnessIndicator notice={freshness} />
              {freshness.label}
            </span>
          ) : null}
          {canSync ? (
            // A disabled button takes no pointer events, so its reason shows from here.
            <span className="inline-flex" title={activeTurnReason}>
              <Button
                size="sm"
                variant="outline"
                disabled={syncDisabled}
                title={activeTurnReason}
                onClick={() => void runGit("sync")}
              >
                <RotateCcw className="size-3.5" />
                <span className="max-sm:sr-only">Sync</span>
              </Button>
            </span>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            aria-label="Refresh repository status"
            title="Fetch and refresh"
            disabled={gitBusy}
            onClick={() => void runGit("fetch")}
          >
            <RefreshCw className={cn("size-4", fetching && "animate-spin")} />
          </Button>
          {/* While paused, the banner below the header offers Resume. */}
          {paused ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={conversationBusy}
              onClick={onPause}
              title="Pause this project's coordinator: mail and new turns are held until you resume. Conversations stay readable."
            >
              <Pause className="size-3.5" />
              <span className="max-sm:sr-only">Pause</span>
            </Button>
          )}
        </div>
        {dirty ? (
          <p className="mt-1 text-xs text-amber-300">
            The checkout has {git?.trackedChanges} tracked and {git?.untrackedChanges} untracked
            changes. Sync is blocked
            {discardableDirty ? "; switching branches will ask before discarding them." : "."}
          </p>
        ) : null}
        {blocked && switchBlocked ? <p className="mt-1 text-xs text-amber-300">{blocked}</p> : null}
        {gitError && gitError !== announcedError ? (
          <CoordinatorErrorDetails label="Repository error" message={gitError} />
        ) : null}
        {!snapshot.controlMcp.enabled || !snapshot.controlMcp.running ? (
          <p className="mt-1 text-xs text-amber-300">
            Orchestration controls are unavailable because Control MCP is{" "}
            {snapshot.controlMcp.enabled ? "not running" : "disabled"}
            {snapshot.controlMcp.error ? `: ${snapshot.controlMcp.error}` : "."}
          </p>
        ) : null}
        {snapshot.agentMessaging?.enabled === false ? (
          <p className="mt-1 text-xs text-amber-300">
            Delegation unavailable: agent messaging is off, so workers cannot report back.{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-amber-200 focus-hairline"
              onClick={() => requestGlobalSettings("messaging")}
            >
              Turn it on in Settings → Messaging
            </button>
            .
          </p>
        ) : null}
      </div>
      <AlertDialog
        open={pendingSwitch !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSwitch(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes and switch branch?</AlertDialogTitle>
            <AlertDialogDescription>
              Switching to {pendingSwitchBranch?.name ?? "the selected branch"} will permanently
              discard {pendingSwitch?.trackedChanges ?? 0} tracked changes and{" "}
              {pendingSwitch?.untrackedFiles ?? 0} untracked files from this checkout, including
              files inside untracked directories. Ignored files are kept.
              {pendingSwitch?.nestedRepositories.length
                ? ` This will also permanently delete nested repositories: ${pendingSwitch.nestedRepositories.join(", ")}.`
                : ""}
              {pendingSwitch?.dirtySubmodules.length
                ? ` This will also reset dirty submodules: ${pendingSwitch.dirtySubmodules.join(", ")}.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {activeTurnReason ? (
            <p role="status" className="text-sm text-muted-foreground">
              {activeTurnReason}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep changes</AlertDialogCancel>
            <AlertDialogAction
              disabled={branchSwitchDisabled}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (branchSwitchDisabled) return;
                const confirmation = pendingSwitch;
                setPendingSwitch(null);
                if (confirmation) void runGit("switch", confirmation.ref, confirmation);
              }}
            >
              Discard and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
