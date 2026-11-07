import type { McpServer } from "@modelcontextprotocol/server";
import { formatInstantInZone, hostTimeZone } from "@orkestrator/protocol/schedule-time";
import {
  describeScheduleTrigger,
  SCHEDULED_JOB_LIMITS,
  scheduleAccountSwitchGrant,
  type ScheduleAction,
  type ScheduledJob,
  type ScheduledJobSummary,
} from "@orkestrator/protocol/scheduled-jobs";
import { Schema } from "effect";
import { describe, int, list, str, strictObject, toolInput, type Infer } from "../tool-schema.js";
import type { ScheduleCreateInput, ScheduleUpdateInput } from "./service.js";

/**
 * `create_schedule`, `list_schedules` and `cancel_schedule`, shared by the
 * agent tools MCP (an agent in an environment) and the coordinator's Control
 * MCP, plus the coordinator's `pause_schedule`, `resume_schedule` and
 * `update_schedule`. Each surface supplies a backend that acts as the caller
 * its credential authenticated; the tool arguments can never name a
 * different owner.
 */

/** A self-timer's account-switch permission, as the coordinator asked for it. */
export interface SelfTimerAuthorization {
  platforms: Array<"claude" | "codex">;
  nodeIds?: string[];
  userInstruction: string;
}

export interface ScheduleToolBackend {
  /**
   * The reminder a self-timer sends: mail to the caller's own mailbox, with
   * the account-switch permission checked and stamped by the backend. Only
   * coordinators have self-timers.
   */
  selfTimer?(input: {
    body: string;
    subject?: string;
    authorize?: SelfTimerAuthorization;
  }): Promise<ScheduleAction>;
  create(
    input: ScheduleCreateInput,
    requestId: string,
    tabId?: string,
  ): Promise<{ schedule: ScheduledJob; replayed: boolean }>;
  list(tabId?: string): Promise<ScheduledJobSummary[]>;
  cancel(scheduleId: string, tabId?: string): Promise<{ scheduleId: string; deleted: boolean }>;
  /**
   * Coordinators only: one of the caller's schedules, and the edits the
   * public `schedule.pause`, `schedule.resume` and `schedule.update` make.
   */
  get?(scheduleId: string): Promise<ScheduledJob>;
  pause?(scheduleId: string): Promise<ScheduledJob>;
  resume?(scheduleId: string): Promise<ScheduledJob>;
  update?(scheduleId: string, input: ScheduleUpdateInput): Promise<ScheduledJob>;
  /**
   * Coordinators only: the zone a schedule without `timeZone` uses. `user` is
   * the zone of the device the user last prompted the coordinator from; `host`
   * is this machine's, used until any such prompt has been seen.
   */
  defaultTimeZone?(): Promise<{ zone: string; source: "user" | "host" }>;
}

export type ScheduleToolSurface = "agent" | "coordinator";

const ACTION_TYPES = [
  "remind_me",
  "send_message",
  "send_prompt_to_tab",
  "launch_environment",
  "tool",
] as const;

