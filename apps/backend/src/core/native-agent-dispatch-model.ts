/**
 * A dispatch's model for a runtime whose turns run the session-held model.
 *
 * Codex takes its model from the bridge session's config and the prompt
 * carries none, so a `dispatch_native_agent_prompt` or Control MCP `model`
 * sent to an existing session used to be dropped: the turn ran the session's
 * model while the caller asked for another. The service applies such a model
 * the way a model pick is applied (a control update, persisted and sent to the
 * runtime) after admission checks under the delivery lease, so the shown,
 * stored and run model stay the same. Platforms whose prompts carry the model
 * never need this.
 */
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentControlUpdate,
  NativeAgentModelSubstitution,
} from "@orkestrator/protocol/native-agent";
import type { PersistedNativeAgentSession } from "./models.js";
import { nativeAgentPlatformPolicy } from "./native-agent-platform-policy.js";
import type { DispatchNativeAgentPromptInput } from "./native-agent-service-shared.js";

/**
 * The control update a dispatch implies, or undefined when it changes nothing.
 *
 * Only an explicit model counts: an inherited default (`modelSource:
 * "default"`) was already replaced by the session's own model. The comparison
 * is against the backend-owned selection, so a session started on the
 * runtime's unset default adopts the first model a prompt names.
 */
export function sessionHeldDispatchModelUpdate(
  input: Pick<DispatchNativeAgentPromptInput, "model" | "modelSource" | "reasoningEffort">,
  session: Pick<PersistedNativeAgentSession, "agent" | "controls">,
): NativeAgentControlUpdate | undefined {
  if (nativeAgentPlatformPolicy(session.agent).runsSessionHeldModel !== true) return undefined;
  if (input.modelSource === "default") return undefined;
  const modelId = input.model?.trim();
  // `"default"` is the launchers' placeholder for unset, not a model.
  if (!modelId || modelId === "default" || modelId === session.controls?.modelId) {
    return undefined;
  }
  return {
    modelId,
    ...(input.reasoningEffort ? { reasoningId: input.reasoningEffort } : {}),
  };
}

/** Why a dispatch naming a model the login does not offer was refused. */
export function unofferedDispatchModelMessage(
  agent: PersistedNativeAgentSession["agent"],
  modelId: string,
  availability: NativeAgentModelSubstitution,
): string {
  const label = AGENT_PLATFORM_LABELS[agent] ?? agent;
  return `${modelId} isn't available with your ${label} login, so this prompt was not sent. Pick another model, such as ${availability.modelId}, and send it again.`;
}
