/**
 * Bounded local snapshots of each node's light stores (plan item 4003,
 * report §8.3): what the window last saw of a node's projects, environments,
 * config, pane layout ids and selection, so a cold open of that node paints
 * at once and is then replaced by the authoritative read.
 *
 * Three parts:
 *
 * - **The record schema** (`NodeSnapshotSchema`, Effect Schema). Its fields are
 *   the content rule: only list metadata the sidebar summaries already expose.
 *   Every write and every read is decoded with `onExcessProperty: "error"`, so
 *   a record carrying any other field (an environment's `initialPrompt`, a
 *   tab's prompt, terminal or file contents, a token) is refused, not
 *   stripped. URLs with credentials in them are refused too. Strings and
 *   lists have explicit bounds (invariant 11).
 * - **The backend** (`SnapshotBackend`): where entries live. In the app it is
 *   IndexedDB (`indexedDbSnapshotBackend`, hand-written, no dependency); tests
 *   pass `memorySnapshotBackend()`. A window without IndexedDB (happy-dom, a
 *   locked-down browser) has no snapshot store at all.
 * - **The store** (`NodeSnapshotStore`): byte bounds per node and in total, a
 *   count bound, and least-recently-used eviction. Operations are serialized,
 *   so a write never interleaves with an eviction or a clear. The bounds are
 *   enforced at write time against the backend's own index, which other
 *   windows of the same origin share; a race between two windows can exceed
 *   the total briefly, and the next write evicts it back.
 *
 * Keys are node ids (an installation identity), so snapshots are node
 * namespaced, and a database is per origin (browser) or per profile (desktop).
 * Nothing here is ever logged except counts, sizes and error kinds.
 */

import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import {
  EnvironmentStatusSchema,
  EnvironmentTypeSchema,
  NetworkAccessModeSchema,
  PrStateSchema,
} from "@orkestrator/protocol/contract/domains/environments";

// --- The record schema: allowed fields only ---------------------------------

/** The snapshot record's format; a stored record of another version is dropped. */
export const NODE_SNAPSHOT_VERSION = 1;

/** Bounds of one record's lists and strings. */
export const SNAPSHOT_LIMITS = Object.freeze({
  projects: 500,
  environments: 2_000,
  paneLayouts: 500,
  tabIdsPerLayout: 64,
  repositories: 500,
  /** Ids, names, branches, paths and URLs. */
  text: 1_024,
});

/** `scheme://user:secret@host` or `scheme://token@host`. */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/iu;

const Text = Schema.String.check(Schema.isMaxLength(SNAPSHOT_LIMITS.text));
const OptionalText = Schema.optionalKey(Schema.NullOr(Text));
/** A URL or remote that never carries credentials. */
const RemoteText = Text.check(
  Schema.makeFilter((value: string) => !URL_WITH_CREDENTIALS.test(value) || "credentials in a URL"),
);

const boundedArray = <S extends Schema.Top>(item: S, max: number) =>
  Schema.Array(item).check(Schema.isMaxLength(max));

/** A project row as the sidebar shows it. */
export const SnapshotProjectSchema = Schema.Struct({
  id: Text,
  name: Text,
  gitUrl: RemoteText,
  localPath: Schema.NullOr(Text),
  addedAt: Text,
  order: Schema.Finite,
  folder: OptionalText,
  icon: OptionalText,
});

/**
 * An environment row as the sidebar shows it: never its prompt, attachments,
 * agent settings, setup session, ports or worktree paths.
 */
export const SnapshotEnvironmentSchema = Schema.Struct({
  id: Text,
  projectId: Text,
  name: Text,
  branch: Text,
  containerId: Schema.NullOr(Text),
  status: EnvironmentStatusSchema,
  prUrl: Schema.NullOr(RemoteText),
  prState: Schema.NullOr(PrStateSchema),
  hasMergeConflicts: Schema.NullOr(Schema.Boolean),
  createdAt: Text,
  networkAccessMode: NetworkAccessModeSchema,
  order: Schema.Finite,
  environmentType: EnvironmentTypeSchema,
  projectHome: Schema.optionalKey(Schema.Boolean),
  lastActivityAt: Schema.optionalKey(Text),
  hasUnreadWork: Schema.optionalKey(Schema.Boolean),
});

