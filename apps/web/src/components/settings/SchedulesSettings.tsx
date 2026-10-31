import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Loader2, Pause, Pencil, Play, Plus, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { MailboxDescriptor } from "@orkestrator/protocol/agent-mail";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { formatInstantInZone, hostTimeZone } from "@orkestrator/protocol/schedule-time";
import {
  describeScheduleTrigger,
  nextScheduleSlot,
  normalizeScheduleTrigger,
  normalizeTimeZone,
  SCHEDULED_JOB_LIMITS,
  type ScheduleAction,
  type ScheduleFire,
  type ScheduledJob,
  type ScheduledJobSummary,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Z_FULLSCREEN_DIALOG, Z_FULLSCREEN_DIALOG_POPOVER } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { onResourceChanged, onViewSafetyCheck } from "@/lib/resource-sync";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores";
import {
  graphScheduleRequest,
  initialGraphScheduleForm,
  type GraphScheduleForm,
} from "./graph-schedule-model";
import { ScheduleGraphFields } from "./ScheduleGraphFields";
import { SETTINGS_CARD_CLASS, SettingsPageLayout } from "./SettingsPageLayout";

/**
 * Settings → Schedules: every scheduled job on this backend, who owns it,
 * when it fires next and how its last fire went. The backend owns timing;
 * this view only reads the authoritative list (on mount, on every
 * `scheduled-job` change and on view safety checks) and sends edits.
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

function actionLabel(action: ScheduleAction): string {
  switch (action.kind) {
    case "action":
      return action.action === "mail.send" || action.action === "send_message"
        ? `Mail to ${String(action.input.toEnvironmentId ?? "")}`
        : action.action;
    case "prompt":
      return `Prompt ${action.environmentId} / ${action.tabId}`;
    case "launch":
      return `Launch ${action.agent} in ${action.projectId}`;
    case "graph": {
      const ref = action.request.ref;
      return `Run graph ${ref.scope === "project" ? ref.path : ref.id} in ${action.request.projectId}`;
    }
  }
}

export function SchedulesSettings() {
  const [schedules, setSchedules] = useState<ScheduledJobSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ job?: ScheduledJob } | null>(null);
  const [deleting, setDeleting] = useState<ScheduledJobSummary | null>(null);
  const [history, setHistory] = useState<ScheduledJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // State changes only once the read settles, so the mount effect never sets
  // state synchronously.
  const reload = useCallback(
    () =>
      backend.listScheduledJobs().then(
        ({ schedules: list }) => {
          setSchedules(list);
          setError(null);
        },
        (cause: unknown) => setError(errorText(cause)),
      ),
    [],
  );

  useEffect(() => {
    void reload();
    const offChange = onResourceChanged("scheduled-job", () => void reload());
    const offSafety = onViewSafetyCheck(() => void reload());
    return () => {
      offChange();
      offSafety();
    };
  }, [reload]);

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
      setEditing({ job: await backend.getScheduledJob(job.id) });
    } catch (cause) {
      toast.error("Could not open the schedule", { description: errorText(cause) });
    }
  };

  const openHistory = async (job: ScheduledJobSummary) => {
    try {
      setHistory(await backend.getScheduledJob(job.id));
    } catch (cause) {
      toast.error("Could not load the history", { description: errorText(cause) });
    }
  };

  return (
    <SettingsPageLayout
      width="wide"
      title="Schedules"
      description="Actions the backend runs at a set time, once or repeatedly, as whoever created them: you, a Control MCP client, an agent or a coordinator. Missed fires run late only within their catch-up window."
      actions={
        <Button size="sm" onClick={() => void openEditor()}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New schedule
        </Button>
      }
    >
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

      {schedules?.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-muted-foreground">
          <CalendarClock className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
          No schedules yet. Agents and coordinators can create them with create_schedule.
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
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{job.name}</span>
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
                  {describeScheduleTrigger(job.trigger, job.timeZone)} · {actionLabel(job.action)} ·{" "}
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
                    void act(job, "run the schedule", () => backend.runScheduledJob(job.id))
                  }
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </IconButton>
                {job.state === "active" ? (
                  <IconButton
                    label={`Pause ${job.name}`}
                    disabled={busy === job.id}
                    onClick={() =>
                      void act(job, "pause the schedule", () => backend.pauseScheduledJob(job.id))
                    }
                  >
                    <Pause className="h-3.5 w-3.5" />
                  </IconButton>
                ) : job.state === "paused" ? (
                  <IconButton
                    label={`Resume ${job.name}`}
                    disabled={busy === job.id}
                    onClick={() =>
                      void act(job, "resume the schedule", () => backend.resumeScheduledJob(job.id))
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
                if (job)
                  void act(job, "delete the schedule", () => backend.deleteScheduledJob(job.id));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPageLayout>
  );
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

type TimingMode = "once" | "cron" | "interval";
/** `graph`: a scheduled graph launch (item 214), edited in {@link ScheduleGraphFields}. */
type ActionMode = "mail" | "prompt" | "launch" | "action" | "graph";

