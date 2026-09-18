import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { WORKFLOW_RESULT_MCP_SERVER_NAME } from "@orkestrator/protocol/workflow-results";
import {
  ProviderDispatchPreparationError,
  type ProviderPrepareDispatchOptions,
  type ProviderSendOptions,
} from "./agent-provider-contract.js";
import { asRecord, assertSdkResponse } from "./agent-provider-runtime.js";
import {
  openCodeWorkflowResultDenyPermissionRules,
  openCodeWorkflowResultPermissionRules,
} from "./opencode-provider-helpers.js";

/**
 * Persistent workflow-result MCP broker and per-turn permission lifecycle.
 *
 * Isolation lives in appended session permission rules, not in the prompt
 * `tools` map. A non-empty prompt tools map replaces `session.permission` on
 * OpenCode, so a broker-only mask would drop the established execution policy.
 *
 * Restore appends only the deny set this collaborator owns. OpenCode appends
 * update rules; round-tripping the live array would grow without bound after
 * a provider restart.
 */
export class OpenCodeWorkflowResultBroker {
  private mcpKey: string | null = null;
  private mcpSetup: { key: string; promise: Promise<void> } | null = null;
  private readonly enabled = new Map<string, string>();
  private readonly permissionRestore = new Map<
    string,
    ReturnType<typeof openCodeWorkflowResultDenyPermissionRules>
  >();
  /** Sessions whose persisted workflow-result rules were reconciled by this provider instance. */
  private readonly reconciled = new Set<string>();

  constructor(
    private readonly client: OpencodeClient,
    private readonly directory: string | undefined,
    private readonly requestOptions: () => { signal: AbortSignal },
  ) {}

  async prepare(sessionId: string, options: ProviderPrepareDispatchOptions = {}): Promise<void> {
    if (options.agentMcp?.workflowResultCapability) {
      await this.ensureMcp(options.agentMcp);
    }
    if (options.workflowResultTool) {
      await this.enableForTurn(sessionId, options.workflowResultTool);
    }
  }

  async ensureMcp(connection: NonNullable<ProviderSendOptions["agentMcp"]>): Promise<void> {
    const key = `${connection.url}\0${connection.token}`;
    if (this.mcpKey === key) return;
    if (this.mcpSetup?.key === key) return this.mcpSetup.promise;
    const promise = (async () => {
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
      this.mcpKey = key;
    })();
    this.mcpSetup = { key, promise };
    try {
      await promise;
    } catch (error) {
      throw new ProviderDispatchPreparationError("OpenCode workflow-result MCP is unavailable", {
        cause: error,
      });
    } finally {
      if (this.mcpSetup?.promise === promise) this.mcpSetup = null;
    }
  }

  async enableForTurn(
    sessionId: string,
    selectedTool: string | undefined,
    reassert = false,
  ): Promise<void> {
    if (!selectedTool) return;
    if (!reassert && this.enabled.get(sessionId) === selectedTool) return;
    try {
      const response = await this.client.session.update(
        {
          sessionID: sessionId,
          directory: this.directory,
          permission: openCodeWorkflowResultPermissionRules(selectedTool),
        },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode workflow-result permission update");
    } catch (error) {
      throw new ProviderDispatchPreparationError(
        "OpenCode workflow-result permissions are unavailable",
        { cause: error },
      );
    }
    this.permissionRestore.set(sessionId, openCodeWorkflowResultDenyPermissionRules());
    this.enabled.set(sessionId, selectedTool);
    this.reconciled.add(sessionId);
  }

  async restore(sessionId: string, afterReviewerRestore = false): Promise<void> {
    let permission = this.permissionRestore.get(sessionId);
    if (!permission && !afterReviewerRestore) {
      if (this.reconciled.has(sessionId)) return;
      const response = await this.client.session.get(
        { sessionID: sessionId, directory: this.directory },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode workflow-result permission reconciliation");
      if (!hasEnabledWorkflowResultPermission(asRecord(response.data)?.permission)) {
        this.reconciled.add(sessionId);
        return;
      }
      permission = openCodeWorkflowResultDenyPermissionRules();
    }
    const response = await this.client.session.update(
      {
        sessionID: sessionId,
        directory: this.directory,
        permission: permission ?? openCodeWorkflowResultDenyPermissionRules(),
      },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode workflow-result permission restore");
    this.reconciled.add(sessionId);
    this.permissionRestore.delete(sessionId);
    this.enabled.delete(sessionId);
  }
}

/**
 * OpenCode appends permission updates, so the last rule for a tool is the
 * effective one. Recover only a persisted allow that has not already been
 * superseded by this broker's deny set.
 */
function hasEnabledWorkflowResultPermission(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const workflowPermissions = new Set(
    openCodeWorkflowResultDenyPermissionRules().map((rule) => rule.permission),
  );
  const effective = new Map<string, unknown>();
  for (const raw of value) {
    const rule = asRecord(raw);
    if (typeof rule?.permission !== "string" || !workflowPermissions.has(rule.permission)) continue;
    effective.set(rule.permission, rule.action);
  }
  return Array.from(effective.values()).some((action) => action === "allow");
}
