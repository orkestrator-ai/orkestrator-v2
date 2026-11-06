/** Exact-id ownership and cleanup for the opt-in history qualification fixture. */
export type HistoryInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Environment = { id: string; worktreePath?: string | null };

export async function cleanupHistoryEnvironment(invoke: HistoryInvoke, environmentId: string) {
  await invoke("stop_environment", { environmentId }).catch(() => undefined);
  await invoke("delete_environment", { environmentId }).catch(() => undefined);
}

/** Own the id as soon as create succeeds, including when startup cannot return it. */
export async function createHistoryEnvironment<T extends Environment>(
  invoke: HistoryInvoke,
  projectId: string,
  name: string,
): Promise<T> {
  const environment = await invoke<T>("create_environment", {
    projectId,
    name: `${name}-${Date.now()}`,
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const started = await invoke<T>("get_environment", { environmentId: environment.id });
    if (!started.worktreePath) throw new Error("History environment has no worktree");
    return started;
  } catch (error) {
    await cleanupHistoryEnvironment(invoke, environment.id);
    throw error;
  }
}