interface FormState {
  name: string;
  timing: TimingMode;
  at: string;
  cron: string;
  everyMinutes: string;
  timeZone: string;
  catchUpMinutes: string;
  actionMode: ActionMode;
  mailbox: string;
  subject: string;
  body: string;
  prompt: string;
  projectId: string;
  agent: string;
  baseBranch: string;
  actionName: string;
  actionInput: string;
}

function initialForm(job: ScheduledJob | undefined): FormState {
  const base: FormState = {
    name: job?.name ?? "",
    timing: "once",
    at: "",
    cron: "",
    everyMinutes: "60",
    timeZone: job?.timeZone ?? "",
    catchUpMinutes: String(job?.catchUpMinutes ?? SCHEDULED_JOB_LIMITS.defaultCatchUpMinutes),
    actionMode: "mail",
    mailbox: "",
    subject: "",
    body: "",
    prompt: "",
    projectId: "",
    agent: "claude",
    baseBranch: "",
    actionName: "",
    actionInput: "{}",
  };
  if (!job) return base;
  if (job.trigger.kind === "once") base.at = job.trigger.at;
  if (job.trigger.kind === "cron")
    Object.assign(base, { timing: "cron", cron: job.trigger.expression });
  if (job.trigger.kind === "interval") {
    Object.assign(base, {
      timing: "interval",
      everyMinutes: String(Math.round(job.trigger.everySeconds / 60)),
    });
  }
  const action = job.action;
  if (action.kind === "prompt") {
    Object.assign(base, {
      actionMode: "prompt",
      mailbox: `${action.environmentId}\n${action.tabId}`,
      prompt: action.prompt,
    });
  } else if (action.kind === "launch") {
    Object.assign(base, {
      actionMode: "launch",
      projectId: action.projectId,
      agent: action.agent,
      prompt: action.prompt,
      baseBranch: action.baseBranch ?? "",
    });
  } else if (action.kind === "graph") {
    Object.assign(base, { actionMode: "graph" });
  } else if (action.action === "mail.send" && typeof action.input.toTabId === "string") {
    Object.assign(base, {
      actionMode: "mail",
      mailbox: `${String(action.input.toEnvironmentId)}\n${action.input.toTabId}`,
      subject: typeof action.input.subject === "string" ? action.input.subject : "",
      body: typeof action.input.body === "string" ? action.input.body : "",
    });
  } else {
    Object.assign(base, {
      actionMode: "action",
      actionName: action.action,
      actionInput: JSON.stringify(action.input, null, 2),
    });
  }
  return base;
}

