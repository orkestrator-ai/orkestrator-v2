/**
 * Content-free usage counters for mixed-version compatibility paths, so a path
 * is retired on evidence rather than a guess
 * (`docs/architecture/version-compatibility.md`).
 *
 * Each path is a fixed id from {@link COMPATIBILITY_PATH_IDS}, or a domain
 * client adapter's id (`domain-adapter.<source>.<domain>.v<version>`); nothing else is
 * recorded: no session, agent, URL, port or version of the other side. Hot
 * paths call {@link CompatibilityPathUsage.record}, which only bumps memory.
 * Once a sink is attached (the backend attaches its database at startup), the
 * pending counts are merged into the `compatibility-path-usage` store at most
 * once a minute, on every durable read, and at shutdown, so the totals and the first
 * and last time each path was taken survive restarts and upgrades. The
 * database sink lives in `compatibility-path-usage-store.ts`, so the paths that
 * record here never import storage.
 */
import {
  isDomainAdapterPathId,
  type DomainAdapterPathId,
} from "@orkestrator/protocol/contract/client-usage";

/**
 * Every counted path. Add an id when a change adds a path for an older peer
 * and remove it with the path. The register in the architecture doc names
 * each path's owner and removal condition.
 */
export const COMPATIBILITY_PATH_IDS = [
  /** A leaf cannot attest a coordinator build admission before launch. */
  "coordinator-build.origin-upgrade-required",
  /** A container bridge's token was read from its `node`-readable `/tmp` file. */
  "bridge-credential.token-file",
  /** A session-route 404 was rejected as an outdated bridge, without reading a legacy route. */
  "slash-catalogue.outdated-bridge",
  /** A bridge without `POST /session/:id/close` got the restart notice. */
  "bridge-close.upgrade-required",
  /** A renderer that predates paged tmux transcripts read a whole transcript. */
  "tmux-transcript.whole-read",
  /** A bridge without `/transcript` was read through its whole `/messages` body. */
  "bridge-transcript.messages-fallback",
  /**
   * A history page was served from the joined sync-v1 projection while the
   * session's latest view carried a direct cursor, or no view was read: a
   * caller paging with a v1 cursor it did not need (0232 item 3).
   */
  "history.joined-v1-page",
  /** A joined page for a view whose source has no direct pages (no provider cursor). */
  "history.joined-v1-page.unpaged-source",
  /** A joined page for a view whose source pages directly but could name or wrap no cursor. */
  "history.joined-v1-page.unnamed-cursor",
  /** A request used the legacy `/__orkestrator/browser/loopback/<port>/` preview route. */
  "preview.legacy-loopback-route",
  /** A desktop opened a v1 preview tunnel socket: it predates tunnel v2. */
  "preview.tunnel-v1",
  /**
   * Verify read an Address session's last assistant text because the session
   * has no typed `fix-result` marker: it started before the typed handoff.
   */
  "build-pipeline.address-text-report",
  /** `list_nodes` asked a node for its load and the node does not have the command yet. */
  "machine-load.older-node",
  /** An older renderer built a "Continue in…" handoff itself (`save_agent_handoff`). */
  "agent-handoff.renderer-saved",
  /** A prompt reached dispatch already holding its handoff: an older renderer prepended it. */
  "agent-handoff.renderer-carried",
  /**
   * A command node's coordinator asked to mail, or asked about, a leaf's
   * coordinator and the leaf does not advertise `node-coordinator-mail`.
   */
  "node-coordinator-mail.older-node",
  /**
   * A command node collected a leaf's outbox without `coordinatorMail` (it
   * predates `node-coordinator-mail`) while the leaf's coordinator had mail
   * queued for it: the mail stays held on the leaf until that node is updated.
   */
  "node-coordinator-mail.older-command-node",
  /**
   * A leaf kept a coordinator notice on its own coordinator because the command
   * node attached to it has not said it takes `coordinator-notices`.
   */
  "coordinator-notices.older-command-node",
  /**
   * A command node mailed its coordinators about a leaf's automatic switch from
   * the leaf's event, because the leaf does not advertise `coordinator-notices`.
   */
  "coordinator-notices.older-leaf",
  /**
   * A renderer that predates per-conversation startup errors opened the panel,
   * which is how it recovers: `ensure_project_coordinator` cleared them.
   */
  "coordinator-ensure.conversation-errors-cleared",
  /**
   * A coordinator's mail with images was refused: the node does not advertise
   * `node-mail-attachments`.
   */
  "node-mail-attachments.older-node",
  /**
   * A command node has no coordinator for an agent's mail and the leaf does not
   * advertise `node-mail-return`, so the mail stays in its outbox.
   */
  "node-mail-return.older-leaf",
  /**
   * A command node's coordinator used ticket tools or a build with a `nodeId`
   * on a leaf that does not advertise `ticket-sync`.
   */
  "ticket-sync.older-node",
  /** A terminal WebSocket client offered no input-results subprotocol: a frame per input. */
  "terminal-websocket.per-input-results",
  /**
   * `/compact` sent instructions and the bridge compacted without confirming
   * them: it predates compaction instructions and ignored the body.
   */
  "compact.instructions-ignored",
  /**
   * A Claude or Codex turn outcome was recorded as a usage limit from its error
   * text alone: the bridge sent no `errorCode` (it predates the code, or the
   * provider refused without its structured signal).
   */
  "usage-limit.text-classified",
  /**
   * A workspace client (a client grant or the relay) sent a global-settings
   * write that changed nothing and was answered with the current settings: a
   * realm from before `patch_global_config` saving a model favourite.
   */
  "workspace-grant.config-echo",
  /**
   * A retired coordinator command was called (plan item 7009):
   * `hide_coordinator_work` (the Work panel's "Clear finished", removed in
   * v2.36.5-beta), `associate_coordinator_workflow` (never called; launches
   * record their own associations) or `start_coordinator_multi_review` (its
   * last caller, Control MCP's `launch_multi_review`, moved off it in
   * v2.36.4-beta).
   */
  "retired-command.hide-coordinator-work",
  "retired-command.associate-coordinator-workflow",
  "retired-command.start-coordinator-multi-review",
  /**
   * The retired `start_coordinator_node_multi_review` was called (plan item
   * 7009): its only caller, Control MCP's `launch_multi_review` on the same
   * command node, moved to `launch_coordinator_node_multi_review` in
   * v2.36.4-beta.
   */
  "retired-command.start-coordinator-node-multi-review",
  /**
   * A stream that did not say how it wants relayed node events got one under the
   * old shared name: a renderer or desktop from before per-node names.
   */
  "relayed-node-event.legacy-stream",
  /**
   * A stream that asked for the old shared name got a relayed event under it: a
   * desktop's main process from before it took per-node relayed events.
   */
  "relayed-node-event.legacy-desktop-stream",
  /**
   * A retired per-provider CLI check (`check_opencode_cli`, `check_codex_cli`,
   * `check_cursor_cli`, `check_grok_cli`, `check_pi_cli`) was called: no
   * renderer in the support window asks them (plan item 7009).
   */
  "retired-command.provider-cli-check",
  /** The retired no-op `cleanup_stale_local_servers_cmd` was called (plan item 7009). */
  "retired-command.cleanup-stale-local-servers",
] as const;

