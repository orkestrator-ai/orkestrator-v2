/** Session permissions and their instance-scoped research evidence. */
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { assertSdkResponse } from "./agent-provider-runtime.js";
import { effectiveOpenCodePolicy, openCodePermissionRules } from "./opencode-provider-helpers.js";
import { openCodeConfiguredMcpServersFor } from "./opencode-user-mcp.js";

export class OpenCodeSessionPolicy {
  private readonly appliedResearchTools = new Map<string, string>();
  /** The instance's MCP server list each restricted session's rules were built from. */
  private readonly appliedMcpServers = new Map<string, string>();

  constructor(
    private readonly client: OpencodeClient,
    private readonly policies: Map<string, NativeAgentExecutionPolicy>,
    private readonly requestOptions: () => { signal: AbortSignal },
    private readonly researchTools: () => readonly string[],
    private readonly ensureResearch?: () => Promise<void>,
    private readonly directory?: string,
  ) {}

  /**
   * Record a session created with `policy`'s rules. `configuredMcpServers`
   * is the server list those rules were built from (graphs item 404).
   */
  remember(
    sessionId: string,
    policy: NativeAgentExecutionPolicy,
    configuredMcpServers?: readonly string[],
  ): void {
    this.policies.set(sessionId, policy);
    this.appliedResearchTools.set(sessionId, JSON.stringify(this.researchTools()));
    this.appliedMcpServers.set(sessionId, JSON.stringify(configuredMcpServers ?? null));
  }

  invalidateResearch(): void {
    this.appliedResearchTools.clear();
  }

  forget(sessionId: string): void {
    this.appliedResearchTools.delete(sessionId);
    this.appliedMcpServers.delete(sessionId);
  }

  /** The instance's MCP servers when the policy selects its user servers. */
  configuredMcpServers(policy: NativeAgentExecutionPolicy): Promise<string[] | undefined> {
    return openCodeConfiguredMcpServersFor(
      policy,
      this.client,
      this.directory,
      this.requestOptions,
    );
  }

  async synchronize(sessionId: string, policy: NativeAgentExecutionPolicy): Promise<void> {
    await this.ensureResearch?.();
    const effectivePolicy = effectiveOpenCodePolicy(policy);
    // A session that selects its MCP servers re-reads the instance's list
    // every turn: a server added since its rules were written would otherwise
    // be callable.
    const configuredMcpServers = await this.configuredMcpServers(effectivePolicy);
    // OpenCode appends rules on update. Skip only when the policy, the current
    // instance's research evidence and its MCP server list all still match
    // the applied rules.
    if (
      JSON.stringify(this.policies.get(sessionId)) === JSON.stringify(effectivePolicy) &&
      this.appliedResearchTools.get(sessionId) === JSON.stringify(this.researchTools()) &&
      (this.appliedMcpServers.get(sessionId) ?? "null") ===
        JSON.stringify(configuredMcpServers ?? null)
    )
      return;
    await this.apply(sessionId, effectivePolicy, configuredMcpServers);
  }

  async apply(
    sessionId: string,
    policy: NativeAgentExecutionPolicy,
    configured?: readonly string[],
  ): Promise<void> {
    await this.ensureResearch?.();
    const researchTools = this.researchTools();
    const configuredMcpServers = configured ?? (await this.configuredMcpServers(policy));
    const response = await this.client.session.update(
      {
        sessionID: sessionId,
        permission: openCodePermissionRules(policy, {
          researchTools,
          ...(configuredMcpServers ? { configuredMcpServers } : {}),
        }),
      },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode resumed session policy update");
    this.policies.set(sessionId, policy);
    this.appliedResearchTools.set(sessionId, JSON.stringify(researchTools));
    this.appliedMcpServers.set(sessionId, JSON.stringify(configuredMcpServers ?? null));
  }
}
