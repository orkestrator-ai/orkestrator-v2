/**
 * The Phase 2 exit proof (plan item 2013, report §12 Phase 2): one renderer
 * holds its command scope and a leaf scope at once, against real backends.
 *
 * Test-only. `renderer-entry.tsx` installs it only in a Vite dev renderer of
 * an agent-test (`dev:test`) profile (`import.meta.env.DEV` and
 * `VITE_ORKESTRATOR_PROFILE_FLAVOR === "agent-test"`, which only the
 * agent-test launcher sets), as `window.orkestratorScopeProof`; a production
 * build drops the import with the dead branch. The
 * app never calls it, so nothing visible changes. Specs drive it with
 * `page.evaluate` (`e2e/agent-testing/scope-proof*.spec.ts`).
 *
 * `run({ leafNodeId, leafEnvironmentId })` opens the leaf as a `leaf` scope of
 * the app's own window scope, next to the command scope:
 * - browser: through the node-client registry (plan item 2004), which opens a
 *   workspace grant on the command node and probes the leaf's direct origin,
 *   falling back to the command node's relay;
 * - desktop: through the preload's `node(nodeId)` (plan items 2007, 2010),
 *   where main opens the node scope and chooses the route.
 * Then, on each scope: a read (`get_node_status`, which names the node that
 * answered, and `get_projects`); a `resource-changed` listener, proven by a
 * kanban task added and deleted on that scope's own first project, and
 * checked for cross-talk (the other scope must never see it). On the leaf it
 * opens a local terminal in `leafEnvironmentId`, writes a command whose
 * output differs from its echo, and waits for that output on the leaf's
 * terminal stream. The report carries ids, timings and booleans only: no
 * credential, terminal bytes or project content.
 */

import { resourceChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeConnectionState, Unlisten } from "@orkestrator/protocol/node-client";
import { decodeTerminalOutputPayload, type TerminalOutputPayload } from "@/hooks/useTerminal";
import { getWindowScope } from "./app-window-scope";
import { createDesktopNodeClient } from "./desktop-node-client";
import { NO_ARGS, nodesApi } from "./domains/nodes";
import { createNodeClientRegistry, type NodeClientRegistry } from "./node-clients";
import type { NodeScope } from "./node-scope";
import type { WindowScope } from "./window-scope";
import { kanbanClient } from "@orkestrator/protocol/contract/domains/kanban";

export const SCOPE_PROOF_GLOBAL = "orkestratorScopeProof";

type HostApi = NonNullable<Window["orkestrator"]>;

export interface ScopeProofRoute {
  readonly path: "direct" | "relay" | null;
  /** Where the leaf's commands and streams go: its own origin, or a relay base. */
  readonly baseUrl: string | null;
  readonly relayed: boolean;
  readonly routeKind?: string;
  readonly via?: string;
}

export interface ScopeProofScopeReport {
  readonly role: "command" | "leaf";
  readonly scopeNodeId: string;
  /** `get_node_status().nodeId` read over this scope: the node that answered. */
  readonly answeredBy: string | null;
  readonly projects: number;
  readonly readMs: number;
  readonly resourceChanged: {
    readonly projectId: string | null;
    readonly received: boolean;
    readonly ms: number;
    /** Changes for this scope's task the other scope's listener received (must be 0). */
    readonly seenByOtherScope: number;
  };
  readonly connection: NodeConnectionState;
}

export interface ScopeProofTerminalReport {
  readonly opened: boolean;
  readonly outputReadyMs: number | null;
  /** The command's output (not its echo) arrived on the leaf's terminal stream. */
  readonly outputSeen: boolean;
  readonly outputMs: number | null;
  readonly frames: number;
  readonly closed: boolean;
  readonly error?: string;
}

export interface ScopeProofReport {
  readonly host: "browser" | "desktop";
  readonly commandNodeId: string;
  readonly leafNodeId: string;
  readonly openMs: number;
  readonly route: ScopeProofRoute | null;
  /** The window scope's node scopes while both were open. */
  readonly openScopes: ReadonlyArray<{ readonly nodeId: string; readonly role: string }>;
  readonly command: ScopeProofScopeReport;
  readonly leaf: ScopeProofScopeReport;
  readonly terminal: ScopeProofTerminalReport;
  /** Whether the leaf scope was left open (`keepOpen`) or released. */
  readonly leafScopeOpenAfterRun: boolean;
}

