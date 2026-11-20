/**
 * `POST /session/:id/config` carrying only a bug report's execution policy.
 *
 * Codex answers with whether it saved the policy durably, and anything but an
 * explicit `durable: true` fails. Kept out of `provider.ts` to hold that module
 * within its line limit.
 */
import {
  nativeAgentPolicyForBridge,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { ProviderUnavailableError, type BridgeConnection } from "../agent-provider-contract.js";
import { asRecord } from "../agent-provider-runtime.js";
import type { HttpBridgeAgent } from "./catalog.js";
import { assertOkWithErrorDetail, boundedJson, bridgeFetch } from "./transport.js";

export async function synchronizeBridgeBugReportPolicy(input: {
  agent: HttpBridgeAgent;
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  sessionId: string;
  policy: NativeAgentExecutionPolicy;
}): Promise<void> {
  const response = await bridgeFetch(
    input.connection,
    `/session/${encodeURIComponent(input.sessionId)}/config`,
    {
      method: "POST",
      body: JSON.stringify({ policy: nativeAgentPolicyForBridge(input.policy, input.agent) }),
    },
    input.fetchImpl,
  );
  await assertOkWithErrorDetail(response, "Bug report session policy update");
  if (input.agent === "codex") {
    const result = asRecord(await boundedJson(response, "Bug report session policy update"));
    if (result?.durable !== true) {
      throw new ProviderUnavailableError("Codex could not save the bug report session policy");
    }
  }
}
