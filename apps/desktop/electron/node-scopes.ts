import { randomUUID } from "node:crypto";
import { Effect, Exit, Scope } from "effect";
import type { ConnectionManager } from "./connection-manager.js";
import {
  isDirectBinding,
  openNodeWorkspace,
  type NodeWorkspaceScopes,
  type WorkspaceBinding,
} from "./node-workspaces.js";

/**
 * Per-(window, node) scopes owned by main (`docs/reports/unified-federation.md`
 * §6.3 A, decision 13.5 A).
 *
 * A window can reach any node its command node knows without moving the
 * window itself: main opens a node scope `${windowScope}:node:${nodeId}` on
 * demand, bound to that node's workspace with its own client grant, renewed
 * and upgraded by `NodeWorkspaceScopes`. Two windows on one node hold two
 * grants. The window's renderer opens them through `node-ipc.ts`.
 */

/**
 * How long main keeps a node scope no renderer holds before it releases it
 * (plan item 4002): the desktop's `NODE_SUSPEND_AFTER_MS` (report §8.2). A
 * scope a renderer opened (`orkestrator:nodes:open`, a hold) is released when
 * that renderer disposes its node scope (`orkestrator:nodes:release`, which
 * its lifecycle does when memory pressure takes the node back to summary), on
 * reload or window close; one opened only by node-addressed invokes holds
 * nothing and goes after this long unused.
 */
export const NODE_SCOPE_IDLE_RELEASE_MS = 15 * 60_000;

/** Where a scope bound to another node's workspace is reached. */
export type WorkspaceTarget = {
  nodeId: string;
  nodeName: string;
  path: "direct" | "relay";
  routeKind?: "https" | "ssh";
  via?: string;
};

/** The part of `ConnectionManager` that opening a workspace scope uses. */
export type WorkspaceScopeManager = Pick<
  ConnectionManager,
  | "bind"
  | "getConnectionId"
  | "invoke"
  | "getGatewayBaseUrl"
  | "getRendererRequestAuthorization"
  | "retargetScopeToWorkspace"
  | "release"
  | "epochOf"
  | "rebindWorkspace"
>;

export function workspaceTargetFrom(
  nodeId: string,
  params: Record<string, string>,
): WorkspaceTarget {
  return {
    nodeId,
    nodeName: params.node ?? nodeId,
    path: params.path === "direct" ? "direct" : "relay",
    ...(params.route === "https" || params.route === "ssh" ? { routeKind: params.route } : {}),
    ...(params.via ? { via: params.via } : {}),
  };
}

/**
 * Point `scope` at `nodeId`'s workspace and track its grant: a node scope's open.
 *
 * `commandScope` stays bound to the command node: it opens, renews, reopens
 * and revokes the grant. A pending open keeps its own command access until it
 * settles, so an owner closing meanwhile still revokes the grant it was given;
 * `closed()` is checked before anything is bound for the owner.
 */