function buildAction(
  form: FormState,
  graph: GraphScheduleForm,
  original?: ScheduleAction,
): ScheduleAction {
  const [environmentId = "", tabId = ""] = form.mailbox.split("\n");
  switch (form.actionMode) {
    case "mail":
      if (!environmentId || !tabId) throw new Error("Choose a mailbox");
      return {
        kind: "action",
        action: "mail.send",
        input: {
          toEnvironmentId: environmentId,
          toTabId: tabId,
          body: form.body,
          ...(form.subject.trim() ? { subject: form.subject.trim() } : {}),
        },
      };
    case "prompt":
      if (!environmentId || !tabId) throw new Error("Choose an agent tab");
      return {
        ...(original?.kind === "prompt" ? original : {}),
        kind: "prompt",
        environmentId,
        tabId,
        prompt: form.prompt,
      };
    case "launch":
      if (!form.projectId) throw new Error("Choose a project");
      return {
        ...(original?.kind === "launch" ? original : {}),
        kind: "launch",
        projectId: form.projectId,
        agent: form.agent,
        prompt: form.prompt,
        type: original?.kind === "launch" ? original.type : "local",
        baseBranch: form.baseBranch.trim() || undefined,
      };
    case "graph":
      return { kind: "graph", request: graphScheduleRequest(graph) };
    case "action": {
      let input: unknown;
      try {
        input = JSON.parse(form.actionInput || "{}");
      } catch {
        throw new Error("The action input is not valid JSON");
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("The action input must be a JSON object");
      }
      return {
        kind: "action",
        action: form.actionName.trim(),
        input: input as Record<string, unknown>,
      };
    }
  }
}

function timingInput(form: FormState) {
  if (form.timing === "once") return { at: form.at.trim() };
  if (form.timing === "cron") return { cron: form.cron.trim() };
  return { everySeconds: Math.round(Number(form.everyMinutes) * 60) };
}

/** The next few fires, computed here only to preview; the backend recomputes. */
function previewFires(form: FormState): { fires: string[]; error: string | null } {
  try {
    const zone = normalizeTimeZone(form.timeZone.trim() || undefined, hostTimeZone());
    const now = Date.now();
    const trigger = normalizeScheduleTrigger(timingInput(form), zone, now);
    const fires: string[] = [];
    let cursor = now;
    for (let index = 0; index < 3; index += 1) {
      const next = nextScheduleSlot(trigger, zone, cursor);
      if (next === null) break;
      fires.push(formatInstantInZone(next, zone));
      cursor = next;
    }
    return { fires, error: null };
  } catch (error) {
    return { fires: [], error: errorText(error) };
  }
}

