/**
 * The script of the coordinator restart fake model
 * (`coordinator-restart-fake-model.ts`, to-do 4680 (retired) task 2): a Pi coordinator
 * on a loopback model starts a build, the build's worker turn stops on a usage
 * limit, and the coordinator restarts the failed step from the status wake.
 * Pure, so the rules have unit tests that need no provider.
 *
 * Requests arrive in OpenAI chat-completions form, which Pi uses for a
 * provider declared with `api: "openai-completions"`.
 *
 * - The build request (it names {@link BUILD_MARKER}, and optionally
 *   `nodeId: <id>`): `get_launch_options`, then `create_ticket`, then
 *   `start_build_pipeline` for that ticket on the saved defaults, each with the
 *   `nodeId` when the prompt names one, then one line of text.
 * - A wake (a peer-message carrier) that reports a build pipeline as failed
 *   and offers `restart_build_pipeline_step`: for a pipeline this conversation
 *   has not restarted, `restart_build_pipeline_step` with the pipeline and
 *   node the notice names and omitted `stepId`. For one it restarted once, the
 *   same call again under the same `requestId`, as a model retrying after a
 *   lost answer would; the product must replay rather than restart twice.
 *   After that, one line of text.
 * - Any other wake: one line of text. What each wake said is counted
 *   ({@link WakeFacts}), and what each restart answered ({@link RestartFacts}).
 * - Anything that is not the coordinator (it is not offered
 *   `start_build_pipeline`), which here is the build's own Pi session: a
 *   usage-limit refusal ({@link usageLimitRefusal}), so the step stops the way
 *   a real plan limit stops it.
 */

export type ChatMessage = {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
};

export type FakeStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "usage-limit" };

/** Facts about one wake prompt, counted by the server. Never its text. */
export interface WakeFacts {
  /** Build pipelines the wake reports as failed. */
  failedPipelines: string[];
  /** The wake mentions a usage limit (the failed step's error or a limit notice). */
  usageLimit: boolean;
  /** It offers `restart_build_pipeline_step`. */
  offersRestart: boolean;
  /** The offered restart names a `nodeId`. */
  restartNamesNode: boolean;
  /** This conversation had already restarted every pipeline the wake reports failed. */
  restartedBefore: boolean;
}

/** Facts about one `restart_build_pipeline_step` answer. Never its text. */
export interface RestartFacts {
  pipelineId: string;
  /** The call was a retry under the same `requestId`. */
  replay: boolean;
  restarted?: boolean;
  alreadyRestarted?: boolean;
  /** The answer was the receipt's replay of an earlier one (`replayed: true`). */
  replayed?: boolean;
  phase?: string;
  followed?: boolean;
  onNode?: boolean;
  /** The answer said the step failed again at once. */
  failedAgain: boolean;
  /** The tool answered with an error instead of a result. */
  error: boolean;
}

export interface ScriptedTurn {
  step: FakeStep;
  /** Set on the first request of a wake turn only, so each wake counts once. */
  wake?: WakeFacts;
  /** Set on the request that follows a restart call's answer. */
  restart?: RestartFacts;
}

export const FAKE_REPLY = "Done.";
export const FAKE_BUILD_REPLY = "Started a build for it.";
export const FAKE_WAKE_REPLY = "Noted.";
export const FAKE_RESTART_REPLY = "Restarted the failed step.";
export const BUILD_MARKER = "wrapIndex";

/**
 * What the build's worker gets: the wording of a real plan limit, including
 * OpenAI's `insufficient_quota`, which Pi's SDK treats as not retryable, and
 * "usage limit", which Orkestrator's classifier reads as a usage-limit stop.
 */
export const USAGE_LIMIT_MESSAGE =
  "You've hit your usage limit (insufficient_quota). Try again at 3pm.";

export function usageLimitRefusal(): { status: number; body: Record<string, unknown> } {
  return {
    status: 429,
    body: {
      error: {
        message: USAGE_LIMIT_MESSAGE,
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    },
  };
}

const CARRIER = "<orkestrator-peer-message";
const PAYLOAD = /<orkestrator-peer-payload-json>\n([\s\S]*?)\n<\/orkestrator-peer-payload-json>/g;
const PROJECT_ID = /Project: [^\n]*?\(id ([A-Za-z0-9_-]{1,200})\)/;
const PROMPT_NODE = /\bnodeId: ([A-Za-z0-9_-]{1,200})/;
const COMMIT = /^[0-9a-f]{40}$/i;
const RESTART_OFFER = /restart_build_pipeline_step \{[^\n}]*\}/g;
const RESTART_TOOL = "restart_build_pipeline_step";

