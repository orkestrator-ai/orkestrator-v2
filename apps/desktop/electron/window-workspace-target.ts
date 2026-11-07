import type { ConnectionManager } from "./connection-manager.js";
import type { NodeWorkspaceScopes } from "./node-workspaces.js";
import {
  openWorkspaceScope,
  type WorkspaceScopeManager,
  type WorkspaceTarget,
} from "./node-scopes.js";

export interface WorkspaceContext {
  scope: string;
  portalScope: string | null;
  target: WorkspaceTarget | null;
  window: { isDestroyed(): boolean };
}

const switching = new WeakSet<WorkspaceContext>();

/** Keep the old binding and grant until the destination is ready. */
export async function setDesktopWorkspaceTarget<T extends WorkspaceContext>(
  context: T,
  input: { nodeId: string | null },
  options: {
    manager: WorkspaceScopeManager;
    scopes: NodeWorkspaceScopes;
    committed(context: T): void;
  },
): Promise<void> {
  if (switching.has(context)) throw new Error("A workspace switch is already in progress");
  switching.add(context);
  try {
    await applyTarget(context, input, options);
  } finally {
    switching.delete(context);
  }
}

async function applyTarget<T extends WorkspaceContext>(
  context: T,
  input: { nodeId: string | null },
  options: Parameters<typeof setDesktopWorkspaceTarget<T>>[2],
): Promise<void> {
  const manager = options.manager;
  if (!manager) throw new Error("Connections are not initialized");
  if ((context.target?.nodeId ?? null) === input.nodeId) return;
  if (input.nodeId === null && context.portalScope) {
    options.scopes.release(context.scope);
    manager.restoreScopeFrom(context.scope, context.portalScope);
    manager.release(context.portalScope);
    context.portalScope = null;
    context.target = null;
  }
  if (input.nodeId !== null) {
    const existingPortal = context.portalScope;
    const portalScope = existingPortal ?? `${context.scope}:portal`;
    if (!existingPortal) await manager.bind(portalScope, manager.getConnectionId(context.scope));
    try {
      const target = await openWorkspaceScope({
        scope: context.scope,
        commandScope: portalScope,
        nodeId: input.nodeId,
        manager,
        scopes: options.scopes,
        closed: () => context.window.isDestroyed(),
        closedMessage: "Window closed during workspace switch",
        rebound: (replacement) => {
          context.target = replacement;
          options.committed(context);
        },
      });
      context.portalScope = portalScope;
      context.target = target;
    } catch (error) {
      if (!existingPortal) manager.release(portalScope);
      throw error;
    }
  }
  options.committed(context);
}

/** Catalogue edits preserve a leaf until its command connection successfully changes. */
export async function editDesktopConnection(
  context: WorkspaceContext,
  edit:
    | { kind: "connect"; input: Parameters<ConnectionManager["connect"]>[0] }
    | { kind: "use"; connectionId: string }
    | { kind: "forget"; connectionId: string },
  manager: Pick<ConnectionManager, "connect" | "use" | "forget" | "getConnectionId" | "getList">,
  resetTarget: () => Promise<void>,
) {
  if (switching.has(context)) throw new Error("A workspace switch is already in progress");
  switching.add(context);
  let released = false;
  try {
    const scope = context.portalScope ?? context.scope;
    const rebind =
      edit.kind === "connect"
        ? edit.input.select !== false
        : edit.kind === "use" || manager.getConnectionId(scope) === edit.connectionId;
    if (edit.kind === "connect") await manager.connect(edit.input, scope);
    else if (edit.kind === "use") await manager.use(edit.connectionId, scope);
    else await manager.forget(edit.connectionId, scope);
    // The catalogue mutation is complete. No competing workspace operation can
    // enter before the synchronous restore in resetTarget.
    switching.delete(context);
    released = true;
    if (rebind) await resetTarget();
    return manager.getList(context.portalScope ?? context.scope);
  } finally {
    if (!released) switching.delete(context);
  }
}
