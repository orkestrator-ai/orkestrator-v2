import type { CommandContext } from "./commands-context.js";
import type { LocalServerKind } from "./local-server-runtime.js";

/** Use the persisted ID so Docker's abbreviated IDs cannot create a second lock. */
export async function containerBridgeOperationId(
  context: Pick<CommandContext, "storage">,
  containerId: string,
): Promise<string> {
  const id = containerId.trim();
  if (!id) return id;
  const environment = (await context.storage.loadEnvironments()).find(
    ({ containerId: known }) =>
      known && (known === id || known.startsWith(id) || id.startsWith(known)),
  );
  return environment?.containerId ?? id;
}

export function enqueueContainerBridgeOperation<T>(
  context: Pick<CommandContext, "runtime">,
  agent: LocalServerKind,
  containerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return context.runtime.localServers.enqueueContainerBridgeOperation(
    agent,
    containerId,
    operation,
  );
}