/** Ids only: which panes and tabs an environment's layout had, never their titles or data. */
export const SnapshotPaneLayoutSchema = Schema.Struct({
  environmentId: Text,
  activePaneId: Text,
  activeTabId: Schema.NullOr(Text),
  tabIds: boundedArray(Text, SNAPSHOT_LIMITS.tabIdsPerLayout),
});

/** Presentation settings only: no credentials, instructions, prompts or connection records. */
export const SnapshotConfigSchema = Schema.Struct({
  enabledAgentPlatforms: Schema.optionalKey(boundedArray(Text, 32)),
  preferredEditor: Schema.optionalKey(Text),
  terminalAppearance: Schema.optionalKey(
    Schema.Struct({ fontFamily: Text, fontSize: Schema.Finite, backgroundColor: Text }),
  ),
  repositories: boundedArray(
    Schema.Struct({ projectId: Text, defaultBranch: Text, prBaseBranch: Text }),
    SNAPSHOT_LIMITS.repositories,
  ),
});

export const SnapshotSelectionSchema = Schema.Struct({
  projectId: Schema.NullOr(Text),
  environmentId: Schema.NullOr(Text),
});

export const NodeSnapshotSchema = Schema.Struct({
  version: Schema.Literal(NODE_SNAPSHOT_VERSION),
  nodeId: Text,
  /** Epoch milliseconds of the capture. */
  savedAt: Schema.Finite,
  projects: boundedArray(SnapshotProjectSchema, SNAPSHOT_LIMITS.projects),
  environments: boundedArray(SnapshotEnvironmentSchema, SNAPSHOT_LIMITS.environments),
  config: Schema.NullOr(SnapshotConfigSchema),
  paneLayouts: boundedArray(SnapshotPaneLayoutSchema, SNAPSHOT_LIMITS.paneLayouts),
  selection: SnapshotSelectionSchema,
});

export type NodeSnapshot = typeof NodeSnapshotSchema.Type;
export type SnapshotProject = typeof SnapshotProjectSchema.Type;
export type SnapshotEnvironment = typeof SnapshotEnvironmentSchema.Type;
export type SnapshotPaneLayout = typeof SnapshotPaneLayoutSchema.Type;
export type SnapshotConfig = typeof SnapshotConfigSchema.Type;

const decodeStrict = Schema.decodeUnknownSync(NodeSnapshotSchema, {
  onExcessProperty: "error",
});

/** A record broke the content rules: a field outside the allow-list, an unbounded value, credentials. */
export class SnapshotContentError extends Data.TaggedError("SnapshotContentError")<{
  readonly message: string;
}> {}

/** A record is larger than one node's byte bound. */
export class SnapshotTooLargeError extends Data.TaggedError("SnapshotTooLargeError")<{
  readonly bytes: number;
  readonly limit: number;
}> {}

/**
 * `value` as a snapshot, or `SnapshotContentError`. The error names the
 * offending path only: the schema issue's message would quote the value.
 */
export function checkNodeSnapshot(value: unknown): NodeSnapshot {
  try {
    return decodeStrict(value);
  } catch (error) {
    throw new SnapshotContentError({ message: `Refused snapshot: ${issuePaths(error)}` });
  }
}

/** The paths a schema error names, without the values. */
function issuePaths(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  const paths = Array.from(text.matchAll(/at ((?:\[[^\]\n]*\])+)/gu), (match) => match[1]);
  return paths.length > 0 ? `fields ${Array.from(new Set(paths)).slice(0, 8).join(", ")}` : "shape";
}

// --- The backend ---------------------------------------------------------------

/** One entry's index record: what eviction needs without reading the body. */
export interface SnapshotEntryMeta {
  readonly nodeId: string;
  readonly bytes: number;
  readonly savedAt: number;
  /** Last read or write, for least-recently-used eviction. */
  readonly usedAt: number;
}

