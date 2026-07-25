/**
 * Durable bridge-session ↔ Codex-thread mapping.
 *
 * Pane state and build-pipeline state store *bridge session ids*, but those ids
 * only ever lived in process memory, so a bridge restart orphaned them: the UI
 * held an id the bridge no longer knew, and a build phase could not be resumed.
 *
 * Only the mapping and config are persisted — never the transcript. The Codex
 * rollout stays the single source of truth for conversation content, so this file
 * can be deleted at any time without losing user data.
 *
 * Each bridge session has its own atomic record because two Orkestrator
 * instances can share one `CODEX_HOME`; unrelated sessions never participate in
 * the same read-modify-write transaction.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { EngineTurnConfig } from "../engine/types.js";
import type { SessionTitleSource } from "./thread-registry.js";

export const BRIDGE_SESSION_REGISTRY_VERSION = 2;

export interface PersistedBridgeSession {
  bridgeSessionId: string;
  threadId: string;
  /** Hashed, not raw: the registry is shared and paths can be sensitive. */
  cwdHash: string;
  title?: string;
  titleSource?: SessionTitleSource;
  config: EngineTurnConfig;
  /** Last prompt request id accepted, for duplicate suppression after restart. */
  lastAcceptedRequestId?: string;
  lastAccessed: string;
}

interface RegistryFile {
  version: number;
  sessions: PersistedBridgeSession[];
}

interface PersistedSessionTombstone {
  bridgeSessionId: string;
  deleted: true;
  deletedAt: string;
}

const SESSION_TITLE_SOURCES = new Set<SessionTitleSource>([
  "codex",
  "explicit",
  "generated",
  "prompt",
]);

function isEngineTurnConfig(value: unknown): value is EngineTurnConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  if (config.mode !== "build" && config.mode !== "plan") return false;
  if (config.model !== undefined && typeof config.model !== "string")
    return false;
  if (
    config.reasoningEffort !== undefined &&
    typeof config.reasoningEffort !== "string"
  ) {
    return false;
  }
  if (
    config.serviceTier !== undefined &&
    config.serviceTier !== null &&
    typeof config.serviceTier !== "string"
  ) {
    return false;
  }
  if (config.cwd !== undefined && typeof config.cwd !== "string") return false;
  if (
    config.sandbox !== undefined &&
    config.sandbox !== "read-only" &&
    config.sandbox !== "workspace-write" &&
    config.sandbox !== "danger-full-access"
  ) {
    return false;
  }
  if (
    config.approvalPolicy !== undefined &&
    config.approvalPolicy !== "never" &&
    config.approvalPolicy !== "on-request" &&
    config.approvalPolicy !== "untrusted"
  ) {
    return false;
  }
  return (
    config.networkAccessEnabled === undefined ||
    typeof config.networkAccessEnabled === "boolean"
  );
}

function isPersistedBridgeSession(
  value: unknown,
  cwdHash: string,
  cutoff: number,
): value is PersistedBridgeSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  if (
    typeof session.bridgeSessionId !== "string" ||
    session.bridgeSessionId.length === 0 ||
    typeof session.threadId !== "string" ||
    session.threadId.length === 0 ||
    session.cwdHash !== cwdHash ||
    !isEngineTurnConfig(session.config)
  ) {
    return false;
  }
  if (session.title !== undefined && typeof session.title !== "string")
    return false;
  if (
    session.titleSource !== undefined &&
    (typeof session.titleSource !== "string" ||
      !SESSION_TITLE_SOURCES.has(session.titleSource as SessionTitleSource))
  ) {
    return false;
  }
  if (
    session.lastAcceptedRequestId !== undefined &&
    typeof session.lastAcceptedRequestId !== "string"
  ) {
    return false;
  }
  const lastAccessed =
    typeof session.lastAccessed === "string"
      ? Date.parse(session.lastAccessed)
      : Number.NaN;
  return Number.isFinite(lastAccessed) && lastAccessed >= cutoff;
}

