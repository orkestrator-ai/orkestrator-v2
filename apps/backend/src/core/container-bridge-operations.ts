import type { CommandContext } from "./commands-context.js";
import type { LocalServerKind } from "./commands-runtime-state.js";
import { containerBridgeOperations } from "./commands-runtime-state.js";

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
  agent: LocalServerKind,
  containerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${agent}:${containerId}`;
  const previous = containerBridgeOperations.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  containerBridgeOperations.set(key, tail);
  void tail.finally(() => {
    if (containerBridgeOperations.get(key) === tail) {
      containerBridgeOperations.delete(key);
    }
  });
  return result;
}
