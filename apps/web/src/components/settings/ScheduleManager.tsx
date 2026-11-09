import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { formatInstantInZone } from "@orkestrator/protocol/schedule-time";
import {
  describeScheduleTrigger,
  SCHEDULED_JOB_LIMITS,
  scheduleAccountSwitchGrant,
  schedulerPausedMessage,
  type ScheduleAction,
  type ScheduleFire,
  type ScheduledJob,
  type ScheduledJobSummary,
  type SchedulerStatus,
} from "@orkestrator/protocol/scheduled-jobs";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { onResourceChanged, onViewSafetyCheck } from "@/lib/resource-sync";
import { cn } from "@/lib/utils";
import { useEnvironmentStore, useProjectStore } from "@/stores";
import type { ScheduleApi } from "./schedule-api";
import { ScheduleDialog } from "./ScheduleDialog";
import { SETTINGS_CARD_CLASS } from "./SettingsPageLayout";

/**
 * A list of scheduled jobs: who owns each, when it fires next and how its
 * last fire went, with create, edit, run, pause, resume, history and delete.
 * Settings → Schedules shows every schedule on the window's machine; a
 * project's Scheduling tab shows that project's (`projectId`). The backend
 * owns timing; this view only reads the authoritative list (on mount, on
 * every `scheduled-job` change and on view safety checks) and sends edits.
 */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OUTCOME_STYLES: Record<ScheduleFire["state"], string> = {
  pending: "border-amber-500/40 text-amber-300",
  running: "border-cyan-500/40 text-cyan-300",
  succeeded: "border-emerald-500/40 text-emerald-300",
  failed: "border-red-500/40 text-red-300",
  skipped: "border-zinc-600 text-zinc-400",
};

function OutcomeBadge({ fire }: { fire: ScheduleFire | null }) {
  if (!fire) return <span className="text-xs text-muted-foreground">Never fired</span>;
  return (
    <span
      className={cn("rounded border px-1.5 py-0.5 text-[11px]", OUTCOME_STYLES[fire.state])}
      title={fire.error ? `${fire.error.code}: ${fire.error.message}` : undefined}
    >
      {fire.state}
      {fire.kind !== "scheduled" ? ` (${fire.kind})` : ""}
    </span>
  );
}

/**
 * A self-timer that carries the user's permission to switch accounts: which
 * providers and machines, what the user asked, and whether it still applies
 * (it does for a while after the timer fires, and then lapses).
 */