/** Where snapshot entries live. Every method may reject; the store handles it. */
export interface SnapshotBackend {
  listMeta(): Promise<SnapshotEntryMeta[]>;
  read(nodeId: string): Promise<string | null>;
  /** Writes the body and its index record together. */
  write(meta: SnapshotEntryMeta, body: string): Promise<void>;
  /** Updates only the index record (a read moved `usedAt`). */
  touch(meta: SnapshotEntryMeta): Promise<void>;
  remove(nodeIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

/** An in-memory backend: the test fake, and a reference for the IndexedDB one. */
export interface MemorySnapshotBackend extends SnapshotBackend {
  /** The stored bodies by node id (tests read them to check content rules end to end). */
  readonly bodies: ReadonlyMap<string, string>;
  /** Makes the next calls of `operation` reject, for failure tests. */
  failNext(operation: "read" | "write" | "listMeta", count?: number): void;
}

export function memorySnapshotBackend(): MemorySnapshotBackend {
  const metas = new Map<string, SnapshotEntryMeta>();
  const bodies = new Map<string, string>();
  const failures = new Map<string, number>();
  const maybeFail = (operation: string) => {
    const left = failures.get(operation) ?? 0;
    if (left <= 0) return;
    failures.set(operation, left - 1);
    throw new Error(`memory snapshot backend: ${operation} failed`);
  };
  return {
    bodies,
    failNext(operation, count = 1) {
      failures.set(operation, count);
    },
    async listMeta() {
      maybeFail("listMeta");
      return Array.from(metas.values());
    },
    async read(nodeId) {
      maybeFail("read");
      return bodies.get(nodeId) ?? null;
    },
    async write(meta, body) {
      maybeFail("write");
      metas.set(meta.nodeId, meta);
      bodies.set(meta.nodeId, body);
    },
    async touch(meta) {
      if (metas.has(meta.nodeId)) metas.set(meta.nodeId, meta);
    },
    async remove(nodeIds) {
      for (const nodeId of nodeIds) {
        metas.delete(nodeId);
        bodies.delete(nodeId);
      }
    },
    async clear() {
      metas.clear();
      bodies.clear();
    },
    close() {},
  };
}

const DB_VERSION = 1;
const META_STORE = "meta";
const BODY_STORE = "bodies";

/** The default database name; one per origin (browser) or desktop profile. */
export const NODE_SNAPSHOT_DATABASE = "orkestrator-node-snapshots";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB failed"));
  });
}

/**
 * The IndexedDB backend: one database with an index store (`meta`, small
 * records) and a body store (`bodies`, the JSON), both keyed by node id, so
 * eviction lists the index without reading any body. `null` when the window
 * has no IndexedDB.
 */
export function indexedDbSnapshotBackend(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
  name = NODE_SNAPSHOT_DATABASE,
): SnapshotBackend | null {
  if (!factory) return null;
  let opening: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "nodeId" });
        }
        if (!db.objectStoreNames.contains(BODY_STORE)) db.createObjectStore(BODY_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another window upgrading the schema: let it, and reopen next time.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked"));
    }).catch((error: unknown) => {
      opening = null;
      throw error;
    });
    return opening;
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    work: (meta: IDBObjectStore, bodies: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> => {
    const db = await database();
    const transaction = db.transaction([META_STORE, BODY_STORE], mode);
    const done = transactionDone(transaction);
    const result = await work(
      transaction.objectStore(META_STORE),
      transaction.objectStore(BODY_STORE),
    );
    await done;
    return result;
  };
  return {
    listMeta: () =>
      run("readonly", (meta) => requestResult(meta.getAll() as IDBRequest<SnapshotEntryMeta[]>)),
    read: (nodeId) =>
      run("readonly", async (_meta, bodies) => {
        const body: unknown = await requestResult(bodies.get(nodeId));
        return typeof body === "string" ? body : null;
      }),
    write: (entry, body) =>
      run("readwrite", (meta, bodies) => {
        meta.put({ ...entry });
        bodies.put(body, entry.nodeId);
      }),
    touch: (entry) =>
      run("readwrite", async (meta) => {
        // Only an entry that still exists; a clear may have run since the read.
        const existing: unknown = await requestResult(meta.get(entry.nodeId));
        if (existing) meta.put({ ...entry });
      }),
    remove: (nodeIds) =>
      run("readwrite", (meta, bodies) => {
        for (const nodeId of nodeIds) {
          meta.delete(nodeId);
          bodies.delete(nodeId);
        }
      }),
    clear: () =>
      run("readwrite", (meta, bodies) => {
        meta.clear();
        bodies.clear();
      }),
    close() {
      void opening?.then((db) => db.close()).catch(() => undefined);
      opening = null;
    },
  };
}

// --- The bounded store ---------------------------------------------------------

export interface SnapshotBounds {
  /** The largest one node's record may be, in UTF-8 bytes. */
  readonly perNodeBytes: number;
  /** All nodes' records together. */
  readonly totalBytes: number;
  /** How many nodes keep a snapshot. */
  readonly maxNodes: number;
}

