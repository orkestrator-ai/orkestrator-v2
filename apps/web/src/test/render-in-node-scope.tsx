/**
 * Renders UI inside a fresh window scope and node scope backed by a
 * `FakeNodeClient`. Test-only.
 *
 * ```tsx
 * import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
 *
 * afterEach(cleanupNodeScopes);
 *
 * test("loads environments", async () => {
 *   const client = new FakeNodeClient({ invoke: { list_environments: [] } });
 *   const { scope } = renderInNodeScope(<EnvironmentList />, { client });
 *   client.emit("resource-changed", { kind: "environment" });
 *   expect(client.calls("list_environments")).toHaveLength(2);
 *   expect(scope.store(environmentStore).getState().environments).toEqual([]);
 * });
 * ```
 *
 * Each call creates its own `WindowScope`, never the app's, so tests do not
 * share scope state. `cleanupNodeScopes()` unmounts every tree rendered here
 * and disposes its window scope (stopping services and releasing budgets);
 * call it in `afterEach` (invariant 15).
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  NegotiatedDomains,
  NodeClient,
  NodeConnectionState,
  Unlisten,
} from "@orkestrator/protocol/node-client";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import type { NodeScope, NodeScopeRole } from "@/lib/node-scope/node-scope";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import { createSignal } from "@/lib/node-scope/signal";
import { typedListen } from "@/lib/node-scope/typed-listen";
import { WindowScope } from "@/lib/node-scope/window-scope";

export const FAKE_NODE_ID = "bk_fake-node" as BackendId;

/** A canned answer, or a function of the call's arguments (which may throw or reject). */
export type FakeInvokeResponse = unknown | ((args: Readonly<Record<string, unknown>>) => unknown);

export interface FakeNodeClientOptions {
  nodeId?: BackendId;
  /** Responses by command name. A command with none rejects. */
  invoke?: Readonly<Record<string, FakeInvokeResponse>>;
  connection?: NodeConnectionState;
  domains?: NegotiatedDomains | null;
}

export interface FakeInvocation {
  readonly command: string;
  readonly args: Readonly<Record<string, unknown>>;
}

const TERMINAL_OUTPUT_EVENT_PREFIX = "terminal-output-";

/** An in-memory `NodeClient`: an invoke map, `emit` for events, and a settable connection. */
export class FakeNodeClient implements NodeClient {
  readonly nodeId: BackendId;
  readonly invocations: FakeInvocation[] = [];
  readonly connection = createSignal<NodeConnectionState>("live");
  readonly domains = createSignal<NegotiatedDomains | null>(null);
  readonly terminal = {
    listenOutput: (sessionId: string, handler: (payload: unknown) => void): Unlisten =>
      this.listenRaw(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`, handler),
    outputReady: (sessionId: string): Promise<void> =>
      this.eventStreamReady(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`),
  };
  suspended = false;
  disposed = false;

  private readonly responses = new Map<string, FakeInvokeResponse>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  constructor(options: FakeNodeClientOptions = {}) {
    this.nodeId = options.nodeId ?? FAKE_NODE_ID;
    for (const [command, response] of Object.entries(options.invoke ?? {})) {
      this.responses.set(command, response);
    }
    if (options.connection) this.connection.set(options.connection);
    if (options.domains !== undefined) this.domains.set(options.domains);
  }

  /** Sets or replaces the response for `command`. */
  respond(command: string, response: FakeInvokeResponse): this {
    this.responses.set(command, response);
    return this;
  }

  async invokeRaw<T = unknown>(
    command: string,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    this.invocations.push({ command, args });
    if (this.disposed) throw new Error("FakeNodeClient is disposed.");
    if (!this.responses.has(command)) {
      throw new Error(`FakeNodeClient has no response for ${command}.`);
    }
    const response = this.responses.get(command);
    return (await (typeof response === "function" ? response(args) : response)) as T;
  }

  /** Typed `listen` (plan item 7011), over {@link listenRaw}. */
  readonly listen: NodeClient["listen"] = typedListen((event, handler) =>
    this.listenRaw(event, handler),
  );

  listenRaw<T = unknown>(event: string, handler: (payload: T) => void): Unlisten {
    if (this.disposed) return () => {};
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    const callback = handler as (payload: unknown) => void;
    set.add(callback);
    return () => {
      set.delete(callback);
      if (set.size === 0 && this.listeners.get(event) === set) this.listeners.delete(event);
    };
  }

  eventStreamReady(_event?: string): Promise<void> {
    return Promise.resolve();
  }

  /** Delivers `payload` to every listener of `event`, synchronously. */
  emit(event: string, payload?: unknown): void {
    for (const handler of Array.from(this.listeners.get(event) ?? [])) handler(payload);
  }

  emitTerminalOutput(sessionId: string, payload: unknown): void {
    this.emit(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`, payload);
  }

  listenerCount(event?: string): number {
    if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  calls(command: string): FakeInvocation[] {
    return this.invocations.filter((call) => call.command === command);
  }

  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export interface RenderInNodeScopeOptions extends Omit<RenderOptions, "wrapper"> {
  nodeId?: BackendId;
  role?: NodeScopeRole;
  client?: NodeClient;
  /** Reuse a window scope, to render a second node next to the first. */
  windowScope?: WindowScope;
}

export type RenderInNodeScopeResult = RenderResult & {
  scope: NodeScope;
  windowScope: WindowScope;
  client: NodeClient;
};

const rendered: Array<{ result: RenderResult; windowScope: WindowScope }> = [];

export function renderInNodeScope(
  ui: ReactElement,
  {
    nodeId,
    role = "command",
    client,
    windowScope,
    ...renderOptions
  }: RenderInNodeScopeOptions = {},
): RenderInNodeScopeResult {
  const nodeClient = client ?? new FakeNodeClient({ nodeId });
  if (nodeId && nodeClient.nodeId !== nodeId) {
    throw new Error(`renderInNodeScope: client is for ${nodeClient.nodeId}, not ${nodeId}.`);
  }
  const targetWindow = windowScope ?? new WindowScope();
  const scope =
    targetWindow.get(nodeClient.nodeId) ?? targetWindow.open({ role, client: nodeClient });
  const result = render(ui, {
    ...renderOptions,
    wrapper: ({ children }) => (
      <WindowScopeProvider windowScope={targetWindow}>
        <NodeScopeProvider scope={scope}>{children}</NodeScopeProvider>
      </WindowScopeProvider>
    ),
  });
  rendered.push({ result, windowScope: targetWindow });
  return Object.assign(result, { scope, windowScope: targetWindow, client: nodeClient });
}

/** Unmounts everything `renderInNodeScope` rendered and disposes its window scopes. */
export function cleanupNodeScopes(): void {
  for (const { result, windowScope } of rendered.splice(0)) {
    result.unmount();
    windowScope.dispose();
  }
}
