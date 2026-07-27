import { toast } from "sonner";
import { updateAgentModelDefault } from "@/lib/backend";
import { useConfigStore } from "@/stores/configStore";

/** Global-config keys holding each agent's default model. */
export type AgentModelConfigKey = "claudeModel" | "codexModel" | "opencodeModel";

/**
 * Persist the composer's model choice as the agent's global default.
 *
 * Applied optimistically so the dropdown does not flicker, then rolled back if
 * the write fails. Persistence updates only this model key on both sides of the
 * IPC boundary: unrelated config changes made while the request is in flight
 * therefore cannot be replaced by a stale whole-config snapshot.
 *
 * Claude and Codex already did this; OpenCode's selection was previously
 * session-only, so a new environment always reverted to the settings default.
 */
export async function persistAgentModelDefault(
  key: AgentModelConfigKey,
  modelId: string,
  agentLabel: string,
): Promise<void> {
  const currentConfig = useConfigStore.getState().config;
  // Persistence is best-effort and must never break the selection itself: the
  // config may not have loaded yet, and the user's click has already taken
  // effect in the session store by this point.
  if (!currentConfig?.global) return;
  if (currentConfig.global[key] === modelId) return;

  const previousModelId = currentConfig.global[key];
  useConfigStore.getState().updateGlobalConfig({ [key]: modelId });

  try {
    await updateAgentModelDefault(key, modelId);
  } catch (error) {
    if (useConfigStore.getState().config.global[key] === modelId) {
      useConfigStore.getState().updateGlobalConfig({ [key]: previousModelId });
    }
    console.error(
      `[${agentLabel}ComposeBar] Failed to persist ${agentLabel} model default:`,
      error,
    );
    toast.error(`Failed to save ${agentLabel} model default`);
  }
}