function actionSchema(surface: ScheduleToolSurface) {
  const coordinator = surface === "coordinator";
  return describe(
    Schema.Struct({
      type: describe(
        Schema.Literals(coordinator ? ACTION_TYPES : (["send_message", "tool"] as const)),
        coordinator
          ? "remind_me: a self-timer; body arrives in this conversation as a new turn when it fires. send_message: agent mail as you. send_prompt_to_tab: prompt an idle worker tab. launch_environment: launch a worker. tool: any other of your tools by name."
          : "send_message: agent mail as you. tool: any other of your tools by name.",
      ),
      toEnvironmentId: Schema.optionalKey(
        describe(
          str({ trim: true, min: 1, max: 256 }),
          coordinator
            ? 'send_message: destination. "coordinator" (or your own environment id) is a reminder to yourself.'
            : 'send_message: destination. "coordinator" reaches your coordinator; your own environment id is a reminder to yourself.',
        ),
      ),
      toTabId: Schema.optionalKey(
        describe(str({ trim: true, min: 1, max: 256 }), "send_message: destination tab."),
      ),
      subject: Schema.optionalKey(
        describe(str({ trim: true, max: 200 }), "send_message: subject."),
      ),
      body: Schema.optionalKey(
        describe(
          str({ min: 1, max: 32 * 1024 }),
          coordinator
            ? "remind_me and send_message: the text delivered when the schedule fires. For remind_me write the full instruction you will need then; you will not remember this turn's context."
            : "send_message: the text delivered when the schedule fires.",
        ),
      ),
      ...(coordinator
        ? {
            authorizeAccountSwitch: Schema.optionalKey(
              describe(
                Schema.Struct({
                  platforms: describe(
                    list(Schema.Literals(["claude", "codex"]), { min: 1, max: 2 }),
                    "Providers whose active account the timer may switch.",
                  ),
                  nodeIds: Schema.optionalKey(
                    describe(
                      list(str({ trim: true, min: 1, max: 200 }), { max: 16 }),
                      "Other machines it may switch on (from list_nodes); omit for this one.",
                    ),
                  ),
                  userInstruction: describe(
                    str({ trim: true, min: 1, max: 500 }),
                    "What the user asked, in their words.",
                  ),
                }),
                "One-shot remind_me only, and only when the user's own message in this turn asked you to switch accounts at that time: lets switch_provider_account act when the timer fires without a second approval. Refused in a turn started by mail or another timer.",
              ),
            ),
            environmentId: Schema.optionalKey(
              describe(
                str({ trim: true, min: 1, max: 200 }),
                "send_prompt_to_tab: worker environment.",
              ),
            ),
            tabId: Schema.optionalKey(
              describe(str({ trim: true, min: 1, max: 200 }), "send_prompt_to_tab: worker tab."),
            ),
            prompt: Schema.optionalKey(
              describe(
                str({ min: 1, max: 100_000 }),
                "send_prompt_to_tab and launch_environment: the prompt.",
              ),
            ),
            conversationMode: Schema.optionalKey(Schema.Literals(["plan", "build"])),
            projectId: Schema.optionalKey(
              describe(
                str({ trim: true, min: 1, max: 200 }),
                "launch_environment: this project's id.",
              ),
            ),
            agent: Schema.optionalKey(
              describe(
                Schema.Literals(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
                "launch_environment: agent platform.",
              ),
            ),
            environmentType: Schema.optionalKey(Schema.Literals(["local", "containerized"])),
            name: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
            modelId: Schema.optionalKey(str({ trim: true, min: 1, max: 500 })),
            reasoningId: Schema.optionalKey(str({ trim: true, min: 1, max: 100 })),
            baseBranch: Schema.optionalKey(
              describe(
                str({ trim: true, min: 1, max: 500 }),
                "launch_environment: base branch; default the repository's base branch.",
              ),
            ),
            baseCommit: Schema.optionalKey(
              describe(
                str({ pattern: /^[0-9a-f]{40}$/i }),
                "launch_environment: pin this commit. Omit to use the newest commit of baseBranch when the schedule fires.",
              ),
            ),
            nodeId: Schema.optionalKey(
              describe(
                str({ trim: true, min: 1, max: 200 }),
                "Act on that node's copy of the project, as the immediate tool would.",
              ),
            ),
          }
        : {}),
      tool: Schema.optionalKey(
        describe(str({ trim: true, min: 1, max: 100 }), "tool: the tool name."),
      ),
      arguments: Schema.optionalKey(
        describe(
          Schema.Record(Schema.String, Schema.Unknown),
          "tool: that tool's arguments, without requestId (the schedule supplies one per fire).",
        ),
      ),
    }),
    "What runs when the schedule fires, as you, with your permissions at that time.",
  );
}

type ActionInput = Infer<ReturnType<typeof actionSchema>> & Record<string, unknown>;

function required<T>(value: T | undefined, field: string, type: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`action.${field} is required for ${type}`);
  }
  return value;
}

