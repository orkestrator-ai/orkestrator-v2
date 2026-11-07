import type { ConnectionManager } from "./connection-manager.js";

/** A window whose command connection a catalogue edit may change. */
export interface ConnectionEditContext {
  /** The window's own scope, on its command node. */
  scope: string;
  window: { isDestroyed(): boolean };
}

const editing = new WeakSet<ConnectionEditContext>();

/**
 * A catalogue edit (connect, use or forget) on the window's own scope. When it
 * moves the window to another command connection, `releaseNodeScopes` runs after the
 * edit has succeeded: the window's node scopes belonged to the previous command
 * node. A failed edit leaves them, and the window's binding, as they were.
 */
export async function editDesktopConnection(
  context: ConnectionEditContext,
  edit:
    | { kind: "connect"; input: Parameters<ConnectionManager["connect"]>[0] }
    | { kind: "use"; connectionId: string }
    | { kind: "forget"; connectionId: string },
  manager: Pick<ConnectionManager, "connect" | "use" | "forget" | "getConnectionId" | "getList">,
  releaseNodeScopes: () => Promise<void>,
) {
  if (editing.has(context)) throw new Error("A connection change is already in progress");
  editing.add(context);
  let released = false;
  try {
    const scope = context.scope;
    const rebind =
      edit.kind === "connect"
        ? edit.input.select !== false
        : edit.kind === "use" || manager.getConnectionId(scope) === edit.connectionId;
    if (edit.kind === "connect") await manager.connect(edit.input, scope);
    else if (edit.kind === "use") await manager.use(edit.connectionId, scope);
    else await manager.forget(edit.connectionId, scope);
    // The catalogue mutation is complete; the release may start another edit.
    editing.delete(context);
    released = true;
    if (rebind) await releaseNodeScopes();
    return manager.getList(scope);
  } finally {
    if (!released) editing.delete(context);
  }
}
