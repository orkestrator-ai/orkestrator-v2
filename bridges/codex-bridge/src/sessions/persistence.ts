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
 * Writes are atomic (temp file + rename) and lock-guarded because two
 * Orkestrator instances can share one `CODEX_HOME`.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

export class BridgeSessionStore {
  private readonly codexHome: string;
  private readonly cwdHash: string;
  private readonly retentionMs: number;
  private readonly now: () => number;
  /** Serializes our own writes; the rename keeps cross-process writes atomic. */
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

  /** Returns only entries for this cwd that are still within retention. */
  async load(): Promise<PersistedBridgeSession[]> {
    let raw: string;
    try {
      raw = await readFile(this.path(), "utf8");
    } catch {
      return [];
    }

    let parsed: RegistryFile;
    try {
      parsed = JSON.parse(raw) as RegistryFile;
    } catch {
      // A torn or hand-edited file is not worth surfacing; the rollout is
      // authoritative and the mapping rebuilds as sessions are used.
      return [];
    }
    if (parsed.version !== BRIDGE_SESSION_REGISTRY_VERSION) return [];
    if (!Array.isArray(parsed.sessions)) return [];

    const cutoff = this.now() - this.retentionMs;
    return parsed.sessions.filter((session) => {
      if (typeof session?.bridgeSessionId !== "string" || typeof session?.threadId !== "string") {
        return false;
      }
      if (session.cwdHash !== this.cwdHash) return false;
      const lastAccessed = Date.parse(session.lastAccessed ?? "");
      return Number.isFinite(lastAccessed) ? lastAccessed >= cutoff : false;
    });
  }

  async save(sessions: PersistedBridgeSession[]): Promise<void> {
    const attempt = this.writeChain.then(() => this.writeAtomic(sessions));
    this.writeChain = attempt.catch(() => undefined);
    return attempt;
  }

  private async writeAtomic(sessions: PersistedBridgeSession[]): Promise<void> {
    const payload: RegistryFile = {
      version: BRIDGE_SESSION_REGISTRY_VERSION,
      sessions: sessions.filter((session) => session.cwdHash === this.cwdHash),
    };

    try {
      await mkdir(this.dir(), { recursive: true });
      // Unique temp name so two instances cannot collide on the scratch file.
      const temporary = `${this.path()}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      // rename is atomic within a filesystem: readers see old or new, never torn.
      await rename(temporary, this.path()).catch(async (error: unknown) => {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      });
    } catch (error) {
      // Never fatal: losing the mapping degrades resume, it does not lose work.
      console.warn(
        "[codex-bridge] Failed to persist bridge session registry:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Upserts one entry, preserving everything else in the file. */
  async upsert(session: PersistedBridgeSession): Promise<void> {
    const existing = await this.load();
    const merged = existing.filter(
      (entry) => entry.bridgeSessionId !== session.bridgeSessionId,
    );
    merged.push(session);
    await this.save(merged);
  }

  async remove(bridgeSessionId: string): Promise<void> {
    const existing = await this.load();
    await this.save(existing.filter((entry) => entry.bridgeSessionId !== bridgeSessionId));
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
