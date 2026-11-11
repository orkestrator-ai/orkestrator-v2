/**
 * Workflow results, structured output and Orkestrator's MCP connections on
 * OpenCode 2.x sessions (docs/todo/agent-engines/0008-opencode-v2.md, phase 5;
 * task 4: structured output moves to the workflow-result MCP tool).
 *
 * A result turn is the 1.x broker's, on 2.x mechanisms:
 *
 * - its `agentMcp` is the environment's broker credential (the same one
 *   `workflowResultConnection(…, "opencode")` issues for 1.x), registered as
 *   the location's `orkestrator_workflow_result` server (`mcp.ts`), and the
 *   prompt carries the attempt's signed capability, as on 1.x;
 * - the turn's own tools are granted for the turn only and restored after
 *   (`turn-grants.ts`); outside its turn every session's rules deny them, so
 *   another session, a later turn or a sub-agent cannot submit.
 *
 * A `schema` turn without a result tool (`structured-output-v1`) keeps 1.x's
 * shape: the prompt asks for one final JSON value and `structured` parses the
 * run's last answer once the run has settled.
 *
 * Any other `agentMcp` is a tab's (or a pipeline worker's) own Orkestrator
 * connection, registered as that session's `orkestrator_tab_<id>` server,
 * with its design server beside it when the connection says `design`. A
 * turn's `agentMcp.artifacts` grant becomes the session's artifact-only
 * server (`turn-connections.ts` decides which turns carry one).
 */
import type { NativeAgentMcpServerAction } from "@orkestrator/protocol/native-agent";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  PromptRejectedError,
  ProviderDispatchPreparationError,
  type ProviderPrepareDispatchOptions,
  type ProviderSendOptions,
} from "../agent-provider-contract.js";
import { openCodeStructuredPrompt, parseOpenCodeStructuredText } from "../opencode-messages.js";
import {
  isOpenCodeWorkflowResultToolName,
  openCodeWorkflowResultTurnProblem,
} from "../opencode-provider-helpers.js";
import type { OpenCode2McpServers } from "./mcp.js";
import { OPENCODE2_ARTIFACTS_MCP_PREFIX, OPENCODE2_DESIGN_MCP_PREFIX } from "./permissions.js";
import type { OpenCode2TurnGrants } from "./turn-grants.js";
import {
  isOpenCode2IdleMessage,
  type OpenCode2AssistantMessage,
  type OpenCode2IdleMessage,
  type OpenCode2Message,
} from "./types.js";

type TurnOptions = ProviderPrepareDispatchOptions &
  Pick<ProviderSendOptions, "workflowResultKey" | "schema">;

/** Why this turn's workflow-result fields cannot run on 2.x, or null. */
export function openCode2WorkflowTurnProblem(options: TurnOptions): string | null {
  const capability = options.agentMcp?.workflowResultCapability;
  if (Boolean(options.workflowResultTool) !== Boolean(capability)) {
    return "OpenCode workflow-result tool configuration is incomplete";
  }
  if (
    options.workflowResultTool !== undefined &&
    !isOpenCodeWorkflowResultToolName(options.workflowResultTool)
  ) {
    return "OpenCode workflow-result tool configuration is incomplete";
  }
  if (options.workflowResultTool && options.schema) {
    return "A turn submits its result through the tool or as structured output, not both";
  }
  return openCodeWorkflowResultTurnProblem(options);
}

export class OpenCode2WorkflowTurns {
  constructor(
    private readonly mcp: OpenCode2McpServers,
    private readonly grants: OpenCode2TurnGrants,
  ) {}

  /**
   * Register the connections this turn will use, and drop a previous turn's
   * design or artifact server this one does not have. Nothing is dispatched.
   */
  async prepare(sessionId: string, options: TurnOptions): Promise<void> {
    const problem = openCode2WorkflowTurnProblem(options);
    if (problem) throw new ProviderDispatchPreparationError(problem);
    const connection = options.agentMcp;
    if (!connection) {
      // A grant is one turn's: a turn without one never keeps the previous turn's.
      await this.mcp.removeSessionServer(OPENCODE2_ARTIFACTS_MCP_PREFIX, sessionId);
      return;
    }
    const broker = Boolean(connection.workflowResultCapability);
    // Design tools refuse workflow credentials, so only a tab-scoped connection carries them.
    const design = !broker && connection.design === true;
    const artifacts = connection.artifacts?.token;
    await Promise.all([
      broker
        ? this.mcp.ensureWorkflowBroker(connection)
        : this.mcp.ensureTab(sessionId, connection),
      design
        ? this.mcp.ensureDesign(sessionId, connection)
        : this.mcp.removeSessionServer(OPENCODE2_DESIGN_MCP_PREFIX, sessionId),
      artifacts
        ? this.mcp.ensureArtifacts(sessionId, connection.url, artifacts)
        : this.mcp.removeSessionServer(OPENCODE2_ARTIFACTS_MCP_PREFIX, sessionId),
    ]);
  }

