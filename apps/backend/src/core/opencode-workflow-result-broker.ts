import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { WORKFLOW_RESULT_MCP_SERVER_NAME } from "@orkestrator/protocol/workflow-results";
import {
  boundedOpenCodeMessageHistory,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  openCodeRequestMarker,
} from "@orkestrator/protocol/opencode-message-id";
import {
  ProviderDispatchPreparationError,
  ProviderUnavailableError,
  type ProviderStatus,
  type ProviderPrepareDispatchOptions,
  type ProviderSendOptions,
} from "./agent-provider-contract.js";
import { asRecord, assertSdkResponse } from "./agent-provider-runtime.js";
import {
  isOpenCodeWorkflowResultToolName,
  openCodeWorkflowResultDenyPermissionRules,
  openCodeWorkflowResultPermissionRules,
} from "./opencode-provider-helpers.js";

const TURN_METADATA_KEY = "orkestrator.workflowResultTurn";

/**
 * Registration may be warmed up, but permissions belong to a dispatched request.
 * The provider serializes begin/settle with its shared per-session dispatch lock.
 * Ownership lives in OpenCode metadata so a recreated provider can settle a turn,
 * and an old request cannot revoke a newer request's grant. Observers never write.
 */
export class OpenCodeWorkflowResultBroker {
  private mcpKey: string | null = null;
  private mcpSetup: { key: string; promise: Promise<void> } | null = null;
  private generation = 0;

  constructor(
    private readonly client: OpencodeClient,
    private readonly directory: string | undefined,
    private readonly requestOptions: () => { signal: AbortSignal },
    private readonly runExclusive: <T>(
      sessionId: string,
      operation: () => Promise<T>,
    ) => Promise<T>,
  ) {}

  async prepare(_sessionId: string, options: ProviderPrepareDispatchOptions = {}): Promise<void> {
    const capability = options.agentMcp?.workflowResultCapability;
    if (
      Boolean(options.workflowResultTool) !== Boolean(capability) ||
      (options.workflowResultTool !== undefined &&
        !isOpenCodeWorkflowResultToolName(options.workflowResultTool))
    ) {
      throw new ProviderDispatchPreparationError(
        "OpenCode workflow-result tool configuration is incomplete",
      );
    }
    if (options.agentMcp?.workflowResultCapability) await this.ensureMcp(options.agentMcp);
  }

  invalidate(): void {
    this.generation += 1;
    this.mcpKey = null;
  }

