import type { CoordinatorDelegationRequest } from "@orkestrator/protocol/coordinator";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";

function field(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * What the Work panel shows for a launched worker, from the `create_environment`
 * input before the prompt is framed (the caller's own words, not the delegation
 * instructions around them) and the environment that came back. A model the
 * call did not set is left out here: the startup launch resolves it later, and
 * the row then shows the agent alone rather than guessing.
 */
export function launchDelegationRequest(
  input: Record<string, unknown>,
  environment: unknown,
): CoordinatorDelegationRequest {
  const created = (environment ?? {}) as Record<string, unknown>;
  const settings = input.agentSettings as { defaultAgent?: unknown } | undefined;
  const requestedModel = field(input.initialAgentModel);
  const requestedReasoning = field(input.initialReasoningEffort);
  const model = requestedModel ?? field(created.initialAgentModel);
  const reasoning = requestedReasoning ?? field(created.initialReasoningEffort);
  return {
    ...(field(input.initialPrompt) ? { summary: field(input.initialPrompt) } : {}),
    ...(isAgentPlatform(settings?.defaultAgent) ? { agent: settings.defaultAgent } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    source: requestedModel || requestedReasoning ? "requested" : "default",
  };
}
