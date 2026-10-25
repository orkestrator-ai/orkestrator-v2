import type { McpServer } from "@modelcontextprotocol/server";
import { hostTimeZone } from "@orkestrator/protocol/schedule-time";
import {
  describeScheduleTrigger,
  type ScheduleAction,
  type ScheduledJob,
  type ScheduledJobSummary,
} from "@orkestrator/protocol/scheduled-jobs";
import { z } from "zod";
import type { ScheduleCreateInput } from "./service.js";

/**
 * `create_schedule`, `list_schedules` and `cancel_schedule`, shared by the
 * agent tools MCP (an agent in an environment) and the coordinator's Control
 * MCP. Each surface supplies a backend that acts as the caller its credential
 * authenticated; the tool arguments can never name a different owner.
 */

export interface ScheduleToolBackend {
  create(
    input: ScheduleCreateInput,
    requestId: string,
    tabId?: string,
  ): Promise<{ schedule: ScheduledJob; replayed: boolean }>;
  list(tabId?: string): Promise<ScheduledJobSummary[]>;
  cancel(scheduleId: string, tabId?: string): Promise<{ scheduleId: string; deleted: boolean }>;
}

export type ScheduleToolSurface = "agent" | "coordinator";

const ACTION_TYPES = ["send_message", "send_prompt_to_tab", "launch_environment", "tool"] as const;

function actionSchema(surface: ScheduleToolSurface) {
  const coordinator = surface === "coordinator";
  return z
    .object({
      type: z
        .enum(coordinator ? ACTION_TYPES : (["send_message", "tool"] as const))
        .describe(
          coordinator
            ? "send_message: agent mail as you. send_prompt_to_tab: prompt an idle worker tab. launch_environment: launch a worker. tool: any other of your tools by name."
            : "send_message: agent mail as you. tool: any other of your tools by name.",
        ),
      toEnvironmentId: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .optional()
        .describe(
          coordinator
            ? 'send_message: destination. "coordinator" (or your own environment id) is a reminder to yourself.'
            : 'send_message: destination. "coordinator" reaches your coordinator; your own environment id is a reminder to yourself.',
        ),
      toTabId: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .optional()
        .describe("send_message: destination tab."),
      subject: z.string().trim().max(200).optional().describe("send_message: subject."),
      body: z
        .string()
        .min(1)
        .max(32 * 1024)
        .optional()
        .describe("send_message: the text delivered when the schedule fires."),
      ...(coordinator
        ? {
            environmentId: z
              .string()
              .trim()
              .min(1)
              .max(200)
              .optional()
              .describe("send_prompt_to_tab: worker environment."),
            tabId: z
              .string()
              .trim()
              .min(1)
              .max(200)
              .optional()
              .describe("send_prompt_to_tab: worker tab."),
            prompt: z
              .string()
              .min(1)
              .max(100_000)
              .optional()
              .describe("send_prompt_to_tab and launch_environment: the prompt."),
            conversationMode: z.enum(["plan", "build"]).optional(),
            projectId: z
              .string()
              .trim()
              .min(1)
              .max(200)
              .optional()
              .describe("launch_environment: this project's id."),
            agent: z
              .enum(["claude", "codex", "cursor", "grok", "opencode", "pi"])
              .optional()
              .describe("launch_environment: agent platform."),
            environmentType: z.enum(["local", "containerized"]).optional(),
            name: z.string().trim().min(1).max(200).optional(),
            modelId: z.string().trim().min(1).max(500).optional(),
            reasoningId: z.string().trim().min(1).max(100).optional(),
            baseBranch: z
              .string()
              .trim()
              .min(1)
              .max(500)
              .optional()
              .describe("launch_environment: base branch; default the repository's base branch."),
            baseCommit: z
              .string()
              .regex(/^[0-9a-f]{40}$/i)
              .optional()
              .describe(
                "launch_environment: pin this commit. Omit to use the newest commit of baseBranch when the schedule fires.",
              ),
            nodeId: z
              .string()
              .trim()
              .min(1)
              .max(200)
              .optional()
              .describe("Act on that node's copy of the project, as the immediate tool would."),
          }
        : {}),
      tool: z.string().trim().min(1).max(100).optional().describe("tool: the tool name."),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "tool: that tool's arguments, without requestId (the schedule supplies one per fire).",
        ),
    })
    .describe("What runs when the schedule fires, as you, with your permissions at that time.");
}