  async ensureMcp(connection: NonNullable<ProviderSendOptions["agentMcp"]>): Promise<void> {
    const key = `${connection.url}\0${connection.token}`;
    if (this.mcpSetup?.key === key) return this.mcpSetup.promise;
    const generation = this.generation;
    const promise = (async () => {
      if (this.mcpKey === key) {
        const status = await this.client.mcp.status(
          { directory: this.directory },
          this.requestOptions(),
        );
        assertSdkResponse(status, "OpenCode workflow-result MCP status");
        if (connected(status.data) && generation === this.generation) return;
        this.mcpKey = null;
      }
      const response = await this.client.mcp.add(
        {
          directory: this.directory,
          name: WORKFLOW_RESULT_MCP_SERVER_NAME,
          config: {
            type: "remote",
            url: connection.url,
            headers: { Authorization: `Bearer ${connection.token}` },
            oauth: false,
          },
        },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode workflow-result MCP registration");
      // OpenCode reports connection failures in a successful HTTP response.
      if (!connected(response.data)) throw new Error("Workflow-result MCP did not connect");
      if (generation !== this.generation) throw new Error("OpenCode MCP generation changed");
      this.mcpKey = key;
    })();
    this.mcpSetup = { key, promise };
    try {
      await promise;
    } catch (error) {
      this.mcpKey = null;
      throw new ProviderDispatchPreparationError("OpenCode workflow-result MCP is unavailable", {
        cause: error,
      });
    } finally {
      if (this.mcpSetup?.promise === promise) this.mcpSetup = null;
    }
  }

  /** Called under the dispatch lock immediately before writing the prompt. */
  async begin(sessionId: string, requestId: string, selectedTool?: string): Promise<void> {
    try {
      const permission = selectedTool
        ? openCodeWorkflowResultPermissionRules(selectedTool)
        : openCodeWorkflowResultDenyPermissionRules();
      const response = await this.client.session.update(
        {
          sessionID: sessionId,
          directory: this.directory,
          metadata: { [TURN_METADATA_KEY]: { version: 1, requestId, settled: false } },
          permission,
        },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode workflow-result permission update");
      const session = await this.read(sessionId);
      const rules = session.permission;
      if (!Array.isArray(rules) || this.owner(session)?.requestId !== requestId) {
        throw new Error("Workflow-result permission update was not persisted");
      }
      for (const expected of permission) {
        const wanted = permission.findLast((rule) => rule.permission === expected.permission)!;
        const actual = rules.findLast((rule) => asRecord(rule)?.permission === expected.permission);
        if (asRecord(actual)?.action !== wanted.action || asRecord(actual)?.pattern !== "*") {
          throw new Error("Workflow-result permission readback did not match");
        }
      }
    } catch (error) {
      throw new ProviderDispatchPreparationError(
        "OpenCode workflow-result permissions are unavailable",
        { cause: error },
      );
    }
  }

  /** The caller holds the dispatch lock and has confirmed this request is terminal. */
  async settle(
    sessionId: string,
    requestId: string,
    restoreReviewer: () => Promise<unknown>,
  ): Promise<void> {
    const session = await this.read(sessionId);
    const owner = this.owner(session);
    if (owner?.requestId !== requestId || owner.settled === true) return;
    await restoreReviewer();
    const response = await this.client.session.update(
      {
        sessionID: sessionId,
        directory: this.directory,
        permission: openCodeWorkflowResultDenyPermissionRules(),
        metadata: { [TURN_METADATA_KEY]: { version: 1, requestId, settled: true } },
      },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode workflow-result permission settlement");
  }

  async requestId(sessionId: string): Promise<string | undefined> {
    const owner = this.owner(await this.read(sessionId));
    return typeof owner?.requestId === "string" ? owner.requestId : undefined;
  }

  async settleCompleted(
    sessionId: string,
    requestId: string,
    status: () => Promise<ProviderStatus>,
    restoreReviewer: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      return await this.runExclusive(sessionId, async () => {
        if ((await this.requestId(sessionId)) !== requestId) return true;
        // An idle observation made before acquiring the dispatch lock may
        // already be obsolete. Also require this request's terminal response.
        const current = await status();
        if (current !== "idle" && current !== "error") return false;
        const response = await this.client.session.messages(
          {
            sessionID: sessionId,
            directory: this.directory,
            limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT,
          },
          this.requestOptions(),
        );
        assertSdkResponse(response, "OpenCode completion transcript read");
        const latest = boundedOpenCodeMessageHistory(response.data)
          .map((message) => asRecord(asRecord(message)?.info))
          .findLast((info) => info?.role === "user" || info?.role === "assistant");
        const parent = latest?.role === "assistant" ? latest.parentID : undefined;
        if (
          typeof parent !== "string" ||
          !parent.endsWith(openCodeRequestMarker(requestId)) ||
          typeof asRecord(latest?.time)?.completed !== "number" ||
          (!latest?.error &&
            (!latest?.finish || latest.finish === "tool-calls" || latest.finish === "unknown"))
        )
          return false;
        await this.settle(sessionId, requestId, restoreReviewer);
        return true;
      });
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode turn settlement is unavailable", {
        cause: error,
      });
    }
  }

  async abort(
    sessionId: string,
    endTurn: () => void,
    restoreReviewer: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await this.runExclusive(sessionId, async () => {
        const response = await this.client.session.abort(
          { sessionID: sessionId, directory: this.directory },
          this.requestOptions(),
        );
        assertSdkResponse(response, "OpenCode abort");
        endTurn();
        const requestId = await this.requestId(sessionId);
        if (requestId) await this.settle(sessionId, requestId, restoreReviewer);
      });
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode abort is unavailable", { cause: error });
    }
  }

  private owner(session: Record<string, unknown>) {
    const owner = asRecord(asRecord(session.metadata)?.[TURN_METADATA_KEY]);
    return owner?.version === 1 ? owner : null;
  }

  private async read(sessionId: string): Promise<Record<string, unknown>> {
    const response = await this.client.session.get(
      { sessionID: sessionId, directory: this.directory },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode workflow-result permission read");
    const session = asRecord(response.data);
    if (!session) throw new Error("OpenCode returned no session permission state");
    return session;
  }
}

function connected(value: unknown): boolean {
  return asRecord(asRecord(value)?.[WORKFLOW_RESULT_MCP_SERVER_NAME])?.status === "connected";
}