/** One mail carrier's payload as a wake prompt carries it (`renderAgentMailCarrier`). */
export interface CarrierPayload {
  subject?: string;
  body?: string;
  notice?: { resource?: { kind?: unknown; id?: unknown; nodeId?: unknown }; state?: unknown };
}

/** Every carrier payload in a wake prompt; one wake may batch several. */
export function carrierPayloads(prompt: string): CarrierPayload[] {
  const payloads: CarrierPayload[] = [];
  for (const match of prompt.matchAll(PAYLOAD)) {
    try {
      const value = record(JSON.parse(match[1]!));
      if (value) payloads.push(value as CarrierPayload);
    } catch {
      // A payload that does not parse says nothing countable.
    }
  }
  return payloads;
}

export function messageText(message: ChatMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

export function offeredTools(tools: unknown): string[] {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => (tool as { function?: { name?: unknown } } | null)?.function?.name)
    .filter((name): name is string => typeof name === "string");
}

/** The name the runtime offers for an Orkestrator tool: bare, or MCP-prefixed (`mcp_orkestrator_<tool>`). */
export function offeredName(offered: readonly string[], tool: string): string | undefined {
  return (
    offered.find((name) => name === tool) ??
    offered.find((name) => name.endsWith(`__${tool}`) || name.endsWith(`orkestrator_${tool}`))
  );
}

/** The first JSON object in a tool result, or undefined. */
export function resultJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Each restart the notice offers: its pipeline and, for another node's, the node. */
export function restartOffers(text: string): Array<{ pipelineId: string; nodeId?: string }> {
  const offers: Array<{ pipelineId: string; nodeId?: string }> = [];
  for (const match of text.matchAll(RESTART_OFFER)) {
    const line = match[0];
    const pipelineId = /"pipelineId": "([A-Za-z0-9_-]{1,200})"/.exec(line)?.[1];
    const nodeId = /"nodeId": "([A-Za-z0-9_-]{1,200})"/.exec(line)?.[1];
    if (pipelineId) offers.push({ pipelineId, ...(nodeId ? { nodeId } : {}) });
  }
  return offers;
}

/** The restart calls this conversation already made, by pipeline. */
export function earlierRestarts(messages: readonly ChatMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls as Array<{
      function?: { name?: unknown; arguments?: unknown };
    }>) {
      const name = call?.function?.name;
      if (typeof name !== "string" || !(name === RESTART_TOOL || name.endsWith(`_${RESTART_TOOL}`)))
        continue;
      const raw = call.function?.arguments;
      let input: Record<string, unknown> | undefined;
      try {
        input = record(typeof raw === "string" ? JSON.parse(raw) : raw);
      } catch {
        input = undefined;
      }
      const pipelineId = typeof input?.pipelineId === "string" ? input.pipelineId : undefined;
      if (pipelineId) counts.set(pipelineId, (counts.get(pipelineId) ?? 0) + 1);
    }
  }
  return counts;
}

export function restartRequestId(pipelineId: string): string {
  return `restart-fake-${pipelineId}`.slice(0, 256);
}

/** The build pipelines the wake's notices report as failed. */
export function failedPipelines(payloads: readonly CarrierPayload[]): string[] {
  const ids = payloads
    .filter(
      (payload) =>
        payload.notice?.resource?.kind === "build-pipeline" && payload.notice.state === "failed",
    )
    .map((payload) => payload.notice?.resource?.id)
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)];
}

function payloadText(payloads: readonly CarrierPayload[]): string {
  return payloads.map((payload) => `${payload.subject ?? ""}\n${payload.body ?? ""}`).join("\n");
}

function wakeFacts(payloads: readonly CarrierPayload[], restarted: Map<string, number>): WakeFacts {
  const failed = failedPipelines(payloads);
  const text = payloadText(payloads);
  const offers = restartOffers(text);
  return {
    failedPipelines: failed,
    usageLimit: /usage limit/i.test(text),
    offersRestart: offers.length > 0,
    restartNamesNode: offers.some((offer) => offer.nodeId !== undefined),
    restartedBefore: failed.length > 0 && failed.every((id) => (restarted.get(id) ?? 0) > 0),
  };
}

function restartFacts(pipelineId: string, replay: boolean, result: string): RestartFacts {
  const json = resultJson(result);
  const facts: RestartFacts = {
    pipelineId,
    replay,
    failedAgain: typeof json?.nextStep === "string" && json.nextStep.includes("failed again"),
    error: !json || typeof json.pipelineId !== "string",
  };
  if (typeof json?.restarted === "boolean") facts.restarted = json.restarted;
  if (json?.alreadyRestarted === true) facts.alreadyRestarted = true;
  if (json?.replayed === true) facts.replayed = true;
  if (typeof json?.phase === "string") facts.phase = json.phase;
  if (typeof json?.followed === "boolean") facts.followed = json.followed;
  if (typeof json?.nodeId === "string" || record(json?.node)) facts.onNode = true;
  return facts;
}