/**
 * A fixed path id, or a domain client adapter's id
 * (`domain-adapter.<backend|renderer>.<domain>.v<version>`, plan item 1009):
 * one per adapter below its domain's current version, bounded by the domain
 * names and the adapter list rather than listed here.
 */
export type CompatibilityPathId = (typeof COMPATIBILITY_PATH_IDS)[number] | DomainAdapterPathId;

/** One path's persisted usage. */
export interface CompatibilityPathUsageEntry {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** The persisted document, also what the command and `/__orkestrator/metrics` return. */
export interface CompatibilityPathUsageSnapshot {
  version: 1;
  paths: Partial<Record<CompatibilityPathId, CompatibilityPathUsageEntry>>;
}

/** Where pending counts are merged; the backend's is the database store. */
export interface CompatibilityPathUsageSink {
  /** Adds `pending` to the stored totals and returns the merged document. */
  merge(pending: ReadonlyMap<CompatibilityPathId, PendingUsage>): CompatibilityPathUsageSnapshot;
  close?(): void;
}

export interface PendingUsage {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export const COMPATIBILITY_PATH_USAGE_STORE = "compatibility-path-usage";
const FLUSH_INTERVAL_MS = 60_000;
const KNOWN_IDS = new Set<string>(COMPATIBILITY_PATH_IDS);

/** Whether `id` is a fixed path id or a well-formed domain adapter id. */
export function isCompatibilityPathId(id: string): id is CompatibilityPathId {
  return KNOWN_IDS.has(id) || isDomainAdapterPathId(id);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Reads valid entries; persistence retains newer ids while public snapshots filter them. */
export function normalizeCompatibilityPathUsage(
  value: unknown,
  includeUnknown = false,
): CompatibilityPathUsageSnapshot {
  const paths: CompatibilityPathUsageSnapshot["paths"] = {};
  const stored =
    value && typeof value === "object" ? (value as { paths?: unknown }).paths : undefined;
  if (stored && typeof stored === "object") {
    for (const [id, entry] of Object.entries(stored)) {
      if ((!includeUnknown && !isCompatibilityPathId(id)) || !entry || typeof entry !== "object") {
        continue;
      }
      const { count, firstSeenAt, lastSeenAt } = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(count) || (count as number) < 0) continue;
      if (!isIso(firstSeenAt) || !isIso(lastSeenAt)) continue;
      Object.defineProperty(paths, id, {
        value: { count: count as number, firstSeenAt, lastSeenAt },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return { version: 1, paths };
}

/** Adds pending counts to a document in place. */
export function mergeCompatibilityPathUsage(
  document: CompatibilityPathUsageSnapshot,
  pending: ReadonlyMap<CompatibilityPathId, PendingUsage>,
): CompatibilityPathUsageSnapshot {
  for (const [id, usage] of pending) {
    const stored = document.paths[id];
    document.paths[id] = stored
      ? {
          count: Math.min(Number.MAX_SAFE_INTEGER, stored.count + usage.count),
          firstSeenAt:
            stored.firstSeenAt < usage.firstSeenAt ? stored.firstSeenAt : usage.firstSeenAt,
          lastSeenAt: stored.lastSeenAt > usage.lastSeenAt ? stored.lastSeenAt : usage.lastSeenAt,
        }
      : { ...usage };
  }
  return document;
}

export class CompatibilityPathUsage {
  private pending = new Map<CompatibilityPathId, PendingUsage>();
  private sink: CompatibilityPathUsageSink | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private persisted: CompatibilityPathUsageSnapshot = { version: 1, paths: {} };
  /** Whether {@link persisted} has been read from the attached sink. */
  private loaded = false;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly flushIntervalMs = FLUSH_INTERVAL_MS,
  ) {}

  /**
   * Counts `count` uses of a path (one by default; a renderer's upload carries
   * several). Never throws and never does I/O.
   */
  record(id: CompatibilityPathId, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1) return;
    const at = this.now().toISOString();
    const usage = this.pending.get(id);
    if (usage) {
      usage.count = Math.min(Number.MAX_SAFE_INTEGER, usage.count + count);
      usage.lastSeenAt = at;
    } else {
      this.pending.set(id, { count, firstSeenAt: at, lastSeenAt: at });
    }
    this.scheduleFlush();
  }

  /**
   * Persists through `sink` from now on; counts recorded before are kept. A
   * previously attached sink (another backend in the same process, as in
   * tests) is flushed and closed first.
   */
  attach(sink: CompatibilityPathUsageSink): void {
    if (this.sink && this.sink !== sink) this.detach(this.sink);
    this.sink = sink;
    this.scheduleFlush();
  }

  /** Flushes into `sink`, then stops persisting and closes it, if it is still attached. */
  detach(sink: CompatibilityPathUsageSink): void {
    if (this.sink !== sink) return;
    this.flush();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sink = null;
    this.loaded = false;
    this.persisted = { version: 1, paths: {} };
    sink.close?.();
  }

  /**
   * Merges pending counts into the sink and returns the totals. Without a
   * sink, the pending counts are returned. If a write fails, they are kept,
   * retried at the flush interval, and added to the last persisted snapshot.
   */
  flush(): CompatibilityPathUsageSnapshot {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    if (!this.sink) return mergeCompatibilityPathUsage({ version: 1, paths: {} }, pending);
    this.pending = new Map();
    try {
      const snapshot = this.sink.merge(pending);
      this.persisted = normalizeCompatibilityPathUsage(snapshot);
      this.loaded = true;
      this.scheduleFlush();
      return snapshot;
    } catch {
      // Keep the counts and retry even when no further traffic arrives.
      this.pending = pending;
      this.scheduleFlush();
      return mergeCompatibilityPathUsage(normalizeCompatibilityPathUsage(this.persisted), pending);
    }
  }

  /** Persisted totals plus anything not yet flushed. */
  snapshot(): CompatibilityPathUsageSnapshot {
    return this.flush();
  }

  /**
   * The last totals read or written plus what is pending, from memory: a poll
   * costs no I/O and persistence stays with the once-a-minute flush. The first
   * call reads the sink once, so a fresh process starts from the stored totals.
   * Another backend's counts arrive within the periodic flush interval;
   * for the durable truth call {@link snapshot}.
   */
  peek(): CompatibilityPathUsageSnapshot {
    if (this.sink && !this.loaded) return this.flush();
    return mergeCompatibilityPathUsage(
      normalizeCompatibilityPathUsage(this.persisted),
      this.pending,
    );
  }

  private scheduleFlush(): void {
    if (!this.sink || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }
}

/** The process-wide counters every compatibility path records into. */
export const compatibilityPathUsage = new CompatibilityPathUsage();