export interface ScopeProofRunInput {
  readonly leafNodeId: string;
  /** A local environment on the leaf for the terminal. */
  readonly leafEnvironmentId: string;
  readonly timeoutMs?: number;
  /**
   * Leave the leaf scope open after the run, with a `resource-changed`
   * listener on each scope (so both event streams stay open), until `close`.
   * For connection measurements.
   */
  readonly keepOpen?: boolean;
}

/** How one host opens a leaf scope beside the command scope. */
export interface ScopeProofHost {
  readonly kind: "browser" | "desktop";
  openLeafScope(windowScope: WindowScope, nodeId: BackendId): Promise<NodeScope>;
  route(scope: NodeScope): Promise<ScopeProofRoute | null>;
}

export interface ScopeProofHarness {
  run(input: ScopeProofRunInput): Promise<ScopeProofReport>;
  /** Opens (or answers) the leaf scope and its route. */
  open(leafNodeId: string): Promise<{ route: ScopeProofRoute | null; openMs: number }>;
  /** Stops a kept run's listeners and disposes the leaf scope (revokes its grant). */
  close(leafNodeId: string): void;
  scopes(): ReadonlyArray<{ nodeId: string; role: string; connection: NodeConnectionState }>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** The browser host: the node-client registry, direct first then relay. */
export function browserScopeProofHost(registry?: NodeClientRegistry): ScopeProofHost {
  let created: NodeClientRegistry | null = registry ?? null;
  const leafRegistry = () => (created ??= createNodeClientRegistry());
  return {
    kind: "browser",
    openLeafScope: (windowScope, nodeId) => leafRegistry().openLeafScope(windowScope, nodeId),
    async route(scope) {
      const client = scope.client as Partial<import("./node-clients").LeafNodeClient>;
      const route = client.route?.get();
      if (!route) return null;
      return {
        path: route.path,
        baseUrl: route.baseUrl,
        relayed: route.baseUrl.includes("/__orkestrator/nodes/"),
        ...(route.routeKind ? { routeKind: route.routeKind } : {}),
        ...(route.via ? { via: route.via } : {}),
      };
    },
  };
}

/** The desktop host: main's node scope through the preload's `node(nodeId)`. */
export function desktopScopeProofHost(host: () => HostApi | undefined): ScopeProofHost {
  return {
    kind: "desktop",
    async openLeafScope(windowScope, nodeId) {
      const open = windowScope.get(nodeId);
      if (open) return open;
      const client = createDesktopNodeClient({ nodeId, host });
      const scope = windowScope.open({ role: "leaf", client });
      // Opening the stream opens main's node scope (one hold).
      await client.eventStreamReady();
      return scope;
    },
    async route(scope) {
      const snapshot = (await host()?.nodes?.gateway(scope.nodeId)) as {
        path?: string;
        baseUrl?: string;
        routeKind?: string;
        via?: string;
      } | null;
      if (!snapshot) return null;
      const path = snapshot.path === "direct" || snapshot.path === "relay" ? snapshot.path : null;
      const baseUrl = typeof snapshot.baseUrl === "string" ? snapshot.baseUrl : null;
      return {
        path,
        baseUrl,
        relayed: Boolean(baseUrl?.includes("/__orkestrator/nodes/")),
        ...(snapshot.routeKind ? { routeKind: snapshot.routeKind } : {}),
        ...(snapshot.via ? { via: snapshot.via } : {}),
      };
    },
  };
}

/** The desktop preload API when this renderer has one, else `undefined`. */
export function desktopHostApi(target: Window): HostApi | undefined {
  if (typeof target.orkestrator?.node === "function") return target.orkestrator;
  const preload = target.orkestratorDesktopHost?.api;
  return typeof preload?.node === "function" ? preload : undefined;
}

interface Watch {
  readonly role: "command" | "leaf";
  readonly scope: NodeScope;
  readonly changes: Array<{ id: string; resource: string }>;
  stop: Unlisten;
}

function watchResourceChanges(role: Watch["role"], scope: NodeScope): Watch {
  const watch: Watch = { role, scope, changes: [], stop: () => {} };
  watch.stop = scope.client.listen(resourceChangedEvent, (change) => {
    watch.changes.push({ id: change.id, resource: change.resource });
  });
  return watch;
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

async function readScope(scope: NodeScope, timeoutMs: number) {
  const started = performance.now();
  const status = await within(
    nodesApi(scope.client).get_node_status(NO_ARGS),
    timeoutMs,
    "get_node_status",
  );
  const projects = await within(
    scope.client.invokeRaw<Array<{ id: string }>>("get_projects"),
    timeoutMs,
    "get_projects",
  );
  return {
    answeredBy: typeof status?.nodeId === "string" ? status.nodeId : null,
    projects: Array.isArray(projects) ? projects : [],
    readMs: elapsed(started),
  };
}

/** Adds and deletes a kanban task on the scope's project; times the first change event. */
async function proveResourceChanged(
  own: Watch,
  other: Watch,
  projectId: string | null,
  nonce: string,
  timeoutMs: number,
  settleMs: number,
): Promise<ScopeProofScopeReport["resourceChanged"]> {
  if (!projectId) return { projectId, received: false, ms: 0, seenByOtherScope: 0 };
  const started = performance.now();
  const before = own.changes.length;
  // Through the scope's `kanban` client (plan item 7008): the adapter its node's hello implies.
  const kanban = own.scope.domain(kanbanClient).api();
  const task = await kanban.add_kanban_task({
    projectId,
    title: `scope proof ${nonce}`,
    description: "Plan item 2013 scope proof; deleted at once.",
  });
  const received = await waitFor(
    () =>
      own.changes
        .slice(before)
        .some((change) => change.resource === "kanban" && change.id === projectId),
    timeoutMs,
  );
  const ms = elapsed(started);
  if (task?.id) {
    await kanban.delete_kanban_task({ taskId: task.id }).catch(() => undefined);
  }
  // Give a stray cross-scope delivery the chance to arrive.
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  const seenByOtherScope = other.changes.filter((change) => change.id === projectId).length;
  return { projectId, received, ms, seenByOtherScope };
}

async function proveTerminal(
  scope: NodeScope,
  environmentId: string,
  nonce: string,
  timeoutMs: number,
): Promise<ScopeProofTerminalReport> {
  let sessionId: string | null = null;
  let frames = 0;
  let tail = "";
  let stop: Unlisten = () => {};
  let outputReadyMs: number | null = null;
  let outputMs: number | null = null;
  // `$((40+2))` prints 42 only when the shell ran it; the echo shows the expression.
  const expected = `uf2013-42-${nonce}`;
  try {
    const created = await within(
      scope.client.invokeRaw<{ sessionId?: string } | string>("create_local_terminal_session", {
        environmentId,
        cols: 100,
        rows: 30,
        trackEnvironmentActivity: false,
      }),
      timeoutMs,
      "create_local_terminal_session",
    );
    sessionId = typeof created === "string" ? created : (created?.sessionId ?? null);
    if (!sessionId) throw new Error("The leaf returned no terminal session.");
    const session = sessionId;
    const decoder = new TextDecoder();
    stop = scope.client.terminal.listenOutput(session, (payload) => {
      const bytes = decodeTerminalOutputPayload(payload as TerminalOutputPayload);
      if (!bytes) return;
      frames += 1;
      tail = (tail + decoder.decode(bytes, { stream: true })).slice(-8192);
    });
    const readyStarted = performance.now();
    await within(scope.client.terminal.outputReady(session), timeoutMs, "terminal output stream");
    outputReadyMs = elapsed(readyStarted);
    await scope.client.invokeRaw("start_local_terminal_session", { sessionId: session });
    const started = performance.now();
    await scope.client.invokeRaw("local_terminal_write", {
      sessionId: session,
      data: `echo uf2013-$((40+2))-${nonce}\r`,
    });
    const outputSeen = await waitFor(() => tail.includes(expected), timeoutMs);
    outputMs = outputSeen ? elapsed(started) : null;
    return { opened: true, outputReadyMs, outputSeen, outputMs, frames, closed: false };
  } catch (error) {
    return {
      opened: sessionId !== null,
      outputReadyMs,
      outputSeen: false,
      outputMs,
      frames,
      closed: false,
      error: message(error),
    };
  } finally {
    stop();
    tail = "";
    if (sessionId) {
      await scope.client
        .invokeRaw("close_local_terminal_session", { sessionId })
        .catch(() => undefined);
    }
  }
}

export function createScopeProofHarness(options: {
  readonly host: ScopeProofHost;
  readonly windowScope?: () => WindowScope;
  /** How long to wait for a stray cross-scope change after each proof. */
  readonly settleMs?: number;
}): ScopeProofHarness {
  const windowScope = options.windowScope ?? getWindowScope;
  const host = options.host;
  const settleMs = options.settleMs ?? 500;
  /** The listeners of a run with `keepOpen`, kept so its streams stay open until `close`. */
  const held = new Map<string, Watch[]>();
  const stopHeld = (leafNodeId: string) => {
    for (const watch of held.get(leafNodeId) ?? []) watch.stop();
    held.delete(leafNodeId);
  };

  const open = async (leafNodeId: string) => {
    const started = performance.now();
    const scope = await host.openLeafScope(windowScope(), leafNodeId as BackendId);
    return { scope, openMs: elapsed(started), route: await host.route(scope) };
  };

  const scopeReport = async (
    watch: Watch,
    other: Watch,
    nonce: string,
    timeoutMs: number,
  ): Promise<ScopeProofScopeReport> => {
    const read = await readScope(watch.scope, timeoutMs);
    const resourceChanged = await proveResourceChanged(
      watch,
      other,
      read.projects[0]?.id ?? null,
      `${watch.role}-${nonce}`,
      timeoutMs,
      settleMs,
    );
    return {
      role: watch.role,
      scopeNodeId: watch.scope.nodeId,
      answeredBy: read.answeredBy,
      projects: read.projects.length,
      readMs: read.readMs,
      resourceChanged,
      connection: watch.scope.client.connection.get(),
    };
  };

  return {
    async run(input) {
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const nonce = Math.random().toString(36).slice(2, 10);
      const command = windowScope().commandScope();
      const opened = await within(open(input.leafNodeId), timeoutMs * 2, "opening the leaf");
      const leaf = opened.scope;
      const commandWatch = watchResourceChanges("command", command);
      const leafWatch = watchResourceChanges("leaf", leaf);
      try {
        await within(command.client.eventStreamReady(), timeoutMs, "the command stream");
        await within(leaf.client.eventStreamReady(), timeoutMs, "the leaf stream");
        const openScopes = windowScope()
          .nodeScopes.get()
          .map((scope) => ({ nodeId: scope.nodeId, role: scope.role }));
        const commandReport = await scopeReport(commandWatch, leafWatch, nonce, timeoutMs);
        const leafReport = await scopeReport(leafWatch, commandWatch, nonce, timeoutMs);
        const terminal = await proveTerminal(leaf, input.leafEnvironmentId, nonce, timeoutMs);
        return {
          host: host.kind,
          commandNodeId: command.nodeId,
          leafNodeId: leaf.nodeId,
          openMs: opened.openMs,
          route: (await host.route(leaf)) ?? opened.route,
          openScopes,
          command: commandReport,
          leaf: leafReport,
          terminal,
          leafScopeOpenAfterRun: input.keepOpen === true,
        };
      } finally {
        stopHeld(input.leafNodeId);
        if (input.keepOpen) {
          held.set(input.leafNodeId, [commandWatch, leafWatch]);
        } else {
          commandWatch.stop();
          leafWatch.stop();
          leaf.dispose();
        }
      }
    },
    async open(leafNodeId) {
      const { route, openMs } = await open(leafNodeId);
      return { route, openMs };
    },
    close(leafNodeId) {
      stopHeld(leafNodeId);
      windowScope()
        .get(leafNodeId as BackendId)
        ?.dispose();
    },
    scopes: () =>
      windowScope()
        .nodeScopes.get()
        .map((scope) => ({
          nodeId: scope.nodeId,
          role: scope.role,
          connection: scope.client.connection.get(),
        })),
  };
}

/** Installs `window.orkestratorScopeProof` for this renderer's host. */
export function installScopeProofHarness(target: Window = window): ScopeProofHarness {
  const desktop = desktopHostApi(target);
  const harness = createScopeProofHarness({
    host: desktop ? desktopScopeProofHost(() => desktopHostApi(target)) : browserScopeProofHost(),
  });
  (target as unknown as Record<string, unknown>)[SCOPE_PROOF_GLOBAL] = harness;
  return harness;
}
