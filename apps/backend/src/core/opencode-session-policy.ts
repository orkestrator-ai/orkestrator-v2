/** Session permissions and their instance-scoped research evidence. */
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { assertSdkResponse } from "./agent-provider-runtime.js";
import { effectiveOpenCodePolicy, openCodePermissionRules } from "./opencode-provider-helpers.js";

export class OpenCodeSessionPolicy {
  private readonly appliedResearchTools = new Map<string, string>();

  constructor(
    private readonly client: OpencodeClient,
    private readonly policies: Map<string, NativeAgentExecutionPolicy>,
    private readonly requestOptions: () => { signal: AbortSignal },
    private readonly researchTools: () => readonly string[],
    private readonly ensureResearch?: () => Promise<void>,
  ) {}

  remember(sessionId: string, policy: NativeAgentExecutionPolicy): void {
    this.policies.set(sessionId, policy);
    this.appliedResearchTools.set(sessionId, JSON.stringify(this.researchTools()));
  }

  invalidateResearch(): void {
    this.appliedResearchTools.clear();
  }

  forget(sessionId: string): void {
    this.appliedResearchTools.delete(sessionId);
  }

  async synchronize(sessionId: string, policy: NativeAgentExecutionPolicy): Promise<void> {
    await this.ensureResearch?.();
    const effectivePolicy = effectiveOpenCodePolicy(policy);
    // OpenCode appends rules on update. Skip only when both the policy and
    // the current instance's research evidence still match the applied rules.
    if (
      JSON.stringify(this.policies.get(sessionId)) === JSON.stringify(effectivePolicy) &&
      this.appliedResearchTools.get(sessionId) === JSON.stringify(this.researchTools())
    )
      return;
    await this.apply(sessionId, effectivePolicy);
  }

  async apply(sessionId: string, policy: NativeAgentExecutionPolicy): Promise<void> {
    await this.ensureResearch?.();
    const researchTools = this.researchTools();
    const response = await this.client.session.update(
      {
        sessionID: sessionId,
        permission: openCodePermissionRules(policy, { researchTools }),
      },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode resumed session policy update");
    this.policies.set(sessionId, policy);
    this.appliedResearchTools.set(sessionId, JSON.stringify(researchTools));
  }
}
