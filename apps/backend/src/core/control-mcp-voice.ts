import type { McpServer } from "@modelcontextprotocol/server";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { publicSuccessEnvelope, type PublicActionName } from "@orkestrator/protocol/public-api";
import {
  decodePublicSessionId,
  encodePublicSessionId,
  type PublicAgentOptions,
  type PublicAttentionItem,
  type PublicAttentionPage,
  type PublicEnvironmentSummary,
  type PublicProjectSummary,
  type PublicSessionSummary,
  type PublicTranscriptPage,
} from "@orkestrator/protocol/public-api-resources";
import {
  allowed,
  readIfAllowed,
  runPublicAction,
  type ControlMcpCaller,
} from "./control-mcp-caller.js";
import { sayForEnvelope } from "./control-mcp-gateway.js";
import {
  resolveTarget,
  sessionAliases,
  type TargetCandidate,
  type TargetKind,
} from "./control-mcp-resolve.js";
import { integer, leanSchema, oneOf, text } from "./control-mcp-lean-schema.js";
import {
  adapterError,
  envelopeToolResult,
  voiceList,
  type ControlMcpEnvelope,
} from "./control-mcp-results.js";

/**
 * Tier 0: the voice core. A dozen tools shaped for spoken requests. A core
 * tool may compose several reads, but every mutation is exactly one public
 * action under the caller's `requestId`, so request keys, fingerprints and
 * receipts behave exactly as they do for the CLI. Nothing here turns one
 * intent into another: a busy session is never steered by `prompt_session`.
 */

/**
 * Each core tool, the public actions it uses, and when it is listed: when all
 * of them are allowed, or when any of `listedWith` is (a composed read that
 * degrades gracefully without the rest).
 */
export const VOICE_TOOL_ACTIONS: Readonly<
  Record<string, { actions: readonly PublicActionName[]; listedWith?: readonly PublicActionName[] }>
> = Object.freeze({
  overview: {
    actions: ["attention.list", "project.list", "environment.list", "session.list"],
    listedWith: ["attention.list", "project.list", "environment.list"],
  },
  resolve_target: {
    actions: ["project.list", "environment.list", "session.list"],
    listedWith: ["project.list", "environment.list"],
  },
  read_session: { actions: ["session.transcript"] },
  prompt_session: { actions: ["session.prompt"] },
  steer_session: { actions: ["session.steer"] },
  stop_session: { actions: ["session.stop"] },
  answer_question: { actions: ["session.interaction.resolve"] },
  start_work: {
    actions: ["environment.launch", "session.start", "agent.options"],
    listedWith: ["environment.launch", "session.start"],
  },
});

export const VOICE_CORE_TOOL_NAMES = Object.keys(VOICE_TOOL_ACTIONS);

export function voiceToolListed(caller: ControlMcpCaller, tool: string): boolean {
  const entry = VOICE_TOOL_ACTIONS[tool];
  if (!entry) return false;
  return entry.listedWith
    ? entry.listedWith.some((action) => allowed(caller, action))
    : entry.actions.every((action) => allowed(caller, action));
}

const REQUEST_ID = text("New per request; reuse only to retry it.");
const SESSION = {
  sessionId: text("ses_ handle, or pass environmentId and tabId."),
  environmentId: text(),
  tabId: text(),
};
type SessionArgs = { sessionId?: string; environmentId?: string; tabId?: string };

const OVERVIEW_INPUT = leanSchema<{ projectId?: string }>({ projectId: text() });
const RESOLVE_INPUT = leanSchema<{
  query: string;
  kind?: TargetKind;
  projectId?: string;
  environmentId?: string;
}>(
  {
    query: text("The spoken name."),
    kind: oneOf(["project", "environment", "session"]),
    projectId: text(),
    environmentId: text("Narrows sessions; enables first, second."),
  },
  ["query"],
);
const READ_INPUT = leanSchema<SessionArgs & { detail?: "brief" | "full" }>({
  ...SESSION,
  detail: oneOf(["brief", "full"]),
});
const PROMPT_INPUT = leanSchema<
  SessionArgs & { prompt: string; mode?: "plan" | "build"; requestId: string }
>({ ...SESSION, prompt: text(), mode: oneOf(["plan", "build"]), requestId: REQUEST_ID }, [
  "prompt",
  "requestId",
]);
const STEER_INPUT = leanSchema<
  SessionArgs & { text: string; expectedOperationId?: string; requestId: string }