export function AccountSwitchPermissionBadge({
  job,
  now: nowOverride,
}: {
  job: Pick<ScheduledJobSummary, "action" | "lastFire" | "timeZone">;
  now?: number;
}) {
  const [clock, setClock] = useState(() => Date.now());
  const now = nowOverride ?? clock;
  const grant = scheduleAccountSwitchGrant(job.action);

  const fired =
    job.lastFire?.state === "succeeded" && job.lastFire.finishedAt
      ? Date.parse(job.lastFire.finishedAt)
      : Number.NaN;
  const until = fired + SCHEDULED_JOB_LIMITS.selfTimerGrantWindowMs;
  useEffect(() => {
    if (nowOverride !== undefined || !Number.isFinite(until)) return;
    const update = () => setClock(Date.now());
    const remaining = until - Date.now();
    const timer = setTimeout(update, Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [until, nowOverride]);
  if (!grant) return null;
  const providers = grant.platforms
    .map((platform) => (platform === "codex" ? "Codex" : "Claude"))
    .join(" and ");

  const status = !Number.isFinite(fired)
    ? "when it fires"
    : until > now
      ? `until ${formatInstantInZone(until, job.timeZone)}`
      : "lapsed";
  const machines = grant.nodeIds?.length
    ? `this machine and ${grant.nodeIds.length} other${grant.nodeIds.length === 1 ? "" : "s"}`
    : "this machine";
  const hours = SCHEDULED_JOB_LIMITS.selfTimerGrantWindowMs / 3_600_000;
  return (
    <span
      className={cn(
        "max-w-full rounded border px-1.5 py-0.5 text-[11px]",
        status === "lapsed"
          ? "border-zinc-600 text-zinc-400"
          : "border-amber-500/40 text-amber-300",
      )}
      data-testid="schedule-account-switch-permission"
      title={`You asked: “${grant.userInstruction}”. The coordinator may switch the active ${providers} account on ${machines} without asking, for ${hours} hours after this timer fires. Cancel the timer to withdraw it.`}
    >
      {status === "lapsed"
        ? `${providers} switch permission lapsed`
        : `May switch ${providers} accounts ${status}`}
    </span>
  );
}

/** Names for ids an action carries; an id stays as it is when it is not known. */
interface ActionNames {
  project: (id: string) => string;
  environment: (id: string) => string;
}

const RAW_NAMES: ActionNames = { project: (id) => id, environment: (id) => id };

export function actionLabel(action: ScheduleAction, names: ActionNames = RAW_NAMES): string {
  switch (action.kind) {
    case "action":
      return action.action === "mail.send" || action.action === "send_message"
        ? `Mail to ${names.environment(String(action.input.toEnvironmentId ?? ""))}`
        : action.action;
    case "prompt":
      return `Prompt ${names.environment(action.environmentId)} / ${action.tabId}`;
    case "launch":
      return `Launch ${action.agent} in ${names.project(action.projectId)}`;
    case "graph": {
      const ref = action.request.ref;
      return `Run graph ${ref.scope === "project" ? ref.path : ref.id} in ${names.project(action.request.projectId)}`;
    }
  }
}

function useActionNames(): ActionNames {
  const projects = useProjectStore((state) => state.projects);
  const environments = useEnvironmentStore((state) => state.environments);
  return {
    project: (id) => projects.find((project) => project.id === id)?.name ?? id,
    environment: (id) => environments.find((environment) => environment.id === id)?.name ?? id,
  };
}

export interface ScheduleManagerProps {
  api: ScheduleApi;
  /** Only this project's schedules, and new ones created inside it. */
  projectId?: string;
  /** The node scope whose resource changes re-read the list (default: the app's). */
  scope?: NodeScope;
  /** What the list shows when there are no schedules. */
  emptyText: ReactNode;
  /** Lays out the "New schedule" button and the list. */
  frame: (parts: { actions: ReactNode; children: ReactNode }) => ReactNode;
}

export function ScheduleManager({ api, projectId, scope, emptyText, frame }: ScheduleManagerProps) {
  const names = useActionNames();
  const [schedules, setSchedules] = useState<ScheduledJobSummary[] | null>(null);
  // Absent from a backend that predates it, which then shows no notice.
  const [scheduler, setScheduler] = useState<SchedulerStatus | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ job?: ScheduledJob } | null>(null);
  const [deleting, setDeleting] = useState<ScheduledJobSummary | null>(null);
  const [history, setHistory] = useState<ScheduledJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // State changes only once the read settles, so the mount effect never sets
  // state synchronously.
  const reload = useCallback(
    () =>
      api.listScheduledJobs(projectId ? { projectId } : {}).then(
        ({ schedules: list, scheduler: status }) => {
          setSchedules(list);
          setScheduler(status);
          setError(null);
        },
        (cause: unknown) => setError(errorText(cause)),
      ),
    [api, projectId],
  );

  useEffect(() => {
    void reload();
    const offChange = onResourceChanged("scheduled-job", () => void reload(), scope);
    const offSafety = onViewSafetyCheck(() => void reload(), scope);
    return () => {
      offChange();
      offSafety();
    };
  }, [reload, scope]);

  const act = async (job: ScheduledJobSummary, label: string, run: () => Promise<unknown>) => {
    setBusy(job.id);
    try {
      await run();
      await reload();
    } catch (cause) {
      toast.error(`Could not ${label}`, { description: errorText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const openEditor = async (job?: ScheduledJobSummary) => {
    if (!job) {
      setEditing({});
      return;
    }
    try {
      setEditing({ job: await api.getScheduledJob(job.id) });
    } catch (cause) {
      toast.error("Could not open the schedule", { description: errorText(cause) });
    }
  };

  const openHistory = async (job: ScheduledJobSummary) => {
    try {
      setHistory(await api.getScheduledJob(job.id));
    } catch (cause) {
      toast.error("Could not load the history", { description: errorText(cause) });
    }
  };

  const actions = (
    <Button size="sm" onClick={() => void openEditor()}>
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      New schedule
    </Button>
  );

  const children = (
    <>
      {error ? (
        <p className="rounded-md border border-red-500/40 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      ) : null}

      {schedules === null && !error ? (
        <div className="flex justify-center py-10" role="status" aria-label="Loading schedules">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {scheduler?.firing === false && schedules && schedules.length > 0 ? (
        <p
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-200"
          role="status"
          data-testid="scheduler-paused"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{schedulerPausedMessage(scheduler.reason)}</span>
        </p>
      ) : null}

      {schedules?.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-muted-foreground">
          <CalendarClock className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
          {emptyText}
        </div>
      ) : null}

      {schedules && schedules.length > 0 ? (
        <ul className={cn(SETTINGS_CARD_CLASS, "divide-y divide-zinc-800")}>
          {schedules.map((job) => (
            <li
              key={job.id}
              className="flex flex-wrap items-center gap-3 p-3"
              data-testid="schedule-row"
            >
              <div className="min-w-0 flex-[1_1_16rem]">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="max-w-full truncate font-medium">{job.name}</span>
                  <AccountSwitchPermissionBadge job={job} />
                  {job.state !== "active" ? (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300">
                      {job.state}
                      {job.pausedReason && job.pausedReason !== "user"
                        ? `: ${job.pausedReason}`
                        : ""}
                    </span>
                  ) : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {describeScheduleTrigger(job.trigger, job.timeZone)} ·{" "}
                  {actionLabel(job.action, names)} ·{" "}
                  <span data-testid="schedule-owner">{job.ownerLabel}</span>
                </p>
                {job.pausedMessage ? (
                  <p className="text-xs text-amber-300">{job.pausedMessage}</p>
                ) : null}
              </div>
              <div className="w-48 text-right text-xs">
                <div className="text-muted-foreground">Next</div>
                <div data-testid="schedule-next">
                  {job.nextFireAt && job.state === "active"
                    ? formatInstantInZone(Date.parse(job.nextFireAt), job.timeZone)
                    : "—"}
                </div>
              </div>
              <div className="w-28 text-right">
                <OutcomeBadge fire={job.activeFire ?? job.lastFire} />
              </div>
              <div className="flex gap-1">
                <IconButton
                  label={`Run ${job.name} now`}
                  disabled={busy === job.id}
                  onClick={() =>
                    void act(job, "run the schedule", () => api.runScheduledJob(job.id))
                  }
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </IconButton>
                {job.state === "active" ? (
                  <IconButton
                    label={`Pause ${job.name}`}
                    disabled={busy === job.id}
                    onClick={() =>
                      void act(job, "pause the schedule", () => api.pauseScheduledJob(job.id))
                    }
                  >
                    <Pause className="h-3.5 w-3.5" />
                  </IconButton>
                ) : job.state === "paused" ? (
                  <IconButton
                    label={`Resume ${job.name}`}
                    disabled={busy === job.id}
                    onClick={() =>
                      void act(job, "resume the schedule", () => api.resumeScheduledJob(job.id))
                    }
                  >
                    <Play className="h-3.5 w-3.5" />
                  </IconButton>
                ) : null}
                <IconButton label={`Edit ${job.name}`} onClick={() => void openEditor(job)}>
                  <Pencil className="h-3.5 w-3.5" />
                </IconButton>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => void openHistory(job)}
                >
                  History
                </Button>
                <IconButton label={`Delete ${job.name}`} onClick={() => setDeleting(job)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {editing ? (
        <ScheduleDialog
          job={editing.job}
          api={api}
          projectId={projectId}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void reload();
          }}
        />
      ) : null}

      {history ? <HistoryDialog job={history} onClose={() => setHistory(null)} /> : null}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It never fires again and its history is removed. A fire already running finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const job = deleting;
                setDeleting(null);
                if (job) void act(job, "delete the schedule", () => api.deleteScheduledJob(job.id));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return frame({ actions, children });
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 w-7 p-0"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function HistoryDialog({ job, onClose }: { job: ScheduledJob; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="2xl"
        className={Z_FULLSCREEN_DIALOG}
        overlayClassName={Z_FULLSCREEN_DIALOG}
      >
        <DialogHeader>
          <DialogTitle>{job.name}</DialogTitle>
          <DialogDescription>
            The last {SCHEDULED_JOB_LIMITS.historyEntries} fires, newest first. Owner:{" "}
            {job.ownerLabel}.
          </DialogDescription>
        </DialogHeader>
        {job.fires.length === 0 ? (
          <p className="text-sm text-muted-foreground">This schedule has not fired yet.</p>
        ) : (
          <ul className="max-h-96 space-y-2 overflow-y-auto text-xs" data-testid="schedule-history">
            {[...job.fires].reverse().map((fire) => (
              <li key={fire.fireId} className="rounded border border-zinc-800 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">
                    {formatInstantInZone(Date.parse(fire.scheduledFor), job.timeZone)}
                  </span>
                  <OutcomeBadge fire={fire} />
                </div>
                <div className="mt-1 text-muted-foreground">
                  {fire.fireId}
                  {fire.attempts > 1 ? ` · ${fire.attempts} attempts` : ""}
                  {fire.missed
                    ? ` · ${fire.missed} earlier slot${fire.missed === 1 ? "" : "s"} missed`
                    : ""}
                </div>
                {fire.error ? <div className="mt-1 text-red-300">{fire.error.message}</div> : null}
                {fire.outcome?.summary ? <div className="mt-1">{fire.outcome.summary}</div> : null}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