/**
 * Placeholders, like the window byte budgets (report §8.2): a node with a few
 * hundred environments is well under 256 KiB, and 2 MiB keeps the snapshots
 * of a large fleet without being noticeable in an origin's quota.
 */
export const DEFAULT_SNAPSHOT_BOUNDS: SnapshotBounds = Object.freeze({
  perNodeBytes: 256 * 1024,
  totalBytes: 2 * 1024 * 1024,
  maxNodes: 32,
});

export interface NodeSnapshotStoreOptions {
  readonly bounds?: Partial<SnapshotBounds>;
  readonly now?: () => number;
}

export interface NodeSnapshotStore {
  readonly bounds: SnapshotBounds;
  /** The node's snapshot, or `null` (none, unreadable, or breaking the rules: then it is dropped). */
  read(nodeId: string): Promise<NodeSnapshot | null>;
  /**
   * Checks `snapshot` against the content rules and the per-node bound (both
   * throw, and nothing is written), stores it, then evicts the least recently
   * used other nodes until the total and count bounds hold. Returns the
   * evicted node ids.
   */
  write(snapshot: NodeSnapshot): Promise<{ readonly bytes: number; readonly evicted: string[] }>;
  /** Drops one node's snapshot (the node left the registry). */
  clear(nodeId: string): Promise<void>;
  /** Drops every snapshot (sign-out, credentials changed). */
  clearAll(): Promise<void>;
  /** The index, for tests and diagnostics. */
  entries(): Promise<SnapshotEntryMeta[]>;
  close(): void;
}

const encoder = new TextEncoder();

export function createNodeSnapshotStore(
  backend: SnapshotBackend,
  options: NodeSnapshotStoreOptions = {},
): NodeSnapshotStore {
  const bounds: SnapshotBounds = { ...DEFAULT_SNAPSHOT_BOUNDS, ...options.bounds };
  const now = options.now ?? Date.now;
  let chain: Promise<unknown> = Promise.resolve();
  // A monotonic clock for `usedAt`, so two operations in one millisecond still order.
  let lastStamp = 0;
  const stamp = () => {
    lastStamp = Math.max(now(), lastStamp + 1);
    return lastStamp;
  };
  /** Runs `work` after every earlier operation settled. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    bounds,
    read: (nodeId) =>
      serial(async () => {
        const body = await backend.read(nodeId);
        if (body === null) return null;
        let snapshot: NodeSnapshot;
        try {
          snapshot = checkNodeSnapshot(JSON.parse(body));
          if (snapshot.nodeId !== nodeId) throw new Error("another node's snapshot");
        } catch {
          // Unreadable, another version, or breaking today's rules: never shown.
          await backend.remove([nodeId]);
          return null;
        }
        const meta = (await backend.listMeta()).find((entry) => entry.nodeId === nodeId);
        if (meta) await backend.touch({ ...meta, usedAt: stamp() });
        return snapshot;
      }),
    write: (snapshot) =>
      serial(async () => {
        const checked = checkNodeSnapshot(snapshot);
        const body = JSON.stringify(checked);
        const bytes = encoder.encode(body).byteLength;
        if (bytes > bounds.perNodeBytes) {
          throw new SnapshotTooLargeError({ bytes, limit: bounds.perNodeBytes });
        }
        const meta: SnapshotEntryMeta = {
          nodeId: checked.nodeId,
          bytes,
          savedAt: checked.savedAt,
          usedAt: stamp(),
        };
        await backend.write(meta, body);
        const others = (await backend.listMeta())
          .filter((entry) => entry.nodeId !== meta.nodeId)
          .sort((a, b) => a.usedAt - b.usedAt);
        let total = bytes + others.reduce((sum, entry) => sum + entry.bytes, 0);
        let count = others.length + 1;
        const evicted: string[] = [];
        for (const entry of others) {
          if (total <= bounds.totalBytes && count <= bounds.maxNodes) break;
          evicted.push(entry.nodeId);
          total -= entry.bytes;
          count -= 1;
        }
        if (evicted.length > 0) await backend.remove(evicted);
        return { bytes, evicted };
      }),
    clear: (nodeId) => serial(() => backend.remove([nodeId])),
    clearAll: () => serial(() => backend.clear()),
    entries: () => serial(() => backend.listMeta()),
    close: () => backend.close(),
  };
}