  /** The prompt as sent: a structured-output turn asks for one final JSON value. */
  shapePrompt(prompt: string, options: Pick<ProviderSendOptions, "schema">): string {
    return options.schema ? openCodeStructuredPrompt(prompt, options.schema) : prompt;
  }

  /**
   * Grant the turn and send its prompt, exclusively for the session. A grant
   * that fails sends nothing (`notSent`); a definitive refusal restores the
   * grant at once; an ambiguous one keeps it, because the turn may be running.
   */
  dispatch(
    sessionId: string,
    options: ProviderSendOptions,
    send: () => Promise<void>,
    notSent: () => void,
  ) {
    return this.grants.runExclusive(sessionId, async () => {
      await this.begin(sessionId, options).catch((error: unknown) => {
        notSent();
        throw error;
      });
      try {
        await send();
      } catch (error) {
        if (error instanceof PromptRejectedError) {
          await this.grants.settle(sessionId, options.requestId).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  private begin(sessionId: string, options: ProviderSendOptions): Promise<void> {
    return this.grants.begin(sessionId, {
      requestId: options.requestId,
      ...(options.readOnly ? { readOnly: true } : {}),
      ...(options.reviewShellPolicy ? { reviewShellPolicy: options.reviewShellPolicy } : {}),
      ...(options.workflowResultTool
        ? {
            workflowResultTool: options.workflowResultTool,
            ...(options.workflowResultExtraTools
              ? { workflowResultExtraTools: options.workflowResultExtraTools }
              : {}),
          }
        : {}),
    });
  }

  /**
   * Whether `requestId` is finished: false while its run is still in
   * progress (an idle read made before this lock may be obsolete), true once
   * it has settled, its grant restored if it holds one. A request not in the
   * scanned history holding no grant answers true, as on 1.x.
   */
  settleTurn(
    sessionId: string,
    requestId: string,
    history: () => Promise<readonly OpenCode2Message[]>,
  ): Promise<boolean> {
    return this.grants.runExclusive(sessionId, async () => {
      const owner = await this.grants.owner(sessionId);
      const holdsGrant = owner?.requestId === requestId && !owner.settled;
      const run = openCode2RequestRun(await history(), requestId);
      if (run ? !run.idle : holdsGrant) return false;
      if (holdsGrant) await this.grants.settle(sessionId, requestId);
      return true;
    });
  }

  /** After an interrupt: whichever turn held a grant no longer does. */
  afterAbort(sessionId: string): Promise<void> {
    return this.grants.runExclusive(sessionId, () => this.grants.settleOwner(sessionId));
  }

  /** Drop a closed session's own connections (tab, design, artifacts). */
  closeSession(sessionId: string): Promise<void> {
    return this.mcp.removeSession(sessionId);
  }

  mcpServers(signal?: AbortSignal) {
    return this.mcp.userServers(signal);
  }

  mcpServerAction(serverId: string, action: NativeAgentMcpServerAction) {
    return this.mcp.userServerAction(serverId, action);
  }
}

/** One request's run in a session's history (oldest first), once its input is there. */
export function openCode2RequestRun(
  rows: readonly OpenCode2Message[],
  requestId: string,
): { assistants: OpenCode2AssistantMessage[]; idle?: OpenCode2IdleMessage } | undefined {
  const start = rows.findIndex((row) => carriesRequest(row, requestId));
  if (start < 0) return undefined;
  const assistants: OpenCode2AssistantMessage[] = [];
  for (const row of rows.slice(start + 1)) {
    if (isOpenCode2IdleMessage(row)) return { assistants, idle: row };
    if (row.type === "assistant") assistants.push(row as OpenCode2AssistantMessage);
  }
  return { assistants };
}

/**
 * The structured result of a `schema` turn: null until its run has settled
 * (or when the request is not in the scanned history), then the parsed final
 * answer, or a typed failure.
 */
export function openCode2StructuredResult<T>(
  rows: readonly OpenCode2Message[],
  requestId: string,
): StructuredOutputResult<T> | null {
  const run = openCode2RequestRun(rows, requestId);
  if (!run?.idle) return null;
  const failure = (code: "provider_error" | "malformed_output", message: string) => ({
    ok: false as const,
    provider: "opencode" as const,
    requestId,
    error: { code, message, provider: "opencode" as const, retryable: true },
  });
  if (run.idle.outcome !== "succeeded") {
    return failure("provider_error", "OpenCode did not produce a structured result");
  }
  const final = run.assistants.findLast((row) =>
    row.content?.some((part) => part.type === "text" && part.text.trim()),
  );
  try {
    const value = parseOpenCodeStructuredText(final?.content);
    return { ok: true, provider: "opencode", requestId, value: value as T };
  } catch {
    return failure("malformed_output", "OpenCode did not produce a valid JSON result");
  }
}

function carriesRequest(row: OpenCode2Message, requestId: string): boolean {
  const orkestrator = (row.metadata as { orkestrator?: { requestId?: unknown } } | undefined)
    ?.orkestrator;
  return row.type === "user" && orkestrator?.requestId === requestId;
}
