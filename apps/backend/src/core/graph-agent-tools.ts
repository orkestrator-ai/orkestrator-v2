/**
 * The extra tools on a graph agent activation's credential (item 204, report
 * §5.5, §6.5): `report_progress` when an output type has `items`,
 * `read_artifact` when an input renders `on-demand`, and `ask_human` on nodes
 * that opt in (D15). The result tools themselves (`submit_<port>`,
 * `validate_<port>`, the status tool) come from the workflow result service;
 * the opt-in Orkestrator groups (tickets, mail, schedules) are the agent
 * tools server's own, registered for the groups this host names. Transcript
 * artifacts use the per-turn artifact grant of workflow turns.
 *
 * Every tool resolves its activation from the credential's result keys, so a
 * credential reaches only its own activation, and a tool exists only when the
 * node's grants include it. OpenCode's persistent broker has a fixed tool
 * list, so it lists the three tools always and authorizes each call by the
 * capability argument instead.
 *
 * Bounded: `read_artifact` returns at most {@link GRAPH_READ_ARTIFACT_MAX_BYTES}
 * of JSON, only from artifacts the activation was given, and verifies each
 * before reading; progress entries are bounded in size and count; logs carry
 * no payloads.
 */
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { NativeAgentOrkestratorCapabilityGroup } from "@orkestrator/protocol/native-agent";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import type { GraphPlanAgentNode } from "@orkestrator/protocol/graphs/compile";
import { graphPromptSchemaChild } from "@orkestrator/protocol/graphs/prompts";
import {
  GRAPH_AGENT_PROGRESS_BOUNDS,
  GRAPH_AGENT_QUESTION_BOUNDS,
  type GraphAgentProgressItem,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";
import { validateWorkflowJsonSchema } from "@orkestrator/protocol/workflow-json-schema";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import { graphInputItemIds } from "./graph-agent-prompt.js";
import {
  GraphAgentQuestionError,
  graphAnswerEvidence,
  graphAnswerGuidance,
  type GraphAgentQuestions,
} from "./graph-agent-questions.js";
import type { GraphRunService } from "./graph-run-service.js";

/** JSON bytes one `read_artifact` call returns at most. */
export const GRAPH_READ_ARTIFACT_MAX_BYTES = 64 * 1024;
/** Path segments a `read_artifact` path may have. */
const MAX_PATH_SEGMENTS = 16;
/** Progress entries buffered per activation between passes. */
const MAX_INBOX_PER_ACTIVATION = GRAPH_AGENT_PROGRESS_BOUNDS.maxItems;
const MAX_INBOX_ACTIVATIONS = 1_024;

export const GRAPH_ACTIVATION_TOOL_NAMES = Object.freeze({
  reportProgress: "report_progress",
  readArtifact: "read_artifact",
  askHuman: "ask_human",
} as const);

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: true;
};

function response(value: Record<string, unknown>, error = false): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(error ? { isError: true as const } : {}),
  };
}

function refusal(code: string, message: string): ToolResponse {
  return response({ ok: false, error: { code, message } }, true);
}

/**
 * Provisional `report_progress` entries waiting for the activation's next
 * observation, which folds them into the session. In memory and bounded:
 * progress is never consumed downstream, so an entry lost to a restart costs
 * only a line of progress.
 */
export class GraphAgentProgressInbox {
  private readonly entries = new Map<string, GraphAgentProgressItem[]>();

  private key(runId: string, activationKey: string): string {
    return `${runId}\0${activationKey}`;
  }

  add(runId: string, activationKey: string, entry: GraphAgentProgressItem): boolean {
    const key = this.key(runId, activationKey);
    let list = this.entries.get(key);
    if (!list) {
      if (this.entries.size >= MAX_INBOX_ACTIVATIONS) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      list = [];
      this.entries.set(key, list);
    }
    if (list.some((existing) => existing.id === entry.id)) return true;
    if (list.length >= MAX_INBOX_PER_ACTIVATION) return false;
    list.push(entry);
    return true;
  }