export async function openWorkspaceScope(input: {
  scope: string;
  commandScope: string;
  nodeId: string;
  manager: WorkspaceScopeManager;
  scopes: NodeWorkspaceScopes;
  closed(): boolean;
  closedMessage: string;
  /** A later rebind (relay to direct, reopen after a failure) was committed. */
  rebound(target: WorkspaceTarget): void;
}): Promise<WorkspaceTarget> {
  const { scope, commandScope, nodeId, manager, scopes } = input;
  const invoke = (command: string, args: Record<string, unknown>) =>
    manager.invoke(command, args, commandScope);
  const reopen = async (source = commandScope) => {
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
  const openingScope = `${scope}:workspace-open`;
  let binding: WorkspaceBinding | null = null;
  try {
    await manager.bind(openingScope, manager.getConnectionId(commandScope));
    if (input.closed()) throw new Error(input.closedMessage);
    binding = await reopen(openingScope);
    if (input.closed()) throw new Error(input.closedMessage);
    manager.retargetScopeToWorkspace(scope, {
      ...binding,
      onUnavailable: () => scopes.invalidate(scope),
    });
    scopes.release(scope);
    scopes.track(scope, binding.workspaceId, {
      invoke,
      reopen: () => reopen(),
      retain: async () => {
        const retryScope = `${scope}:workspace-retry:${randomUUID()}`;
        try {
          await manager.bind(retryScope, manager.getConnectionId(commandScope));
          return {
            invoke: (command, args) => manager.invoke(command, args, retryScope),
            reopen: () => reopen(retryScope),
            release: () => manager.release(retryScope),
          };
        } catch (error) {
          manager.release(retryScope);
          throw error;
        }
      },
      epoch: () => manager.epochOf(manager.getConnectionId(commandScope)),
      retarget: (replacement) => {
        manager.rebindWorkspace(scope, replacement);
        input.rebound(workspaceTargetFrom(nodeId, replacement.params));
      },
      relayed: !isDirectBinding(binding),
    });
    return workspaceTargetFrom(nodeId, binding.params);
  } catch (error) {
    if (binding)
      await manager
        .invoke("close_node_workspace", { workspaceId: binding.workspaceId }, openingScope)
        .catch(() => undefined);
    throw error;
  } finally {
    manager.release(openingScope);
  }
}

/** Sent on `orkestrator:event` to the window when a node scope was rebound. */
export const NODE_SCOPE_CHANGED_EVENT = "node-scope-changed";

/** One node scope of one window. */
export interface NodeScopeRecord {
  /** `${windowScope}:node:${nodeId}`: the connection scope bound to the node's workspace. */
  scope: string;
  nodeId: string;
  /** Null until the first open succeeds. */
  target: WorkspaceTarget | null;
  /** The node's preview runtime in this window, while one exists (`node-previews.ts`). */
  previewRuntime?: unknown;
  /** The open in flight; every concurrent `ensureNodeScope` awaits this one. */
  opening: Promise<NodeScopeRecord> | null;
  /** `Date.now()` of the last `ensureNodeScope`. */
  lastUsed: number;
  /** Renderer holds; an idle sweep releases only a scope with none. */
  holds: number;
  /**
   * The scope's resources, released in reverse order of acquisition when it
   * closes: preview runtime, grant, workspace binding, command access.
   */
  lifetime: Scope.Closeable;
}

/** A window as node scopes use it. */
export interface NodeScopeWindow {
  /** The window's own scope, on its command node. */
  scope: string;
  window: { isDestroyed(): boolean };
  contents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void };
  nodes: Map<string, NodeScopeRecord>;
}

export interface DesktopNodeScopesOptions {
  manager(): WorkspaceScopeManager | null;
  scopes(): NodeWorkspaceScopes;
  /**
   * Release a scope with no holds after this long unused. Null (the default
   * here) never releases on idle; main passes `NODE_SCOPE_IDLE_RELEASE_MS`.
   */
  idleMs?: number | null;
  now?: () => number;
}

/**
 * Register `release` to run when the node scope closes, before the grant is
 * revoked. Runs at once if the scope has already closed.
 */
export function onNodeScopeRelease(record: NodeScopeRecord, release: () => void): void {
  Effect.runFork(Scope.addFinalizer(record.lifetime, Effect.sync(release)));
}