function ScheduleDialog({
  job,
  onClose,
}: {
  job?: ScheduledJob;
  onClose: (changed: boolean) => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialForm(job));
  const [graph, setGraph] = useState<GraphScheduleForm>(() =>
    initialGraphScheduleForm(job?.action),
  );
  const [mailboxes, setMailboxes] = useState<MailboxDescriptor[]>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const projects = useProjectStore((state) => state.projects);
  // The action always runs as its owner; the app may only change its own.
  const actionLocked = Boolean(job && job.owner.kind !== "operator");
  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));
  const preview = useMemo(() => previewFires(form), [form]);

  useEffect(() => {
    void backend
      .listAgentMailboxes({ limit: 200 })
      .then((page) => setMailboxes(page.mailboxes))
      .catch(() => setMailboxes([]));
  }, []);

  const save = async () => {
    setProblem(null);
    const original = job ? initialForm(job) : null;
    const actionFields: (keyof FormState)[] = [
      "actionMode",
      "mailbox",
      "subject",
      "body",
      "prompt",
      "projectId",
      "agent",
      "baseBranch",
      "actionName",
      "actionInput",
    ];
    const actionChanged =
      !original ||
      actionFields.some((key) => form[key] !== original[key]) ||
      (form.actionMode === "graph" && graph.touched);
    let action: ScheduleAction | undefined;
    try {
      action = actionLocked || !actionChanged ? undefined : buildAction(form, graph, job?.action);
    } catch (error) {
      setProblem(errorText(error));
      return;
    }
    // An edit sends the time only when it changed, so saving a rename never
    // moves the next fire.
    const retimed =
      !original ||
      JSON.stringify(timingInput(form)) !== JSON.stringify(timingInput(original)) ||
      form.timing !== original.timing;
    const timing = {
      ...(retimed ? timingInput(form) : {}),
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      ...(form.timeZone.trim() && form.timeZone.trim() !== original?.timeZone
        ? { timeZone: form.timeZone.trim() }
        : {}),
      catchUpMinutes: Number(form.catchUpMinutes),
    };
    setSaving(true);
    try {
      if (job) {
        await backend.updateScheduledJob(job.id, {
          ...timing,
          ...(action ? { action } : {}),
          expectedRevision: job.revision,
        });
      } else {
        await backend.createScheduledJob({ ...timing, action: action! });
      }
      onClose(true);
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const mailboxSelect = (label: string) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select
        value={form.mailbox}
        onValueChange={(mailbox) => update({ mailbox })}
        disabled={actionLocked}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder="Choose an agent tab" />
        </SelectTrigger>
        <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
          {mailboxes.map((mailbox) => (
            <SelectItem
              key={mailbox.mailboxId}
              value={`${mailbox.environmentId}\n${mailbox.tabId}`}
            >
              {mailbox.environmentName} / {mailbox.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose(false)}>
      <DialogContent
        size="xl"
        className={Z_FULLSCREEN_DIALOG}
        overlayClassName={Z_FULLSCREEN_DIALOG}
      >
        <DialogHeader>
          <DialogTitle>{job ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>
            {job ? `Owned by ${job.ownerLabel}; it runs with their permissions.` : "Runs as you."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="schedule-name">Name</Label>
            <Input
              id="schedule-name"
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </div>
          <div className="grid grid-cols-[10rem_1fr] gap-3">
            <div className="space-y-1.5">
              <Label>When</Label>
              <Select
                value={form.timing}
                onValueChange={(timing) => update({ timing: timing as TimingMode })}
              >
                <SelectTrigger aria-label="When">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
                  <SelectItem value="once">Once</SelectItem>
                  <SelectItem value="cron">Cron</SelectItem>
                  <SelectItem value="interval">Every</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-time">
                {form.timing === "once"
                  ? "Time"
                  : form.timing === "cron"
                    ? "Cron expression"
                    : "Minutes"}
              </Label>
              {form.timing === "once" ? (
                <Input
                  id="schedule-time"
                  placeholder="03:12, 2026-10-26T03:12 or +30m"
                  value={form.at}
                  onChange={(event) => update({ at: event.target.value })}
                />
              ) : form.timing === "cron" ? (
                <Input
                  id="schedule-time"
                  className="font-mono"
                  placeholder="0 9 * * 1-5"
                  value={form.cron}
                  onChange={(event) => update({ cron: event.target.value })}
                />
              ) : (
                <Input
                  id="schedule-time"
                  type="number"
                  min={1}
                  value={form.everyMinutes}
                  onChange={(event) => update({ everyMinutes: event.target.value })}
                />
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-zone">Time zone</Label>
              <Input
                id="schedule-zone"
                placeholder={`Backend default (here ${hostTimeZone()})`}
                value={form.timeZone}
                onChange={(event) => update({ timeZone: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-catch-up">Catch-up window (minutes)</Label>
              <Input
                id="schedule-catch-up"
                type="number"
                min={0}
                max={SCHEDULED_JOB_LIMITS.maxCatchUpMinutes}
                value={form.catchUpMinutes}
                onChange={(event) => update({ catchUpMinutes: event.target.value })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="schedule-preview">
            {preview.error
              ? preview.error
              : preview.fires.length > 0
                ? `Next: ${preview.fires.join(" · ")}`
                : "No future fire time"}
          </p>

          <div className="space-y-1.5">
            <Label>Action</Label>
            <Select
              value={form.actionMode}
              onValueChange={(actionMode) => update({ actionMode: actionMode as ActionMode })}
              disabled={actionLocked}
            >
              <SelectTrigger aria-label="Action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
                <SelectItem value="mail">Send agent mail</SelectItem>
                <SelectItem value="prompt">Prompt an agent tab</SelectItem>
                <SelectItem value="launch">Launch an environment</SelectItem>
                <SelectItem value="graph">Run a graph</SelectItem>
                <SelectItem value="action">Other public action</SelectItem>
              </SelectContent>
            </Select>
            {actionLocked ? (
              <p className="text-xs text-muted-foreground">
                The action belongs to {job?.ownerLabel} and always runs as them, so only they can
                change it.
              </p>
            ) : null}
          </div>

          {form.actionMode === "mail" ? (
            <>
              {mailboxSelect("To")}
              <div className="space-y-1.5">
                <Label htmlFor="schedule-subject">Subject</Label>
                <Input
                  id="schedule-subject"
                  value={form.subject}
                  disabled={actionLocked}
                  onChange={(event) => update({ subject: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-body">Message</Label>
                <Textarea
                  id="schedule-body"
                  rows={4}
                  value={form.body}
                  disabled={actionLocked}
                  onChange={(event) => update({ body: event.target.value })}
                />
              </div>
            </>
          ) : null}
          {form.actionMode === "prompt" ? (
            <>
              {mailboxSelect("Agent tab")}
              <div className="space-y-1.5">
                <Label htmlFor="schedule-prompt">Prompt</Label>
                <Textarea
                  id="schedule-prompt"
                  rows={4}
                  value={form.prompt}
                  disabled={actionLocked}
                  onChange={(event) => update({ prompt: event.target.value })}
                />
              </div>
            </>
          ) : null}
          {form.actionMode === "launch" ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Project</Label>
                  <Select
                    value={form.projectId}
                    onValueChange={(projectId) => update({ projectId })}
                    disabled={actionLocked}
                  >
                    <SelectTrigger aria-label="Project">
                      <SelectValue placeholder="Choose a project" />
                    </SelectTrigger>
                    <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Agent</Label>
                  <Select
                    value={form.agent}
                    onValueChange={(agent) => update({ agent })}
                    disabled={actionLocked}
                  >
                    <SelectTrigger aria-label="Agent">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
                      {AGENT_PLATFORMS.map((agent) => (
                        <SelectItem key={agent} value={agent}>
                          {agent}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-branch">Base branch</Label>
                <Input
                  id="schedule-branch"
                  placeholder="Repository default; its newest commit when it fires"
                  value={form.baseBranch}
                  disabled={actionLocked}
                  onChange={(event) => update({ baseBranch: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-launch-prompt">Initial prompt</Label>
                <Textarea
                  id="schedule-launch-prompt"
                  rows={4}
                  value={form.prompt}
                  disabled={actionLocked}
                  onChange={(event) => update({ prompt: event.target.value })}
                />
              </div>
            </>
          ) : null}
          {form.actionMode === "graph" && !actionLocked ? (
            <ScheduleGraphFields form={graph} projects={projects} onChange={setGraph} />
          ) : null}
          {form.actionMode === "action" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-action-name">Action</Label>
                <Input
                  id="schedule-action-name"
                  className="font-mono"
                  placeholder="ticket.comment"
                  value={form.actionName}
                  disabled={actionLocked}
                  onChange={(event) => update({ actionName: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-action-input">Input (JSON)</Label>
                <Textarea
                  id="schedule-action-input"
                  className="font-mono"
                  rows={5}
                  value={form.actionInput}
                  disabled={actionLocked}
                  onChange={(event) => update({ actionInput: event.target.value })}
                />
              </div>
            </>
          ) : null}
          {problem ? (
            <p className="text-sm text-red-300" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={saving} onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {job ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
