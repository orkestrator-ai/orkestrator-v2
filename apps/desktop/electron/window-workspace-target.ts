import type { ConnectionManager } from "./connection-manager.js";
import {
  isDirectBinding,
  openNodeWorkspace,
  type NodeWorkspaceScopes,
  type WorkspaceBinding,
} from "./node-workspaces.js";

export interface WorkspaceContext {
  scope: string;
  portalScope: string | null;
  target: {
    nodeId: string;
    nodeName: string;
    path: "direct" | "relay";
    routeKind?: "https" | "ssh";
    via?: string;
  } | null;
  window: { isDestroyed(): boolean };
}

const switching = new WeakSet<WorkspaceContext>();

/** Keep the old binding and grant until the destination is ready. */
export async function setDesktopWorkspaceTarget<T extends WorkspaceContext>(
  context: T,
  input: { nodeId: string | null },
  options: {
    manager: Pick<
      ConnectionManager,
      | "bind"
      | "getConnectionId"
      | "invoke"
      | "getGatewayBaseUrl"
      | "getRendererRequestAuthorization"
      | "retargetScopeToWorkspace"
      | "restoreScopeFrom"
      | "release"
      | "epochOf"
      | "rebindWorkspace"
    >;
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
    const nodeId = input.nodeId;
    const existingPortal = context.portalScope;
    const portalScope = existingPortal ?? `${context.scope}:portal`;
    if (!existingPortal) await manager.bind(portalScope, manager.getConnectionId(context.scope));
    const invoke = (command: string, args: Record<string, unknown>) =>
      manager.invoke(command, args, portalScope);
    const reopen = async (source = portalScope) => {
      const call = (command: string, args: Record<string, unknown>) =>
        manager.invoke(command, args, source);
      const profile = (await call("get_backend_profile", {}).catch(() => null)) as {
        displayName?: string;
      } | null;
      return openNodeWorkspace({
        nodeId,
        invoke: call,
        commandNodeName: profile?.displayName ?? "command node",
        relay: manager.getGatewayBaseUrl(source)
          ? () => {
              const baseUrl = manager.getGatewayBaseUrl(source);
              const authorization =
                baseUrl &&
                manager.getRendererRequestAuthorization(`${baseUrl}/__orkestrator/invoke`, source);
              return baseUrl && authorization ? { baseUrl, token: authorization.slice(7) } : null;
            }
          : undefined,
      });
    };
    // Keep command access alive until a pending open settles, even if closing
    // the window releases its normal scopes in the meantime.
    const openingScope = `${context.scope}:workspace-open`;
    let binding: WorkspaceBinding | null = null;
    try {
      await manager.bind(openingScope, manager.getConnectionId(portalScope));
      if (context.window.isDestroyed()) throw new Error("Window closed during workspace switch");
      binding = await reopen(openingScope);
      if (context.window.isDestroyed()) throw new Error("Window closed during workspace switch");
      manager.retargetScopeToWorkspace(context.scope, {
        ...binding,
        onUnavailable: () => options.scopes.invalidate(context.scope),
      });
      options.scopes.release(context.scope);
      options.scopes.track(context.scope, binding.workspaceId, {
        invoke,
        reopen: () => reopen(),
        epoch: () => manager.epochOf(manager.getConnectionId(portalScope)),
        retarget: (replacement) => {
          manager.rebindWorkspace(context.scope, replacement);
          context.target = workspaceTargetFrom(nodeId, replacement.params);
        },
        relayed: !isDirectBinding(binding),
      });
      context.portalScope = portalScope;
      context.target = workspaceTargetFrom(nodeId, binding.params);
    } catch (error) {
      if (binding)
        await manager
          .invoke("close_node_workspace", { workspaceId: binding.workspaceId }, openingScope)
          .catch(() => undefined);
      if (!existingPortal) manager.release(portalScope);
      throw error;
    } finally {
      manager.release(openingScope);
    }
  }
  options.committed(context);
}

function workspaceTargetFrom(
  nodeId: string,
  params: Record<string, string>,
): WorkspaceContext["target"] {
  return {
    nodeId,
    nodeName: params.node ?? nodeId,
    path: params.path === "direct" ? "direct" : "relay",
    ...(params.route === "https" || params.route === "ssh" ? { routeKind: params.route } : {}),
    ...(params.via ? { via: params.via } : {}),
  };
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