const ACCEPTANCE = [
  "- wrapIndex returns the index wrapped into 0 to length - 1, also for negative input.",
  "- The new tests and the project's existing bun test suite pass.",
].join("\n");

/** The next step of a request. */
export function scriptedTurn(request: { messages: unknown; tools?: unknown }): ScriptedTurn {
  const list = Array.isArray(request.messages) ? (request.messages as ChatMessage[]) : [];
  const offered = offeredTools(request.tools);
  if (!offeredName(offered, "start_build_pipeline")) return { step: { kind: "usage-limit" } };

  let lastUser = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const prompt = messageText(list[lastUser]);
  const results = (lastUser < 0 ? [] : list.slice(lastUser + 1))
    .filter((message) => message?.role === "tool")
    .map(messageText);
  const tool = (name: string, input: Record<string, unknown>): FakeStep => {
    const offeredAs = offeredName(offered, name);
    return offeredAs
      ? { kind: "tool", name: offeredAs, input }
      : { kind: "text", text: `The ${name} tool is not offered.` };
  };

  if (prompt.includes(CARRIER)) {
    // Restarts made before this wake turn decide what it does.
    const before = earlierRestarts(lastUser < 0 ? [] : list.slice(0, lastUser));
    const payloads = carrierPayloads(prompt);
    const wake = wakeFacts(payloads, before);
    const first = results.length === 0 ? { wake } : {};
    const offer = restartOffers(payloadText(payloads)).find((candidate) =>
      wake.failedPipelines.includes(candidate.pipelineId),
    );
    if (!offer) return { step: { kind: "text", text: FAKE_WAKE_REPLY }, ...first };
    const replay = (before.get(offer.pipelineId) ?? 0) > 0;
    // One restart, then one same-key retry; never a third call.
    if ((before.get(offer.pipelineId) ?? 0) >= 2)
      return { step: { kind: "text", text: FAKE_WAKE_REPLY }, ...first };
    if (results.length === 0) {
      return {
        step: tool(RESTART_TOOL, {
          requestId: restartRequestId(offer.pipelineId),
          pipelineId: offer.pipelineId,
          ...(offer.nodeId ? { nodeId: offer.nodeId } : {}),
        }),
        ...first,
      };
    }
    return {
      step: { kind: "text", text: replay ? FAKE_WAKE_REPLY : FAKE_RESTART_REPLY },
      restart: restartFacts(offer.pipelineId, replay, results[0]!),
    };
  }
  if (!prompt.includes(BUILD_MARKER)) return { step: { kind: "text", text: FAKE_REPLY } };

  const context = list
    .slice(0, lastUser + 1)
    .filter((message) => message?.role === "system" || message?.role === "user")
    .map(messageText)
    .join("\n");
  const projectId = PROJECT_ID.exec(context)?.[1];
  const nodeId = PROMPT_NODE.exec(prompt)?.[1];
  const onNode = nodeId ? { nodeId } : {};
  const title = "Add wrapIndex with tests";
  if (!projectId) return { step: { kind: "text", text: "No project id in the context." } };
  if (results.length === 0) return { step: tool("get_launch_options", { projectId, ...onNode }) };
  if (results.length === 1)
    return {
      step: tool("create_ticket", {
        requestId: `restart-fake-ticket${nodeId ? "-node" : ""}`,
        projectId,
        title,
        description: prompt.slice(0, 4_000),
        acceptanceCriteria: ACCEPTANCE,
        status: "in-progress",
      }),
    };
  if (results.length === 2) {
    const base = record(resultJson(results[0]!)?.coordinatorBase);
    const ticket = record(resultJson(results[1]!)?.ticket);
    const baseBranch = typeof base?.baseBranch === "string" ? base.baseBranch : undefined;
    const baseCommit = typeof base?.baseCommit === "string" ? base.baseCommit : undefined;
    const taskId = typeof ticket?.id === "string" ? ticket.id : undefined;
    if (!baseBranch || !baseCommit || !COMMIT.test(baseCommit) || !taskId)
      return {
        step: { kind: "text", text: "The launch base or the ticket could not be read." },
      };
    return {
      step: tool("start_build_pipeline", {
        requestId: `restart-fake-build${nodeId ? "-node" : ""}`,
        taskId,
        baseBranch,
        baseCommit,
        taskTitle: title,
        taskSnapshot: {
          title,
          description: prompt.slice(0, 4_000),
          acceptanceCriteria: ACCEPTANCE,
        },
        ...onNode,
      }),
    };
  }
  return { step: { kind: "text", text: FAKE_BUILD_REPLY } };
}
