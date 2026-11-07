import { onNodeScopeRelease, type NodeScopeRecord } from "./node-scopes.js";

/**
 * Browser previews of other nodes in a window (`docs/reports/unified-federation.md`
 * §6.3 E).
 *
 * A window renderer can show a preview tab for any node its command node
 * knows. The first `attach` that names a node creates that node's preview
 * runtime in the window, on the window's node scope (`node-scopes.ts`): its
 * own preview partition (`node:<nodeId>`, the key the retired workspace realms
 * used, so their preview site data carried over), its own service transport
 * over the node scope's connection, and native views in window coordinates.
 *
 * Main keeps `tabId → runtime` per window, and every
 * `orkestrator:browser-preview:*` handler that names a tab resolves the
 * runtime through it; a tab main does not know belongs to the window's own
 * runtime (the command node's), as before.
 *
 * Lifetime: a runtime holds its node scope while it shows a tab. Destroying
 * its last tab disposes it and drops the hold; a release of the node scope
 * (explicit, idle, window close or reload, command-node change) disposes it
 * first, before the grant is revoked, through `onNodeScopeRelease`.
 *
 * Z-order and focus (inferred risk, tested in plan item 4006): every runtime
 * adds its views to the same window `contentView`, alongside the window's own
 * previews and artifact hosts. A view added later is drawn above
 * the others, and nothing here orders views across runtimes; the renderer
 * shows one preview tab per region, which keeps overlaps to tabs it hides.
 */

/** A node's preview partition key. */
export function nodePreviewPartitionKey(nodeId: string): string {
  return `node:${nodeId}`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const GATEWAY_PREVIEW_PATH = /^\/__orkestrator\/browser\/loopback\/([1-9]\d{0,4})(\/.*)?$/;

/**
 * The `Origin` a node runtime's authorized preview requests present: the
 * node gateway's own. The node admits a workspace grant's requests only from
 * its own origin or an attached command node's portal origins, so the
 * desktop's default (`https://orkestrator.dev`, which a command node's
 * gateway allows for its durable token) is refused there. Main sets it only
 * on requests it authorizes inside the view's own preview namespace.
 */
export function nodePreviewRequestOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The address a node runtime loads for an address-bar URL (4006 Finding 1):
 * always through that node's own gateway (`nodeBaseUrl`, the node scope's
 * current route), so a leaf's tab can never show this computer's loopback
 * page or another node's gateway. The renderer sends the canonical address
 * (`http://localhost:3000/x`, the desktop node client's `resolvePreviewUrl`);
 * a gateway preview path on another origin (an attach chosen before the
 * route was known, or before a relay-to-direct rebind) is moved onto the
 * node's base too. Main resolves on every attach and navigation, so the
 * address follows the scope's route. Throws while the scope has no route
 * (parked mid-reopen); the renderer re-attaches.
 */
export function nodePreviewUrl(nodeBaseUrl: string | null, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let port: string;
  let target: string;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    port = url.port || "80";
    target = `${url.pathname}${url.search}${url.hash}`;
  } else {
    const match = GATEWAY_PREVIEW_PATH.exec(url.pathname);
    if (!match || (url.protocol !== "http:" && url.protocol !== "https:")) return value;
    port = match[1]!;
    target = `${match[2] ?? "/"}${url.search}${url.hash}`;
  }
  if (!nodeBaseUrl)
    throw new Error("This machine is reconnecting; its preview opens once it is back.");
  return `${nodeBaseUrl.replace(/\/$/, "")}/__orkestrator/browser/loopback/${port}${target}`;
}

/** The part of a preview controller this module calls. */
export interface NodePreviewController {
  destroy(tabId: string): void;
}

/** One node's preview runtime in one window. */
export interface NodePreviewRuntime<C extends NodePreviewController> {
  readonly controller: C;
  /** The persisted partition the node's address-bar previews share in this window. */
  readonly partition: string;
  /** Service partitions the runtime's transport holds (for partition retention). */
  partitionsInUse(): Iterable<string>;
  /** Destroy every view and release the service transports. Called once. */
  dispose(): void;
}