/** Node scopes of every window, opened on demand. */
export class DesktopNodeScopes {
  private readonly windows = new Set<NodeScopeWindow>();
  /** Opens still settling for released scopes, by scope name. */
  private readonly settling = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: DesktopNodeScopesOptions) {
    this.now = options.now ?? Date.now;
    const idleMs = options.idleMs ?? null;
    if (idleMs !== null && Number.isFinite(idleMs)) {
      this.idleTimer = setInterval(() => this.sweepIdle(), Math.min(idleMs, 30_000));
      this.idleTimer.unref?.();
    }
  }

  /**
   * The window's scope for `nodeId`, opening it if needed. Concurrent calls
   * share one open; a failed open leaves nothing behind and the next call
   * tries again. `hold` adds a renderer hold once the scope is open.
   */
  async ensureNodeScope(
    context: NodeScopeWindow,
    nodeId: string,
    options: { hold?: boolean } = {},
  ): Promise<NodeScopeRecord> {
    let record = context.nodes.get(nodeId);
    if (!record) {
      if (context.window.isDestroyed()) throw new Error("The window is no longer available");
      record = this.create(context, nodeId);
    }
    if (record.opening) await record.opening;
    if (context.nodes.get(nodeId) !== record) throw new Error("Node scope was released");
    record.lastUsed = this.now();
    if (options.hold) record.holds++;
    this.options.scopes().noteUse(record.scope);
    return record;
  }

  /** Drop one renderer hold; the scope stays open until released or idle. */
  dropNodeScopeHold(context: NodeScopeWindow, nodeId: string): void {
    const record = context.nodes.get(nodeId);
    if (record && record.holds > 0) record.holds--;
  }

  /** Close the window's scope for `nodeId` now, including an open in flight. */
  releaseNodeScope(context: NodeScopeWindow, nodeId: string): void {
    const record = context.nodes.get(nodeId);
    if (!record) return;
    context.nodes.delete(nodeId);
    if (context.nodes.size === 0) this.windows.delete(context);
    if (record.opening) {
      const settled = record.opening.then(
        () => undefined,
        () => undefined,
      );
      this.settling.set(record.scope, settled);
      void settled.then(() => {
        if (this.settling.get(record.scope) === settled) this.settling.delete(record.scope);
      });
    }
    Effect.runFork(Scope.close(record.lifetime, Exit.void));
  }

  /** The window closed or its command node changed: every node scope belonged to it. */
  releaseWindowNodeScopes(context: NodeScopeWindow): void {
    for (const nodeId of Array.from(context.nodes.keys())) this.releaseNodeScope(context, nodeId);
    this.windows.delete(context);
  }

  /** Release open scopes with no holds that have been unused for `idleMs`. */
  sweepIdle(): void {
    const idleMs = this.options.idleMs ?? null;
    if (idleMs === null) return;
    const now = this.now();
    for (const context of Array.from(this.windows)) {
      for (const record of Array.from(context.nodes.values())) {
        if (!record.opening && record.holds === 0 && now - record.lastUsed >= idleMs)
          this.releaseNodeScope(context, record.nodeId);
      }
    }
  }

  /** Stop the idle sweep and release every node scope. */
  dispose(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const context of Array.from(this.windows)) this.releaseWindowNodeScopes(context);
  }

  private create(context: NodeScopeWindow, nodeId: string): NodeScopeRecord {
    const scope = `${context.scope}:node:${nodeId}`;
    const record: NodeScopeRecord = {
      scope,
      nodeId,
      target: null,
      opening: null,
      lastUsed: this.now(),
      holds: 0,
      lifetime: Scope.makeUnsafe(),
    };
    context.nodes.set(nodeId, record);
    this.windows.add(context);
    const previous = this.settling.get(scope);
    const open = Effect.suspend(() => this.open(context, record, previous));
    record.opening = Effect.runPromise(open).then(
      () => {
        record.opening = null;
        return record;
      },
      (error: unknown) => {
        record.opening = null;
        if (context.nodes.get(nodeId) === record) {
          context.nodes.delete(nodeId);
          if (context.nodes.size === 0) this.windows.delete(context);
        }
        throw error;
      },
    );
    return record;
  }

  /**
   * Acquire the scope's resources into its lifetime. Each finalizer is
   * registered before the step that needs it, so a release at any point
   * (which closes the lifetime) undoes exactly what was acquired; a step
   * that finishes after the release is undone at once.
   */
  private open(
    context: NodeScopeWindow,
    record: NodeScopeRecord,
    previous: Promise<void> | undefined,
  ): Effect.Effect<void, unknown> {
    const manager = this.options.manager();
    const scopes = this.options.scopes();
    const lifetime = record.lifetime;
    const commandScope = `${record.scope}:command`;
    const closedMessage = "Node scope was released";
    const closed = () => lifetime.state._tag === "Closed" || context.window.isDestroyed();
    const stillOpen = Effect.suspend(() =>
      closed() ? Effect.fail(new Error(closedMessage)) : Effect.void,
    );
    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (error) => error });
    const rebound = (target: WorkspaceTarget) => {
      record.target = target;
      if (!context.contents.isDestroyed())
        context.contents.send("orkestrator:event", NODE_SCOPE_CHANGED_EVENT, {
          nodeId: record.nodeId,
        });
    };
    const program = Effect.gen(function* () {
      if (!manager) return yield* Effect.fail(new Error("Connections are not initialized"));
      // A released scope's open settles first; it still holds the scope names.
      if (previous) yield* Effect.promise(() => previous);
      yield* stillOpen;
      // The command node is captured now: renewals and revokes stay with the
      // node that issued the grant even if the window later moves.
      const commandConnectionId = yield* Effect.try({
        try: () => manager.getConnectionId(context.scope),
        catch: (error) => error,
      });
      yield* Effect.acquireRelease(
        attempt(() => manager.bind(commandScope, commandConnectionId)),
        () => Effect.sync(() => manager.release(commandScope)),
      );
      yield* stillOpen;
      yield* Effect.acquireRelease(
        attempt(() => manager.bind(record.scope, commandConnectionId)),
        () => Effect.sync(() => manager.release(record.scope)),
      );
      // Revokes the tracked grant through `commandScope`, which outlives it.
      yield* Scope.addFinalizer(
        lifetime,
        Effect.sync(() => scopes.release(record.scope)),
      );
      yield* stillOpen;
      record.target = yield* attempt(() =>
        openWorkspaceScope({
          scope: record.scope,
          commandScope,
          nodeId: record.nodeId,
          manager,
          scopes,
          closed,
          closedMessage,
          rebound,
        }),
      );
    });
    return program.pipe(
      Scope.provide(lifetime),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(lifetime, exit) : Effect.void)),
    );
  }
}
