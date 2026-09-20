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
import { openCodeMessageFinishReason } from "./opencode-turn-recovery.js";

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
      const session = await this.read(sessionId);
      const expectedPermission = selectedTool
        ? openCodeWorkflowResultPermissionRules(selectedTool)
        : openCodeWorkflowResultDenyPermissionRules();
      const permission = hasEffectivePermissionRules(session.permission, expectedPermission)
        ? undefined
        : expectedPermission;
      const response = await this.client.session.update(
        {
          sessionID: sessionId,
          directory: this.directory,
          metadata: this.metadata(session, requestId, false),
          ...(permission ? { permission } : {}),
        },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode workflow-result permission update");
      const persisted = await this.read(sessionId);
      if (
        this.owner(persisted)?.requestId !== requestId ||
        this.owner(persisted)?.settled !== false ||
        !hasEffectivePermissionRules(persisted.permission, expectedPermission)
      ) {
        throw new Error("Workflow-result permission update was not persisted");
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
    // Reviewer restoration appends its base rules. Read again so the workflow
    // denies are evaluated against that new tail and unrelated metadata written
    // by another lifecycle remains intact.
    const current = await this.read(sessionId);
    const currentOwner = this.owner(current);
    if (currentOwner?.requestId !== requestId || currentOwner.settled === true) return;
    const expectedPermission = openCodeWorkflowResultDenyPermissionRules();
    const permission = hasEffectivePermissionRules(current.permission, expectedPermission)
      ? undefined
      : expectedPermission;
    const response = await this.client.session.update(
      {
        sessionID: sessionId,
        directory: this.directory,
        ...(permission ? { permission } : {}),
        metadata: this.metadata(current, requestId, true),
      },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode workflow-result permission settlement");
    const persisted = await this.read(sessionId);
    if (
      this.owner(persisted)?.requestId !== requestId ||
      this.owner(persisted)?.settled !== true ||
      !hasEffectivePermissionRules(persisted.permission, expectedPermission)
    ) {
      throw new Error("Workflow-result permission settlement was not persisted");
    }
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
        const latest = boundedOpenCodeMessageHistory(response.data).findLast((message) => {
          const role = asRecord(asRecord(message)?.info)?.role;
          return role === "user" || role === "assistant";
        });
        const info = asRecord(asRecord(latest)?.info);
        const parent = info?.role === "assistant" ? info.parentID : undefined;
        const finish = openCodeMessageFinishReason(latest);
        if (
          typeof parent !== "string" ||
          !parent.endsWith(openCodeRequestMarker(requestId)) ||
          typeof asRecord(info?.time)?.completed !== "number" ||
          (!info?.error && (!finish || finish === "tool-calls"))
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
      // Interrupt transport immediately. Cleanup is serialized afterwards so
      // it cannot race a newer dispatch, but the user-visible stop never waits
      // behind a slow prompt request or permission readback.
      const response = await this.client.session.abort(
        { sessionID: sessionId, directory: this.directory },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode abort");
      endTurn();
      await this.runExclusive(sessionId, async () => {
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

  private metadata(session: Record<string, unknown>, requestId: string, settled: boolean) {
    return {
      ...asRecord(session.metadata),
      [TURN_METADATA_KEY]: { version: 1, requestId, settled },
    };
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

function hasEffectivePermissionRules(current: unknown, expected: readonly unknown[]): boolean {
  if (!Array.isArray(current)) return false;
  const wanted = new Map<string, Record<string, unknown>>();
  for (const rule of expected) {
    const record = asRecord(rule);
    if (typeof record?.permission === "string") wanted.set(record.permission, record);
  }
  for (const [permission, expectedRule] of wanted) {
    const actual = current.findLast((rule) => {
      const record = asRecord(rule);
      return (
        typeof record?.permission === "string" &&
        permissionPatternMatches(record.permission, permission)
      );
    });
    const record = asRecord(actual);
    if (record?.action !== expectedRule.action || record?.pattern !== expectedRule.pattern) {
      return false;
    }
  }
  return wanted.size > 0;
}

function permissionPatternMatches(candidate: string, permission: string): boolean {
  const source = candidate
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${source}$`, "s").test(permission);
}

function connected(value: unknown): boolean {
  return asRecord(asRecord(value)?.[WORKFLOW_RESULT_MCP_SERVER_NAME])?.status === "connected";
}