/** What `NodeScopeRecord.previewRuntime` holds. */
interface RuntimeEntry<C extends NodePreviewController> {
  runtime: NodePreviewRuntime<C>;
  /** Tabs this runtime shows. */
  tabs: Set<string>;
  /** Whether the entry holds its node scope (it shows at least one tab). */
  held: boolean;
}

/** A window as preview routing uses it. */
export interface NodePreviewWindow {
  nodes: Map<string, NodeScopeRecord>;
}

export interface NodePreviewRuntimesOptions<
  W extends NodePreviewWindow,
  C extends NodePreviewController,
> {
  /** The window's own runtime (its command node's), or null when unavailable. */
  windowPreviews(context: W): C | null;
  /** Whether `nodeId` is the window's command node, whose previews are the window's own. */
  isCommandNode(context: W, nodeId: string): boolean;
  /** Open (or reuse) the window's scope for `nodeId`; refuses an unknown node. */
  openNode(context: W, nodeId: string): Promise<NodeScopeRecord>;
  /**
   * Build the node's runtime in this window: partition from `partitionKey`,
   * transport over `record.scope`'s connection, views in window coordinates,
   * events to the window's renderer.
   */
  createRuntime(context: W, record: NodeScopeRecord, partitionKey: string): NodePreviewRuntime<C>;
}

const UNAVAILABLE = "Native browser previews are unavailable";

/** `tabId → runtime` for every window, and each node scope's runtime. */
export class NodePreviewRuntimes<W extends NodePreviewWindow, C extends NodePreviewController> {
  /** Tabs on node runtimes, per window. A tab not listed is the window's own. */
  private readonly tabs = new WeakMap<W, Map<string, NodeScopeRecord>>();
  /** Records whose release hook is registered. */
  private readonly wired = new WeakSet<NodeScopeRecord>();

  constructor(private readonly options: NodePreviewRuntimesOptions<W, C>) {}

  /**
   * The runtime an attach of `tabId` goes to, recorded for the tab's later
   * calls. No node, or the command node, is the window's own runtime; any
   * other node's runtime is created on its first attach.
   */
  async forAttach(context: W, tabId: string, nodeId: string | undefined): Promise<C> {
    if (nodeId === undefined || this.options.isCommandNode(context, nodeId)) {
      const previous = this.tabs.get(context)?.get(tabId);
      if (previous) this.detach(context, tabId, previous);
      return this.window(context);
    }
    const record = await this.options.openNode(context, nodeId);
    if (context.nodes.get(nodeId) !== record) throw new Error("Node scope was released");
    const entry = this.entryFor(context, record);
    const tabs = this.tabsOf(context);
    const previous = tabs.get(tabId);
    if (previous !== record) {
      if (previous) this.detach(context, tabId, previous);
      // A tab that moved from the command node leaves no view behind there.
      else this.options.windowPreviews(context)?.destroy(tabId);
      tabs.set(tabId, record);
    }
    entry.tabs.add(tabId);
    if (!entry.held) {
      entry.held = true;
      record.holds++;
    }
    return entry.runtime.controller;
  }

  /** The runtime showing `tabId`: its node's, else the window's own. */
  forTab(context: W, tabId: string): C {
    const record = this.tabs.get(context)?.get(tabId);
    const entry = record && entryOf<C>(record);
    return entry ? entry.runtime.controller : this.window(context);
  }

  /**
   * The runtime for a call that names a node but no tab (a service's site
   * data, its external browser). Creates the node's runtime if needed; it
   * holds nothing until it shows a tab.
   */
  async forNode(context: W, nodeId: string | undefined): Promise<C> {
    if (nodeId === undefined || this.options.isCommandNode(context, nodeId))
      return this.window(context);
    const record = await this.options.openNode(context, nodeId);
    if (context.nodes.get(nodeId) !== record) throw new Error("Node scope was released");
    return this.entryFor(context, record).runtime.controller;
  }

  /** Destroy `tabId` where it lives. A node runtime with no tabs left is disposed. */
  destroy(context: W, tabId: string): void {
    const record = this.tabs.get(context)?.get(tabId);
    if (!record) {
      this.window(context).destroy(tabId);
      return;
    }
    this.detach(context, tabId, record);
  }