  take(runId: string, activationKey: string): GraphAgentProgressItem[] {
    const key = this.key(runId, activationKey);
    const list = this.entries.get(key) ?? [];
    this.entries.delete(key);
    return list;
  }
}

/** Appends new entries to a session's progress, keeping the first ones (bounded). */
export function appendGraphAgentProgress(
  existing: readonly GraphAgentProgressItem[] | undefined,
  reported: readonly GraphAgentProgressItem[],
): GraphAgentProgressItem[] | undefined {
  if (reported.length === 0) return undefined;
  const next = [...(existing ?? [])];
  const seen = new Set(next.map((entry) => entry.id));
  for (const entry of reported) {
    if (seen.has(entry.id) || next.length >= GRAPH_AGENT_PROGRESS_BOUNDS.maxItems) continue;
    seen.add(entry.id);
    next.push(entry);
  }
  return next.length === (existing?.length ?? 0) ? undefined : next;
}

/** A resolved activation and what its credential may do. */
export interface GraphActivationToolSet {
  /** Orkestrator groups the agent tools server registers for this credential. */
  groups: NativeAgentOrkestratorCapabilityGroup[];
  /** Registers this activation's extra tools on a per-activation server. */
  register(server: McpServer): void;
}

/** Installed on the agent tools server (`setGraphActivationToolHost`). */
export interface GraphActivationToolHost {
  /** The tools of the activation owning `resultKeys`; null when they are not a live graph activation. */
  resolve(
    scope: { environmentId: string; projectId: string },
    resultKeys: readonly string[],
  ): Promise<GraphActivationToolSet | null>;
  /**
   * OpenCode's broker: registers the three tools with a `capability`
   * argument; `authenticate` returns the result keys a capability covers.
   */
  registerBroker(
    server: McpServer,
    scope: { environmentId: string; projectId: string },
    authenticate: (capability: string) => Promise<readonly string[] | null>,
  ): void;
}

export interface GraphAgentToolDependencies {
  runs: Pick<GraphRunService, "activationForResultKey" | "requestObservation">;
  artifacts: Pick<GraphArtifactStore, "verify">;
  questions: GraphAgentQuestions;
  progress: GraphAgentProgressInbox;
  clock?: () => Date;
}

type Located = { run: GraphRun; activation: NodeActivation; node: GraphPlanAgentNode };
type ToolGrants = Pick<
  GraphPlanAgentNode["grantedActions"],
  "reportProgress" | "readArtifact" | "askHuman"
>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** `issues.0.title`, `issues[0].title`, `$.issues[0]`: property names and indexes. */
export function graphArtifactPathSegments(path: string | undefined): string[] | null {
  if (path === undefined || path.trim() === "" || path.trim() === "$") return [];
  const normalized = path
    .trim()
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1");
  const segments = normalized.split(".").filter((segment) => segment.length > 0);
  if (segments.length > MAX_PATH_SEGMENTS) return null;
  if (segments.some((segment) => segment.length > 128 || segment === "__proto__")) return null;
  return segments;
}

function walk(value: unknown, segments: readonly string[]): { found: boolean; value: unknown } {
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current) && /^(?:0|[1-9][0-9]*)$/.test(segment)) {
      const index = Number(segment);
      if (index >= current.length) return { found: false, value: undefined };
      current = current[index];
      continue;
    }
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      Object.hasOwn(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return { found: false, value: undefined };
  }
  return { found: true, value: current };
}

