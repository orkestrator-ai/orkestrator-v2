/**
 * Graphs are experimental: the action bar shows Graphs and Run graph… only
 * while `global.experimentalGraphs` is on. Turns it on for the profile; the
 * caller reloads (or navigates) before looking for the buttons.
 */
export async function enableExperimentalGraphs(
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
): Promise<void> {
  const config = await invoke<{ global: Record<string, unknown> }>("get_config");
  if (config.global.experimentalGraphs === true) return;
  await invoke("update_global_config", { global: { ...config.global, experimentalGraphs: true } });
}
