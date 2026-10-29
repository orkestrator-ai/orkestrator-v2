import { createBuildPipelineProvider } from "./build-pipeline-provider.js";
import type { StorageService } from "./storage.js";

/** Reconnect to the surviving runtime, without creating or dispatching a turn. */
export async function cleanupRetiredLoopedReviews(
  storage: Pick<StorageService, "getEnvironment" | "reconcileRetiredLoopedReviews">,
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>,
): Promise<void> {
  await storage.reconcileRetiredLoopedReviews(async (target) => {
    const environment = await storage.getEnvironment(target.environmentId);
    // Absence alone is not proof the user's container has stopped. Retain the
    // identity rather than treating an unavailable runtime as a successful stop.
    if (!environment) throw new Error("Retired review environment is unavailable");
    const local = environment.environmentType === "local";
    if (!local && !environment.containerId) throw new Error("Review container is unavailable");
    const connection = await invoke<{ port?: number; hostPort?: number; authToken?: string }>(
      local ? `start_local_${target.agent}_server_cmd` : `start_${target.agent}_server`,
      local ? { environmentId: environment.id } : { containerId: environment.containerId },
    );
    const port = local ? connection.port : connection.hostPort;
    if (!connection.authToken || !port) throw new Error("Review bridge is unavailable");
    return createBuildPipelineProvider({
      agent: target.agent,
      baseUrl: `http://127.0.0.1:${port}`,
      authToken: connection.authToken,
      ...(local ? { directory: environment.worktreePath } : {}),
    });
  });
}