  /** The node's runtime in this window, if one exists. */
  runtimeOf(record: NodeScopeRecord): NodePreviewRuntime<C> | null {
    return entryOf<C>(record)?.runtime ?? null;
  }

  /** Every node runtime of the window, for partition retention. */
  runtimes(context: W): NodePreviewRuntime<C>[] {
    const result: NodePreviewRuntime<C>[] = [];
    for (const record of context.nodes.values()) {
      const runtime = this.runtimeOf(record);
      if (runtime) result.push(runtime);
    }
    return result;
  }

  private window(context: W): C {
    const controller = this.options.windowPreviews(context);
    if (!controller) throw new Error(UNAVAILABLE);
    return controller;
  }

  private tabsOf(context: W): Map<string, NodeScopeRecord> {
    let tabs = this.tabs.get(context);
    if (!tabs) {
      tabs = new Map();
      this.tabs.set(context, tabs);
    }
    return tabs;
  }

  private entryFor(context: W, record: NodeScopeRecord): RuntimeEntry<C> {
    const existing = entryOf<C>(record);
    if (existing) return existing;
    const entry: RuntimeEntry<C> = {
      runtime: this.options.createRuntime(context, record, nodePreviewPartitionKey(record.nodeId)),
      tabs: new Set(),
      held: false,
    };
    record.previewRuntime = entry;
    if (!this.wired.has(record)) {
      this.wired.add(record);
      // A finalizer of the scope's Effect lifetime: runs before the grant is
      // revoked, on every release path, and at once if the scope already closed.
      onNodeScopeRelease(record, () => this.dispose(context, record));
    }
    return entry;
  }

  /** Take `tabId` off `record`'s runtime; dispose the runtime when it was the last. */
  private detach(context: W, tabId: string, record: NodeScopeRecord): void {
    this.tabs.get(context)?.delete(tabId);
    const entry = entryOf<C>(record);
    if (!entry) return;
    entry.runtime.controller.destroy(tabId);
    entry.tabs.delete(tabId);
    if (entry.tabs.size === 0) this.dispose(context, record);
  }

  /** Dispose `record`'s runtime, forget its tabs and drop its hold. */
  private dispose(context: W, record: NodeScopeRecord): void {
    const entry = entryOf<C>(record);
    if (!entry) return;
    record.previewRuntime = undefined;
    const tabs = this.tabs.get(context);
    for (const tabId of entry.tabs) if (tabs?.get(tabId) === record) tabs.delete(tabId);
    entry.tabs.clear();
    if (entry.held && record.holds > 0) record.holds--;
    entry.held = false;
    entry.runtime.dispose();
  }
}

function entryOf<C extends NodePreviewController>(
  record: NodeScopeRecord,
): RuntimeEntry<C> | undefined {
  return record.previewRuntime as RuntimeEntry<C> | undefined;
}

/**
 * The IPC routing (`BrowserPreviewRouting` in `ipc.ts`) over `runtimes`.
 * `window` is the sender's window context; `nodeWindow` is the same window,
 * for calls that open one of its node scopes.
 */
export function routeBrowserPreviews<
  E,
  W extends NodePreviewWindow,
  C extends NodePreviewController,
>(runtimes: NodePreviewRuntimes<W, C>, contexts: { window(event: E): W; nodeWindow(event: E): W }) {
  const contextFor = (event: E, nodeId: string | undefined) =>
    nodeId === undefined ? contexts.window(event) : contexts.nodeWindow(event);
  return {
    forAttach: (event: E, tabId: string, nodeId: string | undefined) =>
      runtimes.forAttach(contextFor(event, nodeId), tabId, nodeId),
    forTab: (event: E, tabId: string) => runtimes.forTab(contexts.window(event), tabId),
    forNode: (event: E, nodeId: string | undefined) =>
      runtimes.forNode(contextFor(event, nodeId), nodeId),
    destroy: (event: E, tabId: string) => runtimes.destroy(contexts.window(event), tabId),
  };
}