export function scheduleActionFromTool(action: ActionInput): ScheduleAction {
  switch (action.type) {
    case "remind_me":
      // Resolved by the backend, which knows the caller's own address.
      throw new Error("remind_me is a coordinator self-timer");
    case "send_message":
      return {
        kind: "action",
        action: "send_message",
        input: {
          toEnvironmentId: required(action.toEnvironmentId, "toEnvironmentId", "send_message"),
          ...(action.toTabId ? { toTabId: action.toTabId } : {}),
          ...(action.subject ? { subject: action.subject } : {}),
          body: required(action.body, "body", "send_message"),
          ...(typeof action.nodeId === "string" ? { nodeId: action.nodeId } : {}),
        },
      };
    case "send_prompt_to_tab":
      return {
        kind: "prompt",
        environmentId: required(
          action.environmentId as string | undefined,
          "environmentId",
          action.type,
        ),
        tabId: required(action.tabId as string | undefined, "tabId", action.type),
        prompt: required(action.prompt as string | undefined, "prompt", action.type),
        ...(action.conversationMode ? { mode: action.conversationMode as "plan" | "build" } : {}),
        ...(typeof action.nodeId === "string" ? { nodeId: action.nodeId } : {}),
      };
    case "launch_environment":
      return {
        kind: "launch",
        projectId: required(action.projectId as string | undefined, "projectId", action.type),
        agent: required(action.agent as string | undefined, "agent", action.type),
        prompt: required(action.prompt as string | undefined, "prompt", action.type),
        type: action.environmentType === "containerized" ? "container" : "local",
        ...(typeof action.name === "string" ? { name: action.name } : {}),
        ...(typeof action.modelId === "string" ? { model: action.modelId } : {}),
        ...(typeof action.reasoningId === "string" ? { reasoning: action.reasoningId } : {}),
        ...(action.conversationMode ? { mode: action.conversationMode as "plan" | "build" } : {}),
        ...(typeof action.baseBranch === "string" ? { baseBranch: action.baseBranch } : {}),
        ...(typeof action.baseCommit === "string" ? { baseCommit: action.baseCommit } : {}),
        ...(typeof action.nodeId === "string" ? { nodeId: action.nodeId } : {}),
      };
    case "tool":
      // A self-timer's account-switch permission is stamped only by the
      // backend (remind_me with authorizeAccountSwitch), never passed through.
      if (action.arguments && "grant" in action.arguments) {
        throw new Error(
          "arguments.grant is not allowed; use remind_me with authorizeAccountSwitch",
        );
      }
      return {
        kind: "action",
        action: required(action.tool, "tool", "tool"),
        input: { ...action.arguments },
      };
  }
}

/**
 * The stored action for a tool action, as `create_schedule` and
 * `update_schedule` both build it: a self-timer through the backend (which
 * checks and stamps any account-switch permission), anything else as given.
 */
async function toolScheduleAction(
  backend: ScheduleToolBackend,
  input: ActionInput,
  repeating: boolean,
): Promise<ScheduleAction> {
  if (input.authorizeAccountSwitch && input.type !== "remind_me") {
    throw new Error("authorizeAccountSwitch goes with action type remind_me");
  }
  if (input.authorizeAccountSwitch && repeating) {
    throw new Error("authorizeAccountSwitch requires a one-shot self-timer (at)");
  }
  if (input.type !== "remind_me") return scheduleActionFromTool(input);
  if (!backend.selfTimer) throw new Error("remind_me is a coordinator self-timer");
  return backend.selfTimer({
    body: required(input.body, "body", "remind_me"),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.authorizeAccountSwitch
      ? { authorize: input.authorizeAccountSwitch as SelfTimerAuthorization }
      : {}),
  });
}

/**
 * Whether an update can change when a schedule fires: its trigger, the zone
 * its wall times are read in, or how late a missed fire may still run.
 */
function movesFire(
  timing: Pick<ScheduleUpdateInput, "at" | "cron" | "startAt" | "timeZone" | "catchUpMinutes">,
  everyMinutes: number | undefined,
): boolean {
  return (
    timing.at !== undefined ||
    timing.cron !== undefined ||
    everyMinutes !== undefined ||
    timing.startAt !== undefined ||
    timing.timeZone !== undefined ||
    timing.catchUpMinutes !== undefined
  );
}

