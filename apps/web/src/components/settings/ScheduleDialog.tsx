import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { MailboxDescriptor } from "@orkestrator/protocol/agent-mail";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { formatInstantInZone, hostTimeZone } from "@orkestrator/protocol/schedule-time";
import {
  nextScheduleSlot,
  normalizeScheduleTrigger,
  normalizeTimeZone,
  SCHEDULED_JOB_LIMITS,
  type ScheduleAction,
  type ScheduledJob,
} from "@orkestrator/protocol/scheduled-jobs";
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
import { useProjectStore } from "@/stores";
import {
  graphScheduleRequest,
  initialGraphScheduleForm,
  type GraphScheduleForm,
} from "./graph-schedule-model";
import type { ScheduleApi } from "./schedule-api";
import { ScheduleGraphFields } from "./ScheduleGraphFields";

/**
 * The create and edit dialog of a schedule, shared by Settings → Schedules
 * and a project's Scheduling tab. With `projectId` the dialog works inside
 * that project: a new schedule launches into it by default, its agent tabs
 * are the only targets offered and the project cannot be changed, so
 * whatever is created is listed with the project.
 */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type TimingMode = "once" | "cron" | "interval";
/** `graph`: a scheduled graph launch (item 214), edited in {@link ScheduleGraphFields}. */
type ActionMode = "mail" | "prompt" | "launch" | "action" | "graph";

const ACTION_MODE_LABELS: Record<ActionMode, string> = {
  mail: "Send agent mail",
  prompt: "Prompt an agent tab",
  launch: "Launch an environment",
  graph: "Run a graph",
  action: "Other public action",
};

/**
 * The actions the dialog offers. Inside a project only those that target the
 * project or one of its environments, so a new schedule is always listed
 * with it; an existing schedule keeps its own kind.
 */
export function scheduleActionModes(options: {
  projectId?: string;
  current?: ActionMode;
}): ActionMode[] {
  const modes: ActionMode[] = ["mail", "prompt", "launch", "graph"];
  if (!options.projectId || options.current === "action") modes.push("action");
  return modes;
}

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

export function initialForm(job: ScheduledJob | undefined, projectId?: string): FormState {
  const base: FormState = {
    name: job?.name ?? "",
    timing: "once",
    at: "",
    cron: "",
    everyMinutes: "60",
    timeZone: job?.timeZone ?? "",
    catchUpMinutes: String(job?.catchUpMinutes ?? SCHEDULED_JOB_LIMITS.defaultCatchUpMinutes),
    // A project's new schedule most often starts work in it.
    actionMode: projectId ? "launch" : "mail",
    mailbox: "",
    subject: "",
    body: "",
    prompt: "",
    projectId: projectId ?? "",
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

export function ScheduleDialog({
  job,
  api,
  projectId,
  onClose,
}: {
  job?: ScheduledJob;
  api: ScheduleApi;
  /** The project the dialog works in (a project's Scheduling tab). */
  projectId?: string;
  onClose: (changed: boolean) => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialForm(job, projectId));
  const [graph, setGraph] = useState<GraphScheduleForm>(() => {
    const initial = initialGraphScheduleForm(job?.action);
    return projectId && !initial.projectId ? { ...initial, projectId } : initial;
  });
  const [mailboxes, setMailboxes] = useState<MailboxDescriptor[]>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const allProjects = useProjectStore((state) => state.projects);
  const projects = useMemo(
    () => (projectId ? allProjects.filter((project) => project.id === projectId) : allProjects),
    [allProjects, projectId],
  );
  const actionModes = scheduleActionModes({
    projectId,
    current: job ? initialForm(job).actionMode : undefined,
  });
  // Inside a project only its own agent tabs, plus the one a stored schedule
  // already names.
  const mailboxChoices = useMemo(
    () =>
      projectId
        ? mailboxes.filter(
            (mailbox) =>
              mailbox.projectId === projectId ||
              `${mailbox.environmentId}\n${mailbox.tabId}` === form.mailbox,
          )
        : mailboxes,
    [mailboxes, projectId, form.mailbox],
  );
  // The action always runs as its owner; the app may only change its own.
  const actionLocked = Boolean(job && job.owner.kind !== "operator");
  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));
  const preview = useMemo(() => previewFires(form), [form]);

  useEffect(() => {
    void api
      .listAgentMailboxes({ limit: 200, ...(projectId ? { projectId } : {}) })
      .then((page) => setMailboxes(page.mailboxes))
      .catch(() => setMailboxes([]));
  }, [api, projectId]);

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
        await api.updateScheduledJob(job.id, {
          ...timing,
          ...(action ? { action } : {}),
          expectedRevision: job.revision,
        });
      } else {
        await api.createScheduledJob({ ...timing, action: action! });
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
          {mailboxChoices.map((mailbox) => (
            <SelectItem
              key={mailbox.mailboxId}
              value={`${mailbox.environmentId}\n${mailbox.tabId}`}
            >
              {mailbox.environmentName} / {mailbox.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {projectId && mailboxChoices.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No agent tabs in this project yet. Open an environment with an agent first.
        </p>
      ) : null}
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
            {job
              ? `Owned by ${job.ownerLabel}; it runs with their permissions.`
              : projectId
                ? `Runs as you, in ${projects[0]?.name ?? "this project"}.`
                : "Runs as you."}
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
                {actionModes.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {ACTION_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
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
                    onValueChange={(chosen) => update({ projectId: chosen })}
                    disabled={actionLocked || Boolean(projectId)}
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
            <ScheduleGraphFields
              form={graph}
              projects={projects}
              projectLocked={Boolean(projectId)}
              onChange={setGraph}
            />
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