type ActionInput = z.infer<ReturnType<typeof actionSchema>> & Record<string, unknown>;

function required<T>(value: T | undefined, field: string, type: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`action.${field} is required for ${type}`);
  }
  return value;
}

export function scheduleActionFromTool(action: ActionInput): ScheduleAction {
  switch (action.type) {
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
      return {
        kind: "action",
        action: required(action.tool, "tool", "tool"),
        input: { ...action.arguments },
      };
  }
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
  const caller: { tabId?: z.ZodOptional<z.ZodString> } =
    surface === "agent"
      ? {
          tabId: z
            .string()
            .trim()
            .min(1)
            .max(256)
            .optional()
            .describe(
              "Your caller mailbox tab; required for an environment credential with multiple mailboxes.",
            ),
        }
      : {};
  const available = () => {
    const resolved = backend();
    if (!resolved) throw new Error("Scheduled jobs are unavailable");
    return resolved;
  };
  server.registerTool(
    "create_schedule",
    {
      title: "Schedule an action",
      description:
        "Have the Orkestrator backend run an action later, once or repeatedly, even after this session ends or the backend restarts. " +
        `Give exactly one of at (one-shot: "03:12" is the next 03:12, "2026-10-26T03:12", an ISO time with an offset, or "+30m"), cron (five fields, e.g. "0 9 * * 1-5") or everyMinutes. Times use timeZone (default ${zone}); DST is handled. ` +
        (surface === "coordinator"
          ? 'To wake yourself later, send_message to "coordinator": it arrives as a reminder that starts a turn. '
          : 'To wake yourself later, send_message to your own environment id: it arrives as a reminder that starts a turn. To wake your coordinator, send to "coordinator". ') +
        "The action runs as you, with your permissions at fire time; anything you could not do directly is refused. A fire missed while the backend was down runs once on return if no more than catchUpMinutes late (default 15), otherwise it is skipped. Reuse requestId when retrying. Returns scheduleId and nextFireAt; then finish your turn.",
      inputSchema: z.object({
        ...caller,
        requestId: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(120).optional(),
        at: z.string().trim().min(1).max(64).optional(),
        cron: z.string().trim().min(1).max(200).optional(),
        everyMinutes: z
          .number()
          .int()
          .min(1)
          .max(366 * 24 * 60)
          .optional(),
        startAt: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe("With everyMinutes: the first fire."),
        timeZone: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe(`IANA zone; default ${zone}.`),
        catchUpMinutes: z
          .number()
          .int()
          .min(0)
          .max(7 * 24 * 60)
          .optional(),
        action: actionSchema(surface),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ requestId, everyMinutes, action, tabId, ...timing }) => {
      const created = await available().create(
        {
          ...timing,
          ...(everyMinutes !== undefined ? { everySeconds: everyMinutes * 60 } : {}),
          action: scheduleActionFromTool(action as ActionInput),
        },
        requestId,
        typeof tabId === "string" ? tabId : undefined,
      );
      return textResult({ ...scheduleView(created.schedule), replayed: created.replayed });
    },
  );
  server.registerTool(
    "list_schedules",
    {
      title: "List your schedules",
      description:
        "List the schedules you created: when each fires next, its state and its last outcome.",
      inputSchema: z.object({ ...caller }),
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
      inputSchema: z.object({ ...caller, scheduleId: z.string().trim().min(1).max(100) }),
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
}