>({ ...SESSION, text: text(), expectedOperationId: text(), requestId: REQUEST_ID }, [
  "text",
  "requestId",
]);
const STOP_INPUT = leanSchema<SessionArgs & { expectedOperationId?: string; requestId: string }>(
  { ...SESSION, expectedOperationId: text("Stop only this run."), requestId: REQUEST_ID },
  ["requestId"],
);
const ANSWER_ACTIONS = ["answer", "approve-for-session", "decline", "deny", "cancel"] as const;
const ANSWER_INPUT = leanSchema<
  SessionArgs & {
    interactionId: string;
    revision: number;
    action: (typeof ANSWER_ACTIONS)[number];
    answers?: Array<{ questionId: string; optionIds?: string[]; freeText?: string }>;
    feedback?: string;
    requestId: string;
    confirmToken?: string;
  }
>(
  {
    ...SESSION,
    interactionId: text(),
    revision: integer(0),
    action: oneOf(ANSWER_ACTIONS),
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionId: text(),
          optionIds: { type: "array", items: { type: "string" } },
          freeText: text(),
        },
        required: ["questionId"],
      },
    },
    feedback: text(),
    requestId: REQUEST_ID,
    confirmToken: text(),
  },
  ["interactionId", "revision", "action", "requestId"],
);
const START_INPUT = leanSchema<{
  prompt: string;
  projectId?: string;
  environmentId?: string;
  agent?: AgentPlatform;
  name?: string;
  requestId: string;
}>(
  {
    prompt: text(),
    projectId: text("New environment in this project."),
    environmentId: text("Or a new session in this ready environment."),
    agent: oneOf(AGENT_PLATFORMS),
    name: text("New environment's name."),
    requestId: REQUEST_ID,
  },
  ["prompt", "requestId"],
);

function sessionHandle(input: {
  sessionId?: string;
  environmentId?: string;
  tabId?: string;
}): string | null {
  if (input.sessionId) return decodePublicSessionId(input.sessionId) ? input.sessionId : null;
  if (input.environmentId && input.tabId) {
    return encodePublicSessionId(input.environmentId, input.tabId);
  }
  return null;
}

// Only the hints that differ from MCP's defaults (not read-only, destructive,
// not idempotent, open world), to keep the voice tool list small.
const mutationAnnotations = { idempotentHint: true } as const;
const readAnnotations = { readOnlyHint: true, openWorldHint: false } as const;

function success(tool: string, result: unknown): ControlMcpEnvelope {
  return publicSuccessEnvelope(tool, result) as ControlMcpEnvelope;
}

function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function attentionSentence(item: PublicAttentionItem): string {
  if (item.kind === "interaction") {
    return `${item.agent} in ${item.environmentName} is asking: ${short(item.title, 120)}`;
  }
  if (item.kind === "setup") {
    return `${item.environmentName} setup ${item.phase === "ready" ? "finished" : "failed"}`;
  }
  return `${item.action} ${item.state}${item.errorCode ? ` (${item.errorCode})` : ""}`;
}