function isPersistedSessionTombstone(
  value: unknown,
): value is PersistedSessionTombstone {
  if (!value || typeof value !== "object") return false;
  const tombstone = value as Record<string, unknown>;
  return (
    tombstone.deleted === true &&
    typeof tombstone.bridgeSessionId === "string" &&
    tombstone.bridgeSessionId.length > 0 &&
    typeof tombstone.deletedAt === "string" &&
    Number.isFinite(Date.parse(tombstone.deletedAt))
  );
}

export function hashCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export interface BridgeSessionStoreOptions {
  codexHome: string;
  cwd: string;
  /** Entries older than this are dropped on load. */
  retentionMs?: number;
  now?: () => number;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an orphaned `*.tmp` is left alone before it is collected. It only has
 * to outlast the write→rename window of any live writer — including one in
 * another process — so an hour is several orders of magnitude of headroom.
 */
const TEMP_FILE_GRACE_MS = 60 * 60 * 1000;

export class BridgeSessionStore {
  private readonly codexHome: string;
  private readonly cwdHash: string;
  private readonly retentionMs: number;
  private readonly now: () => number;
  /** Serializes operations for one store instance; records are independent across processes. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: BridgeSessionStoreOptions) {
    this.codexHome = options.codexHome;
    this.cwdHash = hashCwd(options.cwd);
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = options.now ?? Date.now;
  }

  private dir(): string {
    return join(this.codexHome, "orkestrator-bridge");
  }

  private path(): string {
    return join(this.dir(), `bridge-sessions-${this.cwdHash}.json`);
  }

  private recordsDir(): string {
    return join(this.dir(), `bridge-sessions-${this.cwdHash}`);
  }

  private recordKey(bridgeSessionId: string): string {
    return createHash("sha256").update(bridgeSessionId).digest("hex");
  }

  private recordPath(bridgeSessionId: string): string {
    return join(this.recordsDir(), `${this.recordKey(bridgeSessionId)}.json`);
  }

  /**
   * Returns only entries for this cwd that are still within retention.
   *
   * Load is also the sweep: nothing else ever visits this directory, so expired
   * tombstones and abandoned temp files are collected here. Every deletion is
   * best effort — a shared or read-only `CODEX_HOME` must degrade to "cache we
   * could not tidy", never to a rejected load.
   */
  async load(): Promise<PersistedBridgeSession[]> {
    const cutoff = this.now() - this.retentionMs;
    const legacy = await this.loadLegacy(cutoff);
    // A failed migration is a cache miss, not a fatal error: this store holds no
    // user data, and letting it throw here leaves the engine unstarted for the
    // whole process lifetime because nothing retries load().
    await this.migrateLegacy(legacy).catch((error) =>
      this.warnPersistenceFailure(error),
    );

    let names: string[];
    try {
      names = await readdir(this.recordsDir());
    } catch {
      return legacy;
    }

    const records = await Promise.all(
      names.map(async (name) => {
        const path = join(this.recordsDir(), name);
        if (name.endsWith(".tmp")) {
          await this.collectStaleTemporary(path);
          return null;
        }
        if (!name.endsWith(".json")) return null;
        try {
          const value = JSON.parse(await readFile(path, "utf8")) as unknown;
          if (isPersistedSessionTombstone(value)) {
            // A tombstone only exists to stop legacy migration re-publishing a
            // record that was deleted. Past retention the legacy entry it shields
            // against is itself expired, so keeping it would mean every session
            // ever created leaves a permanent file behind.
            if (Date.parse(value.deletedAt) < cutoff) {
              await rm(path, { force: true }).catch(() => undefined);
            }
            return null;
          }
          return isPersistedBridgeSession(value, this.cwdHash, cutoff)
            ? value
            : null;
        } catch {
          return null;
        }
      }),
    );
    return records.filter(
      (record): record is PersistedBridgeSession => record !== null,
    );
  }

  /** Removes a `writeAtomicPath` temp file that no live writer can still rename. */
  private async collectStaleTemporary(path: string): Promise<void> {
    try {
      const info = await stat(path);
      if (this.now() - info.mtimeMs < TEMP_FILE_GRACE_MS) return;
      await rm(path, { force: true });
    } catch {
      // Already collected by another process, or not ours to delete.
    }
  }

  /** Upserts one independent record; different session ids never share a write target. */
  async upsert(session: PersistedBridgeSession): Promise<void> {
    const attempt = this.writeChain.then(() => this.writeRecordAtomic(session));
    this.writeChain = attempt.catch(() => undefined);
    await attempt.catch((error) => this.warnPersistenceFailure(error));
  }

  /**
   * Publishes a tombstone rather than unlinking, so a legacy migration that has
   * already read the aggregate file into memory cannot re-publish the record.
   * The tombstone is written unconditionally — "the aggregate file is gone" is
   * not proof no process is still holding its contents — and is collected by
   * `load()` once it passes retention.
   */
  async remove(bridgeSessionId: string): Promise<void> {
    const attempt = this.writeChain.then(async () => {
      await mkdir(this.recordsDir(), { recursive: true });
      const tombstone: PersistedSessionTombstone = {
        bridgeSessionId,
        deleted: true,
        deletedAt: new Date(this.now()).toISOString(),
      };
      await this.writeAtomicPath(
        this.recordPath(bridgeSessionId),
        `${JSON.stringify(tombstone)}\n`,
      );
    });
    this.writeChain = attempt.catch(() => undefined);
    await attempt.catch((error) => this.warnPersistenceFailure(error));
  }

  private async loadLegacy(cutoff: number): Promise<PersistedBridgeSession[]> {
    try {
      const parsed = JSON.parse(
        await readFile(this.path(), "utf8"),
      ) as RegistryFile;
      if (parsed.version !== BRIDGE_SESSION_REGISTRY_VERSION) return [];
      if (!Array.isArray(parsed.sessions)) return [];
      return parsed.sessions.filter((session) =>
        isPersistedBridgeSession(session, this.cwdHash, cutoff),
      );
    } catch {
      return [];
    }
  }

  /**
   * One-way compatibility with the former aggregate v2 file. `link` publishes
   * each migrated temp file only when that record does not already exist, so a
   * concurrent newer per-session write always wins.
   */
  private async migrateLegacy(
    sessions: PersistedBridgeSession[],
  ): Promise<void> {
    if (sessions.length === 0) return;
    await mkdir(this.recordsDir(), { recursive: true });
    await Promise.all(
      sessions.map(async (session) => {
        const target = this.recordPath(session.bridgeSessionId);
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify(session, null, 2)}\n`,
          "utf8",
        );
        await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        await rm(temporary, { force: true }).catch(() => undefined);
      }),
    );
    await rm(this.path(), { force: true }).catch(() => undefined);
  }

  private async writeRecordAtomic(
    session: PersistedBridgeSession,
  ): Promise<void> {
    await mkdir(this.recordsDir(), { recursive: true });
    await this.writeAtomicPath(
      this.recordPath(session.bridgeSessionId),
      `${JSON.stringify(session, null, 2)}\n`,
    );
  }

  private async writeAtomicPath(path: string, payload: string): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, "utf8");
    await rename(temporary, path).catch(async (error: unknown) => {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    });
  }

  private warnPersistenceFailure(error: unknown): void {
    console.warn(
      "[codex-bridge] Failed to persist bridge session registry:",
      error instanceof Error ? error.message : error,
    );
  }

  toRecord(options: {
    bridgeSessionId: string;
    threadId: string;
    cwd: string;
    config: EngineTurnConfig;
    title?: string;
    titleSource?: SessionTitleSource;
    lastAcceptedRequestId?: string;
  }): PersistedBridgeSession {
    return {
      bridgeSessionId: options.bridgeSessionId,
      threadId: options.threadId,
      cwdHash: hashCwd(options.cwd),
      config: options.config,
      title: options.title,
      titleSource: options.titleSource,
      lastAcceptedRequestId: options.lastAcceptedRequestId,
      lastAccessed: new Date(this.now()).toISOString(),
    };
  }
}