/** The reminder's subject is "Scheduled reminder: <name>". */
function selfTimerName(body: string): string {
  const summary = body.replace(/\s+/g, " ").trim();
  return `Self-timer: ${summary.length > 80 ? `${summary.slice(0, 79)}…` : summary}`;
}

function scheduleView(job: ScheduledJob | ScheduledJobSummary) {
  const last =
    "lastFire" in job
      ? job.lastFire
      : ([...job.fires]
          .reverse()
          .find((fire) => fire.state !== "pending" && fire.state !== "running") ?? null);
  return {
    scheduleId: job.id,
    name: job.name,
    state: job.state,
    ...(job.pausedReason ? { pausedReason: job.pausedReason } : {}),
    when: describeScheduleTrigger(job.trigger, job.timeZone),
    timeZone: job.timeZone,
    nextFireAt: job.nextFireAt,
    ...(job.nextFireAt
      ? { nextFireLocal: formatInstantInZone(Date.parse(job.nextFireAt), job.timeZone) }
      : {}),
    catchUpMinutes: job.catchUpMinutes,
    action: job.action.kind === "action" ? job.action.action : job.action.kind,
    lastOutcome: last
      ? {
          state: last.state,
          at: last.finishedAt ?? last.scheduledFor,
          ...(last.error ? { error: last.error.message } : {}),
        }
      : null,
  };
}

function textResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function registerScheduleTools(
  server: McpServer,
  surface: ScheduleToolSurface,
  backend: () => ScheduleToolBackend | null,
): void {
  const zone = hostTimeZone();
  const caller: { tabId?: Schema.optionalKey<Schema.Codec<string, string>> } =
    surface === "agent"
      ? {
          tabId: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 256 }),
              "Your caller mailbox tab; required for an environment credential with multiple mailboxes.",
            ),
          ),
        }
      : {};
  const available = () => {
    const resolved = backend();
    if (!resolved) throw new Error("Scheduled jobs are unavailable");
    return resolved;
  };
  const timingFields = {
    name: Schema.optionalKey(str({ trim: true, min: 1, max: 120 })),
    at: Schema.optionalKey(str({ trim: true, min: 1, max: 64 })),
    cron: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
    everyMinutes: Schema.optionalKey(int({ min: 1, max: 366 * 24 * 60 })),
    startAt: Schema.optionalKey(
      describe(str({ trim: true, min: 1, max: 64 }), "With everyMinutes: the first fire."),
    ),
    timeZone: Schema.optionalKey(
      describe(
        str({ trim: true, min: 1, max: 64 }),
        surface === "coordinator"
          ? `IANA zone; default the user's zone (the device they last prompted you from), or ${zone} until they have.`
          : `IANA zone; default ${zone}.`,
      ),
    ),
    catchUpMinutes: Schema.optionalKey(int({ min: 0, max: 7 * 24 * 60 })),
  };
  server.registerTool(
    "create_schedule",
    {
      title: "Schedule an action",
      description:
        "Have the Orkestrator backend run an action later, once or repeatedly, even after this session ends or the backend restarts. " +
        `Give exactly one of at (one-shot: "03:12" is the next 03:12, "2026-10-26T03:12", an ISO time with an offset, or "+30m"), cron (five fields, e.g. "0 9 * * 1-5") or everyMinutes. Times use timeZone (default ${surface === "coordinator" ? "the user's zone" : zone}); DST is handled. ` +
        (surface === "coordinator"
          ? `To wake yourself later (a self-timer: "in 2 hours" is at "+2h", "at 14:30" is at "14:30"), use action type remind_me: its body arrives in this conversation as a reminder that starts a new turn, and one that fires while you are mid-turn is queued until the turn ends. Absolute times are read in the user's local time zone, the zone of the device the user last sent you a prompt from (this machine's, ${zone}, until they have), unless you pass timeZone; the result names the zone used and the local time. A self-timer is at most ${SCHEDULED_JOB_LIMITS.maxSelfTimerDelayMs / 86_400_000} days ahead and you may hold ${SCHEDULED_JOB_LIMITS.maxPendingSelfTimers} pending. `
          : 'To wake yourself later, send_message to your own environment id: it arrives as a reminder that starts a turn. To wake your coordinator, send to "coordinator". ') +
        "The action runs as you, with your permissions at fire time; anything you could not do directly is refused. A fire missed while the backend was down runs once on return if no more than catchUpMinutes late (default 15), otherwise it is skipped. Use a new requestId for each new schedule; reuse one only to retry the same call. Returns scheduleId and nextFireAt; then finish your turn.",
      inputSchema: toolInput(
        Schema.Struct({
          ...caller,
          requestId: str({ trim: true, min: 1, max: 200 }),
          ...timingFields,
          action: actionSchema(surface),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ requestId, everyMinutes, action, tabId, ...timing }) => {
      const resolved = available();
      const input = action as ActionInput;
      const scheduled = await toolScheduleAction(
        resolved,
        input,
        timing.cron !== undefined || everyMinutes !== undefined,
      );
      if (input.type === "remind_me" && timing.name === undefined) {
        timing.name = selfTimerName(input.body!);
      }
      const given = typeof timing.timeZone === "string";
      // A coordinator's default is the user's own zone once a prompt named it.
      const fallback =
        !given && resolved.defaultTimeZone ? await resolved.defaultTimeZone() : undefined;
      const created = await resolved.create(
        {
          ...timing,
          ...(fallback?.source === "user" ? { timeZone: fallback.zone } : {}),
          ...(everyMinutes !== undefined ? { everySeconds: everyMinutes * 60 } : {}),
          action: scheduled,
        },
        requestId,
        typeof tabId === "string" ? tabId : undefined,
      );
      return textResult({
        ...scheduleView(created.schedule),
        timeZoneUsed: given
          ? `${created.schedule.timeZone} (as given)`
          : fallback?.source === "user"
            ? `${created.schedule.timeZone} (the user's local time zone: the device they last prompted you from)`
            : fallback
              ? `${created.schedule.timeZone} (the user's local time zone is not known yet, so this machine's: pass timeZone if the user is elsewhere)`
              : `${created.schedule.timeZone} (the user's local time zone: this machine's)`,
        ...(scheduleAccountSwitchGrant(created.schedule.action)
          ? { carriesAccountSwitchPermission: true }
          : {}),
        replayed: created.replayed,
      });
    },
  );
  server.registerTool(
    "list_schedules",
    {
      title: "List your schedules",
      description:
        "List the schedules you created: when each fires next, its state and its last outcome.",
      inputSchema: toolInput(Schema.Struct({ ...caller })),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tabId }) => {
      const schedules = await available().list(typeof tabId === "string" ? tabId : undefined);
      return textResult({ schedules: schedules.map(scheduleView), total: schedules.length });
    },
  );
  server.registerTool(
    "cancel_schedule",
    {
      title: "Cancel a schedule",
      description:
        "Delete one of your schedules so it never fires again. A fire already running finishes.",
      inputSchema: toolInput(
        Schema.Struct({ ...caller, scheduleId: str({ trim: true, min: 1, max: 100 }) }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ scheduleId, tabId }) =>
      textResult(
        await available().cancel(scheduleId, typeof tabId === "string" ? tabId : undefined),
      ),
  );
  if (surface === "coordinator") registerScheduleEditTools(server, available, timingFields);
}

/**
 * `pause_schedule`, `resume_schedule` and `update_schedule`: the coordinator's
 * form of `schedule.pause`, `schedule.resume` and `schedule.update`, on its
 * own schedules only. An action given to `update_schedule` is built and
 * checked exactly as `create_schedule` builds and checks it, under the
 * caller's current scope, so a side agent cannot schedule a tool it cannot
 * call; the backend lets only the schedule's owner change its action.
 */
function registerScheduleEditTools(
  server: McpServer,
  available: () => ScheduleToolBackend,
  timingFields: Schema.Struct.Fields,
): void {
  const edits = () => {
    const resolved = available();
    if (!resolved.get || !resolved.pause || !resolved.resume || !resolved.update)
      throw new Error("Editing schedules is unavailable here");
    return resolved as Required<ScheduleToolBackend>;
  };
  const scheduleId = str({ trim: true, min: 1, max: 100 });
  const write = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  server.registerTool(
    "pause_schedule",
    {
      title: "Pause a schedule",
      description:
        "Pause one of your schedules: it does not fire until resume_schedule. A fire already running finishes. Time spent paused is not caught up.",
      inputSchema: toolInput(strictObject({ scheduleId })),
      annotations: write,
    },
    async ({ scheduleId }) => textResult(scheduleView(await edits().pause(scheduleId))),
  );
  server.registerTool(
    "resume_schedule",
    {
      title: "Resume a schedule",
      description:
        "Resume one of your paused schedules, including one Orkestrator paused because its target was deleted or its authority was lost (it pauses again at the next fire if that is still so). It fires next at its next slot after now; missed slots are not replayed.",
      inputSchema: toolInput(strictObject({ scheduleId })),
      annotations: write,
    },
    async ({ scheduleId }) => textResult(scheduleView(await edits().resume(scheduleId))),
  );
  server.registerTool(
    "update_schedule",
    {
      title: "Change a schedule",
      description:
        "Change one of your schedules: its name, its time (exactly one of at, cron or everyMinutes replaces the old one), timeZone, catchUpMinutes or its action. Fields you leave out keep their value. A new action is checked as create_schedule checks it: it runs as you, with your permissions at fire time, and anything you could not do directly is refused. Only the schedule's owner can change its action. A self-timer that carries the user's account-switch permission keeps it only for the time it was given for: to change its time, timeZone or catchUpMinutes, give the action again with authorizeAccountSwitch in a turn the user started, or cancel it and create a new one. Giving a finished one-shot a new time runs it again.",
      inputSchema: toolInput(
        strictObject({
          scheduleId,
          ...timingFields,
          action: Schema.optionalKey(actionSchema("coordinator")),
        }),
      ),
      annotations: { ...write, openWorldHint: true },
    },
    async (args) => {
      const { scheduleId, everyMinutes, action, ...timing } = args as {
        scheduleId: string;
        everyMinutes?: number;
        action?: ActionInput;
      } & Omit<ScheduleUpdateInput, "action" | "everySeconds">;
      const resolved = edits();
      const existing = await resolved.get(scheduleId);
      const retimed =
        timing.at !== undefined || timing.cron !== undefined || everyMinutes !== undefined;
      const repeating = retimed
        ? timing.cron !== undefined || everyMinutes !== undefined
        : existing.trigger.kind !== "once";
      let scheduled: ScheduleAction | undefined;
      if (action) {
        scheduled = await toolScheduleAction(resolved, action, repeating);
        if (action.type === "remind_me" && timing.name === undefined)
          timing.name = selfTimerName(action.body!);
      } else if (movesFire(timing, everyMinutes) && scheduleAccountSwitchGrant(existing.action)) {
        // The user's permission was for the time they gave; anything that can
        // change when it fires (a new time, zone or catch-up window) needs
        // their word again.
        throw new Error(
          "This self-timer carries the user's permission to switch accounts at the time it was set for. To change at, cron, everyMinutes, startAt, timeZone or catchUpMinutes, give the action again (remind_me with authorizeAccountSwitch) in a turn the user started, or cancel it and create a new one. Its name can still be changed.",
        );
      }
      const updated = await resolved.update(scheduleId, {
        ...timing,
        ...(everyMinutes !== undefined ? { everySeconds: everyMinutes * 60 } : {}),
        ...(scheduled ? { action: scheduled } : {}),
      });
      return textResult({
        ...scheduleView(updated),
        ...(scheduleAccountSwitchGrant(updated.action)
          ? { carriesAccountSwitchPermission: true }
          : {}),
      });
    },
  );
}
