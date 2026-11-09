/**
 * Narrow a platform's advertised capabilities by what one session reports it
 * cannot do (`ProviderCapabilityLimits`). Only ever removes: a session can
 * never claim more than its platform's table.
 */
import type { NativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import type { ProviderCapabilityLimits } from "./agent-provider-contract.js";

export function limitNativeAgentCapabilities(
  capabilities: NativeAgentCapabilities,
  limits: ProviderCapabilityLimits | undefined,
): NativeAgentCapabilities {
  if (!limits) return capabilities;
  let next = capabilities;
  if (limits.withoutActions?.length && next.actions) {
    const actions = { ...next.actions };
    for (const action of limits.withoutActions) {
      if (action in actions) actions[action] = false;
    }
    next = { ...next, actions };
  }
  if (limits.withoutAttachments) {
    next = { ...next, attachments: { files: false, images: false } };
  }
  if (limits.withoutSlashCommands) next = { ...next, slashCommands: false };
  if (limits.withoutFork) next = { ...next, fork: false };
  return next;
}
