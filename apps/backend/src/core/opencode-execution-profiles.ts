/**
 * OpenCode's `app.agents` list, as the shared execution-profile control.
 *
 * Separate from `opencode-provider.ts` because it is pure — a JSON array in, a
 * bounded list of picker rows out — and because the provider module is already
 * at its reviewed size limit.
 */
import type { NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";

/** Profiles one read may produce. OpenCode cannot make this unbounded. */
const MAX_EXECUTION_PROFILES = 128;

/**
 * The agents a user may select for a turn.
 *
 * Hidden agents and sub-agents are excluded: a sub-agent is something the
 * primary agent spawns, not something a person picks in the composer, and
 * offering one would send a turn to an agent OpenCode does not drive directly.
 */
export function openCodeExecutionProfiles(
  agents: unknown,
): NonNullable<NativeAgentComposerState["executionProfiles"]> {
  return (Array.isArray(agents) ? agents : [])
    .slice(0, MAX_EXECUTION_PROFILES)
    .flatMap((candidate) => {
      const agent = asRecord(candidate);
      const name = nonEmptyString(agent?.name);
      if (!name || agent?.hidden === true || agent?.mode === "subagent") return [];
      const model = asRecord(agent?.model);
      const providerId = nonEmptyString(model?.providerID);
      const modelId = nonEmptyString(model?.modelID);
      return [
        {
          id: name,
          label: name,
          ...(typeof agent?.description === "string"
            ? { description: agent.description.slice(0, 1_000) }
            : {}),
          ...(providerId && modelId ? { modelId: `${providerId}/${modelId}` } : {}),
        },
      ];
    });
}