/** One bounded read of an artifact value (or a part of it). */
export function readGraphArtifactValue(
  value: unknown,
  path: string | undefined,
): Record<string, unknown> {
  const segments = graphArtifactPathSegments(path);
  if (!segments) return { ok: false, error: { code: "invalid_path", message: "Unsupported path" } };
  const found = walk(value, segments);
  if (!found.found) {
    return { ok: false, error: { code: "not_found", message: "Nothing at that path" } };
  }
  const json = JSON.stringify(found.value ?? null);
  const bytes = Buffer.byteLength(json, "utf8");
  const shape = Array.isArray(found.value)
    ? { length: found.value.length }
    : found.value && typeof found.value === "object"
      ? { fields: Object.keys(found.value).slice(0, 64) }
      : {};
  if (bytes <= GRAPH_READ_ARTIFACT_MAX_BYTES) {
    return { ok: true, path: segments.join("."), bytes, ...shape, value: found.value ?? null };
  }
  // Too large for one read: say so, with the shape, and let the agent narrow.
  return {
    ok: true,
    path: segments.join("."),
    bytes,
    truncated: true,
    ...shape,
    hint: `This part is ${bytes} bytes, more than one read returns (${GRAPH_READ_ARTIFACT_MAX_BYTES}). Read a narrower path, such as one field or one list element.`,
  };
}

export class GraphAgentToolHost implements GraphActivationToolHost {
  private readonly clock: () => Date;

