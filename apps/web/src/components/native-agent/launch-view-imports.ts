export async function importNativeAgentTab() {
  return (await import("@/components/native-agent")).AgentNativeTab;
}

export async function importLaunchPromptPending() {
  return (await import("./LaunchPromptPending")).LaunchPromptPending;
}