async function allPages<T>(
  caller: ControlMcpCaller,
  action: "project.list" | "environment.list",
  input: Record<string, unknown> = {},
): Promise<T[] | null> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await readIfAllowed<{ items: T[]; nextCursor?: string }>(caller, action, {
      ...input,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (!result) return null;
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return items;
}

async function sessionsOf(
  caller: ControlMcpCaller,
  environments: readonly PublicEnvironmentSummary[],
): Promise<Array<{ environment: PublicEnvironmentSummary; sessions: PublicSessionSummary[] }>> {
  const scanned = environments.filter((environment) => environment.status === "running");
  const result: Array<{ environment: PublicEnvironmentSummary; sessions: PublicSessionSummary[] }> =
    [];
  // Bound concurrent metadata reads without excluding any environment.
  for (let offset = 0; offset < scanned.length; offset += 20) {
    result.push(
      ...(await Promise.all(
        scanned.slice(offset, offset + 20).map(async (environment) => ({
          environment,
          sessions:
            (
              await readIfAllowed<{ items: PublicSessionSummary[] }>(caller, "session.list", {
                environmentId: environment.id,
              })
            )?.items ?? [],
        })),
      )),
    );
  }
  return result;
}

async function overview(caller: ControlMcpCaller, projectId?: string) {
  const [projects, environments, attention] = await Promise.all([
    allPages<PublicProjectSummary>(caller, "project.list"),
    allPages<PublicEnvironmentSummary>(caller, "environment.list", projectId ? { projectId } : {}),
    readIfAllowed<PublicAttentionPage>(caller, "attention.list", { limit: 5 }),
  ]);
  const scoped = environments ?? [];
  const bySession = await sessionsOf(caller, scoped);
  const sessions = bySession.flatMap((entry) => entry.sessions);
  const counts = {
    projects: projects?.length ?? null,
    environments: {
      total: environments ? scoped.length : null,
      running: scoped.filter((environment) => environment.status === "running").length,
      ready: scoped.filter((environment) => environment.ready).length,
      error: scoped.filter((environment) => environment.status === "error").length,
    },
    sessions: {
      scanned: sessions.length,
      working: sessions.filter((entry) => entry.activity === "working").length,
      waiting: sessions.filter((entry) => entry.activity === "waiting").length,
    },
    attention: attention ? attention.counts : null,
  };
  const items = attention?.items ?? [];
  return {
    counts,
    attention: attention ? { items, more: attention.more, cursor: attention.cursor } : null,
    running: voiceList(
      scoped
        .filter((environment) => environment.status === "running")
        .map((environment) => ({
          environmentId: environment.id,
          name: environment.name,
          ready: environment.ready,
          activity: environment.activity.state,
        })),
    ),
  };
}

async function targetCandidates(
  caller: ControlMcpCaller,
  kind: TargetKind | undefined,
  scope: { projectId?: string; environmentId?: string },
): Promise<TargetCandidate[]> {
  const candidates: TargetCandidate[] = [];
  if (!kind || kind === "project") {
    for (const project of (await allPages<PublicProjectSummary>(caller, "project.list")) ?? []) {
      candidates.push({ kind: "project", id: project.id, name: project.name, aliases: [] });
    }
  }
  if (!kind || kind === "environment" || kind === "session") {
    const environments =
      (await allPages<PublicEnvironmentSummary>(
        caller,
        "environment.list",
        scope.projectId ? { projectId: scope.projectId } : {},
      )) ?? [];
    if (!kind || kind === "environment") {
      for (const environment of environments) {
        candidates.push({
          kind: "environment",
          id: environment.id,
          name: environment.name,
          aliases: [environment.branch],
          projectId: environment.projectId,
        });
      }
    }
    if (!kind || kind === "session") {
      const inScope = scope.environmentId
        ? environments.filter((environment) => environment.id === scope.environmentId)
        : environments;
      for (const { environment, sessions } of await sessionsOf(caller, inScope)) {
        sessions.forEach((entry, position) => {
          candidates.push({
            kind: "session",
            id: entry.id,
            name: entry.title ?? `${entry.agent} tab`,
            // Position only names a session inside one named environment.
            aliases: scope.environmentId
              ? sessionAliases(entry.agent, entry.title, position)
              : [entry.agent, ...(entry.title ? [entry.title] : [])],
            environmentId: environment.id,
            projectId: environment.projectId,
          });
        });
      }
    }
  }
  return candidates;
}

function candidateView(candidate: TargetCandidate) {
  return {
    kind: candidate.kind,
    id: candidate.id,
    name: candidate.name,
    ...(candidate.environmentId ? { environmentId: candidate.environmentId } : {}),
    ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
  };
}

async function defaultAgent(
  caller: ControlMcpCaller,
  scope: { projectId?: string; environmentId?: string },
): Promise<AgentPlatform | null> {
  const options = await readIfAllowed<PublicAgentOptions>(
    caller,
    "agent.options",
    scope.environmentId ? { environmentId: scope.environmentId } : { projectId: scope.projectId },
  );
  if (!options) return null;
  const enabled = options.agents.filter((agent) => agent.enabled).map((agent) => agent.agent);
  return enabled.includes(options.defaultAgent) ? options.defaultAgent : (enabled[0] ?? null);
}

export function registerVoiceTools(server: McpServer, caller: ControlMcpCaller): void {
  const profile = caller.profile;
  const listed = (tool: string) => voiceToolListed(caller, tool);
  const sessionMissing = (action: string) =>
    envelopeToolResult(
      adapterError(action, "invalid-input", "Pass sessionId, or environmentId with tabId"),
      profile,
    );

  if (listed("overview")) {
    server.registerTool(
      "overview",
      {
        description:
          "Counts of projects, environments and sessions, plus the top 5 things needing attention (questions, approvals, finished or failed runs and setups).",
        inputSchema: OVERVIEW_INPUT,
        annotations: readAnnotations,
      },
      async ({ projectId }) => {
        const result = await overview(caller, projectId);
        const items = result.attention?.items ?? [];
        const running = result.counts.environments.running;
        const say = [
          `${running} environment${running === 1 ? "" : "s"} running, ${result.counts.sessions.working} working.`,
          items.length
            ? `Needs attention: ${items.map(attentionSentence).join("; ")}${result.attention?.more ? `; and ${result.attention.more} more` : ""}.`
            : "Nothing needs attention.",
        ].join(" ");
        const first = items[0];
        return envelopeToolResult(success("overview", result), profile, {
          say,
          ...(first && first.kind === "interaction"
            ? {
                ids: {
                  sessionId: first.sessionId,
                  interactionId: first.interactionId,
                  revision: first.revision,
                },
              }
            : {}),
        });
      },
    );
  }

  if (listed("resolve_target")) {
    server.registerTool(
      "resolve_target",
      {
        description:
          "Turn a spoken name ('the auth environment', 'the Codex tab') into an ID. Never guesses: anything but one exact match returns ambiguous-target with candidates to ask about.",
        inputSchema: RESOLVE_INPUT,
        annotations: readAnnotations,
      },
      async ({ query, kind, projectId, environmentId }) => {
        const resolution = resolveTarget(
          query,
          await targetCandidates(caller, kind, { projectId, environmentId }),
        );
        if (resolution.status === "resolved") {
          const target = candidateView(resolution.target);
          return envelopeToolResult(success("resolve_target", { target }), profile, {
            say: `That is ${target.kind} ${target.name}.`,
            ids: { [`${target.kind}Id`]: target.id },
          });
        }
        if (resolution.status === "ambiguous") {
          const candidates = resolution.candidates.map(candidateView);
          return envelopeToolResult(
            adapterError(
              "resolve_target",
              "ambiguous-target",
              "More than one match, or no exact match",
              {
                candidates,
              },
            ),
            profile,
            {
              say: `I'm not sure which you mean: ${candidates.map((candidate) => candidate.name).join(", ")}.`,
            },
          );
        }
        return envelopeToolResult(
          adapterError("resolve_target", "not-found", `Nothing is called ${short(query, 80)}`),
          profile,
        );
      },
    );
  }

  if (listed("read_session")) {
    server.registerTool(
      "read_session",
      {
        description:
          "The latest messages of an agent session: brief (default) is the last 3, about 600 characters each; full is the last 10.",
        inputSchema: READ_INPUT,
        annotations: readAnnotations,
      },
      async (input) => {
        const sessionId = sessionHandle(input);
        if (!sessionId) return sessionMissing("session.transcript");
        const brief = (input.detail ?? "brief") === "brief";
        const envelope = await runPublicAction(
          caller,
          "session.transcript",
          { sessionId, limit: brief ? 3 : 10 },
          undefined,
          undefined,
        );
        if (!envelope.ok) return envelopeToolResult(envelope, profile, sayForEnvelope(envelope));
        const page = envelope.result as PublicTranscriptPage;
        const maxChars = brief ? 600 : 2_000;
        const messages = page.messages.map((message) => ({
          id: message.id,
          role: message.role,
          createdAt: message.createdAt,
          text:
            message.text.length > maxChars
              ? `${message.text.slice(0, maxChars - 1)}…`
              : message.text,
          truncated: message.textTruncated || message.text.length > maxChars,
        }));
        const bounded = {
          ...envelope,
          result: {
            sessionId: page.sessionId,
            messages,
            complete: page.complete,
            freshness: page.freshness,
            ...(page.olderCursor ? { olderCursor: page.olderCursor } : {}),
          },
        } as ControlMcpEnvelope;
        const last = messages.at(-1);
        return envelopeToolResult(bounded, profile, {
          say: last
            ? `Latest ${last.role} message: ${short(last.text, brief ? 400 : 1_200)}`
            : "The session has no messages yet.",
          ids: { sessionId },
        });
      },
    );
  }

  if (listed("prompt_session")) {
    server.registerTool(
      "prompt_session",
      {
        description:
          "Send a new prompt to an idle agent session. A busy session is refused; use steer_session to add guidance to a running turn.",
        inputSchema: PROMPT_INPUT,
        annotations: mutationAnnotations,
      },
      async ({ prompt, mode, requestId: key, ...target }) => {
        const sessionId = sessionHandle(target);
        if (!sessionId) return sessionMissing("session.prompt");
        const envelope = await runPublicAction(
          caller,
          "session.prompt",
          { sessionId, prompt, ...(mode ? { mode } : {}) },
          key,
          undefined,
        );
        return envelopeToolResult(envelope, profile, {
          ...sayForEnvelope(envelope),
          ...(envelope.ok ? { say: "Sent. I'll report when it finishes." } : {}),
        });
      },
    );
  }

  if (listed("steer_session")) {
    server.registerTool(
      "steer_session",
      {
        description: "Add guidance to the turn an agent is running now.",
        inputSchema: STEER_INPUT,
        annotations: mutationAnnotations,
      },
      async ({ text, expectedOperationId, requestId: key, ...target }) => {
        const sessionId = sessionHandle(target);
        if (!sessionId) return sessionMissing("session.steer");
        const envelope = await runPublicAction(
          caller,
          "session.steer",
          { sessionId, text, ...(expectedOperationId ? { expectedOperationId } : {}) },
          key,
          undefined,
        );
        return envelopeToolResult(envelope, profile, {
          ...sayForEnvelope(envelope),
          ...(envelope.ok ? { say: "Guidance added to the running turn." } : {}),
        });
      },
    );
  }

  if (listed("stop_session")) {
    server.registerTool(
      "stop_session",
      {
        description:
          "Stop the turn an agent session is running. Pass expectedOperationId to stop only that run.",
        inputSchema: STOP_INPUT,
        annotations: mutationAnnotations,
      },
      async ({ expectedOperationId, requestId: key, ...target }) => {
        const sessionId = sessionHandle(target);
        if (!sessionId) return sessionMissing("session.stop");
        const envelope = await runPublicAction(
          caller,
          "session.stop",
          { sessionId, ...(expectedOperationId ? { expectedOperationId } : {}) },
          key,
          undefined,
        );
        return envelopeToolResult(envelope, profile, {
          ...sayForEnvelope(envelope),
          ...(envelope.ok ? { say: "Stopping it." } : {}),
        });
      },
    );
  }

  if (listed("answer_question")) {
    server.registerTool(
      "answer_question",
      {
        description:
          "Resolve a pending interaction at its revision. answer approves an approval or answers questions; deny and cancel refuse. Approvals return confirmation-required first: read it aloud, get a yes, repeat with confirmToken.",
        inputSchema: ANSWER_INPUT,
        annotations: mutationAnnotations,
      },
      async ({
        interactionId,
        revision,
        action,
        answers,
        feedback,
        requestId: key,
        confirmToken,
        ...target
      }) => {
        const sessionId = sessionHandle(target);
        if (!sessionId) return sessionMissing("session.interaction.resolve");
        const envelope = await runPublicAction(
          caller,
          "session.interaction.resolve",
          {
            sessionId,
            interactionId,
            expectedRevision: revision,
            action,
            ...(answers ? { answers } : {}),
            ...(feedback ? { feedback } : {}),
          },
          key,
          confirmToken,
        );
        return envelopeToolResult(envelope, profile, {
          ...sayForEnvelope(envelope),
          ...(envelope.ok
            ? {
                say:
                  action === "answer" || action === "approve-for-session"
                    ? "Done; the agent continues."
                    : "Refused; the agent was told.",
              }
            : {}),
        });
      },
    );
  }

  if (listed("start_work")) {
    server.registerTool(
      "start_work",
      {
        description:
          "Start an agent on a prompt: in a new environment of projectId, or as a new session in the ready environment environmentId. agent defaults to the configured one.",
        inputSchema: START_INPUT,
        annotations: mutationAnnotations,
      },
      async ({ prompt, projectId, environmentId, agent, name, requestId: key }) => {
        if (Boolean(projectId) === Boolean(environmentId)) {
          return envelopeToolResult(
            adapterError("start_work", "invalid-input", "Pass projectId or environmentId"),
            profile,
          );
        }
        const chosen = agent ?? (await defaultAgent(caller, { projectId, environmentId }));
        if (!chosen) {
          return envelopeToolResult(
            adapterError("start_work", "capability-unavailable", "No agent is enabled"),
            profile,
          );
        }
        const envelope = environmentId
          ? await runPublicAction(
              caller,
              "session.start",
              { environmentId, agent: chosen, prompt },
              key,
              undefined,
            )
          : await runPublicAction(
              caller,
              "environment.launch",
              { projectId, type: "local", agent: chosen, prompt, ...(name ? { name } : {}) },
              key,
              undefined,
            );
        const result = envelope.ok ? (envelope.result as Record<string, unknown>) : {};
        return envelopeToolResult(envelope, profile, {
          ...sayForEnvelope(envelope),
          ...(envelope.ok
            ? {
                say: `Started ${chosen}${environmentId ? "" : " in a new environment"}. I'll report when it finishes.`,
                ids: {
                  environmentId: (result.environmentId as string | undefined) ?? environmentId,
                  sessionId: result.sessionId as string | undefined,
                },
              }
            : {}),
        });
      },
    );
  }
}