  constructor(private readonly dependencies: GraphAgentToolDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  private async locate(
    scope: { environmentId: string; projectId: string },
    resultKeys: readonly string[],
  ): Promise<Located | null> {
    const first = resultKeys[0];
    if (!first) return null;
    const found = await this.dependencies.runs.activationForResultKey(scope.environmentId, first);
    if (!found || found.run.projectId !== scope.projectId) return null;
    const keys = new Set(Object.values(found.activation.session?.resultKeys ?? {}));
    if (!resultKeys.every((key) => keys.has(key))) return null;
    const node = found.run.plan.nodes.find((entry) => entry.id === found.activation.nodeId);
    if (!node || node.kind !== "agent") return null;
    return { ...found, node };
  }

  async resolve(
    scope: { environmentId: string; projectId: string },
    resultKeys: readonly string[],
  ): Promise<GraphActivationToolSet | null> {
    const located = await this.locate(scope, resultKeys);
    if (!located) return null;
    const actions = located.node.grantedActions;
    return {
      groups: actions.orkestrator
        .map((entry) => entry.group)
        .filter((group) => group !== "artifacts"),
      register: (server) => this.registerFor(server, scope, resultKeys, actions),
    };
  }

  /** The three tools on a per-activation server, gated by the node's grants. */
  private registerFor(
    server: McpServer,
    scope: { environmentId: string; projectId: string },
    resultKeys: readonly string[],
    grants: ToolGrants,
  ): void {
    // A tool exists only when the node's grants include it; each call
    // re-resolves the activation, which may have moved on (a new request, a
    // settled step) since the server was built.
    this.registerTools(server, async () => this.locate(scope, resultKeys), {
      withCapability: false,
      grants,
    });
  }

  registerBroker(
    server: McpServer,
    scope: { environmentId: string; projectId: string },
    authenticate: (capability: string) => Promise<readonly string[] | null>,
  ): void {
    this.registerTools(
      server,
      async (capability) => {
        if (!capability) return null;
        const keys = await authenticate(capability);
        return keys ? this.locate(scope, keys) : null;
      },
      { withCapability: true },
    );
  }

  private registerTools(
    server: McpServer,
    locate: (capability?: string) => Promise<Located | null>,
    /** `grants`: the node's; absent on the broker, whose tool list is fixed. */
    options: { withCapability: boolean; grants?: ToolGrants },
  ): void {
    const granted = {
      reportProgress: !options.grants || options.grants.reportProgress.length > 0,
      readArtifact: !options.grants || options.grants.readArtifact,
      askHuman: !options.grants || options.grants.askHuman,
    };
    // Broker tools take the signed capability as an argument; a per-activation
    // server's bearer already is the capability.
    const schema = (shape: z.ZodRawShape) =>
      z
        .object(
          options.withCapability ? { ...shape, capability: z.string().min(32).max(2_048) } : shape,
        )
        .strict();
    const annotations = (readOnly: boolean) => ({
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    if (granted.reportProgress)
      server.registerTool(
        GRAPH_ACTIVATION_TOOL_NAMES.reportProgress,
        {
          title: "Report progress",
          description:
            "Report one finished entry of an output's list (the output named by resultKey) as provisional progress while you work. The user sees it marked provisional; it is never passed to later steps, and the result you submit must still list every entry. Report each entry once.",
          inputSchema: schema({
            resultKey: z.string().min(1).max(128),
            item: z.record(z.string(), z.unknown()),
          }),
          annotations: annotations(false),
        },
        async (input: Record<string, unknown>) => {
          const args = input as {
            resultKey: string;
            capability?: string;
            item: Record<string, unknown>;
          };
          return this.reportProgress(await locate(args.capability), args.resultKey, args.item);
        },
      );

    if (granted.readArtifact)
      server.registerTool(
        GRAPH_ACTIVATION_TOOL_NAMES.readArtifact,
        {
          title: "Read an input artifact",
          description: `Read one of the input artifacts listed in your instructions by its id, optionally only a part of it by a field path such as "issues.0.title". Returns at most ${GRAPH_READ_ARTIFACT_MAX_BYTES} bytes of JSON; for a larger part it returns the part's shape so you can read a narrower path. Only the artifacts this step was given can be read.`,
          inputSchema: schema({
            id: z.string().regex(/^[a-f0-9]{64}$/),
            path: z.string().max(512).optional(),
          }),
          annotations: annotations(true),
        },
        async (input: Record<string, unknown>) => {
          const args = input as { id: string; path?: string; capability?: string };
          return this.readArtifact(await locate(args.capability), args.id, args.path);
        },
      );

    if (granted.askHuman)
      server.registerTool(
        GRAPH_ACTIVATION_TOOL_NAMES.askHuman,
        {
          title: "Ask the user",
          description:
            "Ask the user one question when you cannot continue without their answer. The step pauses until they answer; the answer comes back as this tool's result, or, if it takes longer, as your next message after you end your turn. Ask only what you cannot decide yourself, and keep the question short and self-contained.",
          inputSchema: schema({
            question: z.string().min(1).max(GRAPH_AGENT_QUESTION_BOUNDS.maxQuestionChars),
            choices: z
              .array(z.string().min(1).max(GRAPH_AGENT_QUESTION_BOUNDS.maxChoiceChars))
              .min(2)
              .max(GRAPH_AGENT_QUESTION_BOUNDS.maxChoices)
              .optional(),
          }),
          annotations: { ...annotations(false), idempotentHint: false },
        },
        async (input: Record<string, unknown>, context: { mcpReq: { signal: AbortSignal } }) => {
          const args = input as { question: string; choices?: string[]; capability?: string };
          return this.askHuman(await locate(args.capability), args, context.mcpReq.signal);
        },
      );
  }

  private denied(): ToolResponse {
    return refusal(
      "capability_denied",
      "This tool connection belongs to no running step, or the step does not offer this tool.",
    );
  }

  private async reportProgress(
    located: Located | null,
    resultKey: string,
    item: Record<string, unknown>,
  ): Promise<ToolResponse> {
    if (!located) return this.denied();
    const { run, activation, node } = located;
    const port = Object.entries(activation.session?.resultKeys ?? {}).find(
      ([, key]) => key === resultKey,
    )?.[0];
    if (!port || !node.grantedActions.reportProgress.includes(port)) {
      return refusal(
        "not_a_progress_output",
        "That resultKey names no output of this step that takes progress entries.",
      );
    }
    const output = node.outputs.find((entry) => entry.name === port)!;
    const resolved = new GraphTypeLibrary(run.plan.types).resolve(output.type);
    const definition =
      resolved.ok && resolved.type.kind === "named" ? resolved.type.definition : undefined;
    if (!definition?.items) return refusal("not_a_progress_output", "The output has no list.");
    let element = definition.schema as Parameters<typeof graphPromptSchemaChild>[0];
    for (const segment of definition.items.path.split(".")) {
      element = graphPromptSchemaChild(element, segment);
    }
    element = graphPromptSchemaChild(element, "0");
    const canonical = canonicalJson(item);
    if (Buffer.byteLength(canonical, "utf8") > GRAPH_AGENT_PROGRESS_BOUNDS.maxItemBytes) {
      return refusal("too_large", "The entry is too large; report a shorter entry.");
    }
    if (element) {
      const issues = validateWorkflowJsonSchema(element as never, item);
      if (issues.length > 0) {
        return response(
          {
            ok: false,
            error: {
              code: "invalid_item",
              message: "The entry does not match the list's entry schema.",
              issues: issues.slice(0, 8),
            },
          },
          true,
        );
      }
    }
    const accepted = this.dependencies.progress.add(run.id, activation.key, {
      id: digest(`${port}\0${canonical}`),
      port,
      reportedAt: this.clock().toISOString(),
      item,
    });
    if (!accepted) {
      return refusal(
        "limit",
        `This step already reported ${GRAPH_AGENT_PROGRESS_BOUNDS.maxItems} entries; carry on without reporting more.`,
      );
    }
    this.dependencies.runs.requestObservation(run.id, activation.key);
    return response({ ok: true, provisional: true });
  }

  private async readArtifact(
    located: Located | null,
    id: string,
    path: string | undefined,
  ): Promise<ToolResponse> {
    if (!located || !located.node.grantedActions.readArtifact) return this.denied();
    const { run, activation } = located;
    const given = Object.values(activation.inputs).flatMap((ids) =>
      Array.isArray(ids) ? ids : [ids],
    );
    if (!given.includes(id)) {
      return refusal("not_an_input", "This step was not given that artifact.");
    }
    const verification = await this.dependencies.artifacts.verify(run.id, id);
    if (!verification.ok) {
      return refusal("unverified", `The artifact could not be verified (${verification.code}).`);
    }
    const artifact = verification.artifact;
    if ("file" in artifact.body) {
      return response({
        ok: true,
        id,
        type: artifact.type,
        file: artifact.body.file,
        ...(artifact.body.value !== undefined
          ? { descriptor: readGraphArtifactValue(artifact.body.value, path) }
          : {}),
        hint: "The file is in the workspace at the path above; read it there.",
      });
    }
    // The ids a consolidator cites, as its prompt shows them (item 205).
    const itemIds = graphInputItemIds(new GraphTypeLibrary(run.plan.types), artifact);
    return response({
      id,
      type: artifact.type,
      ...(itemIds.length > 0 ? { itemIds } : {}),
      ...readGraphArtifactValue(artifact.body.value, path),
    });
  }

  private async askHuman(
    located: Located | null,
    args: { question: string; choices?: string[] },
    signal: AbortSignal | undefined,
  ): Promise<ToolResponse> {
    if (!located || !located.node.askHuman) return this.denied();
    try {
      const outcome = await this.dependencies.questions.ask(
        { runId: located.run.id, activationKey: located.activation.key },
        { text: args.question, ...(args.choices ? { choices: args.choices } : {}) },
        { allowed: located.node.askHuman, ...(signal ? { signal } : {}) },
      );
      if (outcome.status === "answered") {
        const question = {
          id: outcome.questionId,
          text: args.question,
          askedAt: outcome.answer.at,
          requestId: located.activation.session?.requestId ?? "",
        };
        return response({
          ok: true,
          status: "answered",
          answer: graphAnswerEvidence(question, outcome.answer),
          guidance: graphAnswerGuidance(outcome.answer),
        });
      }
      return response({
        ok: true,
        status: "waiting",
        message:
          "The user has not answered yet. End your turn now without submitting anything else; Orkestrator sends the answer as your next message when it arrives. Do not ask again.",
      });
    } catch (error) {
      if (error instanceof GraphAgentQuestionError) return refusal(error.code, error.message);
      return refusal("storage_unavailable", "The question could not be recorded; try again.");
    }
  }
}
