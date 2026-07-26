import { toast } from "sonner";
import { updateGlobalConfig } from "@/lib/backend";
import { useConfigStore } from "@/stores/configStore";
import type { GlobalConfig } from "@/types";

/** Global-config keys holding each agent's default model. */
export type AgentModelConfigKey = "claudeModel" | "codexModel" | "opencodeModel";

/**
 * Persist the composer's model choice as the agent's global default.
 *
 * Applied optimistically so the dropdown does not flicker, then rolled back if
 * the write fails. The guards compare against the value we wrote: a second
 * change made while the request was in flight wins, and neither the commit nor
 * the rollback may stomp it.
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

  const nextGlobal: GlobalConfig = { ...currentConfig.global, [key]: modelId };
  useConfigStore.getState().setConfig({ ...currentConfig, global: nextGlobal });

  try {
    const updatedConfig = await updateGlobalConfig(nextGlobal);
    if (useConfigStore.getState().config.global[key] === modelId) {
      useConfigStore.getState().setConfig(updatedConfig);
    }
  } catch (error) {
    if (useConfigStore.getState().config.global[key] === modelId) {
      useConfigStore.getState().setConfig(currentConfig);
    }
    console.error(
      `[${agentLabel}ComposeBar] Failed to persist ${agentLabel} model default:`,
      error,
    );
    toast.error(`Failed to save ${agentLabel} model default`);
  }
}
