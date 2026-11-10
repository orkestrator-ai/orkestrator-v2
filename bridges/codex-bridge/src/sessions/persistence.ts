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
  chmod,
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
import { codexBridgeStateDir, codexLoginBridgeDir } from "../bridge-state-dir.js";
import type { EngineTurnConfig } from "../engine/types.js";
import type { RestartFailureNotice, SessionTitleSource } from "./thread-registry.js";
import { isNativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  MAX_STRUCTURED_OUTPUT_TURNS,
  isStructuredOutputResult,
  type StructuredOutputResult,
  type StructuredOutputTurnRecord,
} from "@orkestrator/protocol/structured-output";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.codex");

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
  structuredOutputRequestId?: string;
  structuredOutput?: StructuredOutputResult;
  structuredOutputTurns?: StructuredOutputTurnRecord[];
  restartFailure?: RestartFailureNotice;
  /** Sparse turn -> model overlay for reroutes absent from Codex rollouts. */
  confirmedModelsByTurn?: Record<string, string>;
  /** Bounded content-free async-question attention index. */
  asyncQuestionItemIds?: string[];
  lastAccessed: string;
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
  if (config.policy !== undefined && !isNativeAgentExecutionPolicy(config.policy)) return false;
  if (config.model !== undefined && typeof config.model !== "string") return false;
  if (config.reasoningEffort !== undefined && typeof config.reasoningEffort !== "string") {
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
    config.networkAccessEnabled === undefined || typeof config.networkAccessEnabled === "boolean"
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
  if (session.title !== undefined && typeof session.title !== "string") return false;
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
  if (
    session.structuredOutputRequestId !== undefined &&
    typeof session.structuredOutputRequestId !== "string"
  ) {
    return false;
  }
  if (
    session.structuredOutput !== undefined &&
    !isStructuredOutputResult(session.structuredOutput)
  ) {
    return false;
  }
  if (
    session.structuredOutputTurns !== undefined &&
    (!Array.isArray(session.structuredOutputTurns) ||
      session.structuredOutputTurns.length > MAX_STRUCTURED_OUTPUT_TURNS ||
      session.structuredOutputTurns.some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
        const record = entry as Record<string, unknown>;
        return (
          typeof record.turnId !== "string" ||
          record.turnId.trim().length === 0 ||
          record.turnId.length > 2_048 ||
          typeof record.accepted !== "boolean"
        );
      }))
  ) {
    return false;
  }
  if (
    session.restartFailure !== undefined &&
    (!session.restartFailure ||
      typeof session.restartFailure !== "object" ||
      Array.isArray(session.restartFailure) ||
      Object.keys(session.restartFailure).length !== 1 ||
      typeof (session.restartFailure as Record<string, unknown>).turnId !== "string" ||
      (session.restartFailure as RestartFailureNotice).turnId.length === 0 ||
      (session.restartFailure as RestartFailureNotice).turnId.length > 2_048)
  ) {
    return false;
  }
  if (
    session.confirmedModelsByTurn !== undefined &&
    (!session.confirmedModelsByTurn ||
      typeof session.confirmedModelsByTurn !== "object" ||
      Array.isArray(session.confirmedModelsByTurn) ||
      Object.entries(session.confirmedModelsByTurn).some(
        ([turnId, modelId]) =>
          turnId.trim().length === 0 || typeof modelId !== "string" || modelId.trim().length === 0,
      ))
  ) {
    return false;
  }
  if (
    session.asyncQuestionItemIds !== undefined &&
    (!Array.isArray(session.asyncQuestionItemIds) ||
      session.asyncQuestionItemIds.length > 64 ||
      session.asyncQuestionItemIds.some(
        (itemId) => typeof itemId !== "string" || itemId.length === 0 || itemId.length > 2_048,
      ))
  ) {
    return false;
  }
  const lastAccessed =
    typeof session.lastAccessed === "string" ? Date.parse(session.lastAccessed) : Number.NaN;
  return Number.isFinite(lastAccessed) && lastAccessed >= cutoff;
}

function isPersistedSessionTombstone(value: unknown): value is PersistedSessionTombstone {
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

/** `loadRecord`'s "no file at this path", distinct from a file that is not a live record. */
const RECORD_FILE_MISSING = Symbol("record-file-missing");

/**
 * How long an orphaned `*.tmp` is left alone before it is collected. It only has
 * to outlast the write→rename window of any live writer — including one in
 * another process — so an hour is several orders of magnitude of headroom.
 */
const TEMP_FILE_GRACE_MS = 60 * 60 * 1000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

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
    return codexBridgeStateDir(this.codexHome);
  }

  private recordsDir(): string {
    return join(this.dir(), `bridge-sessions-${this.cwdHash}`);
  }

  /** This login's own records directory, when the state directory is somewhere else. */
  private loginRecordsDir(): string | undefined {
    const directory = join(codexLoginBridgeDir(this.codexHome), `bridge-sessions-${this.cwdHash}`);
    return directory === this.recordsDir() ? undefined : directory;
  }

  private recordKey(bridgeSessionId: string): string {
    return createHash("sha256").update(bridgeSessionId).digest("hex");
  }

  private recordPath(bridgeSessionId: string): string {
    return join(this.recordsDir(), `${this.recordKey(bridgeSessionId)}.json`);
  }

  private async ensurePrivateStorage(): Promise<void> {
    await mkdir(this.dir(), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(this.dir(), PRIVATE_DIRECTORY_MODE);
    await mkdir(this.recordsDir(), {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    await chmod(this.recordsDir(), PRIVATE_DIRECTORY_MODE);
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
    // A failed adoption is a cache miss, not a fatal error: this store holds no
    // user data, and letting it throw here leaves the engine unstarted for the
    // whole process lifetime because nothing retries load().
    await this.adoptLoginRecords().catch((error) => this.warnPersistenceFailure(error));

    let names: string[];
    try {
      await this.ensurePrivateStorage();
      names = await readdir(this.recordsDir());
    } catch {
      return [];
    }

    const records = await Promise.all(
      names.map(async (name) => {
        const path = join(this.recordsDir(), name);
        if (name.endsWith(".tmp")) {
          await chmod(path, PRIVATE_FILE_MODE).catch(() => undefined);
          await this.collectStaleTemporary(path);
          return null;
        }
        if (!name.endsWith(".json")) return null;
        try {
          await chmod(path, PRIVATE_FILE_MODE);
          const value = JSON.parse(await readFile(path, "utf8")) as unknown;
          if (isPersistedSessionTombstone(value)) {
            // A tombstone only exists to stop login-record adoption
            // re-publishing a record that was deleted. Past retention the
            // record it shields against is itself expired, so keeping it would
            // mean every session ever created leaves a permanent file behind.
            if (Date.parse(value.deletedAt) < cutoff) {
              await rm(path, { force: true }).catch(() => undefined);
            }
            return null;
          }
          return isPersistedBridgeSession(value, this.cwdHash, cutoff) ? value : null;
        } catch {
          return null;
        }
      }),
    );
    return records.filter((record): record is PersistedBridgeSession => record !== null);
  }

  /**
   * The durable record for one session, as `load()` would report it, or null.
   *
   * Reads only that session's record file: no login-record adoption, directory listing, chmod or sweep. Those all belong to `load()`,
   * which runs at startup; this is for hot paths that ask about one session
   * (every Codex config read). A tombstone, an invalid or expired record, or a
   * record naming another session is null, exactly as `load()` would drop it.
   *
   * Only when no record file exists does it look further, at the copy `load()`
   * would have published there first: this login's own records directory. It
   * is read, never written, and normally absent once `load()` has run.
   */
  async loadRecord(bridgeSessionId: string): Promise<PersistedBridgeSession | null> {
    const cutoff = this.now() - this.retentionMs;
    const key = `${this.recordKey(bridgeSessionId)}.json`;
    const record = await this.readRecordFile(join(this.recordsDir(), key), bridgeSessionId, cutoff);
    if (record !== RECORD_FILE_MISSING) return record;

    const loginRecords = this.loginRecordsDir();
    if (!loginRecords) return null;
    const adoptable = await this.readRecordFile(join(loginRecords, key), bridgeSessionId, cutoff);
    return adoptable === RECORD_FILE_MISSING ? null : adoptable;
  }

  /** One record file, validated as `load()` validates it; missing only on ENOENT. */
  private async readRecordFile(
    path: string,
    bridgeSessionId: string,
    cutoff: number,
  ): Promise<PersistedBridgeSession | null | typeof RECORD_FILE_MISSING> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? RECORD_FILE_MISSING : null;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (isPersistedSessionTombstone(value)) return null;
      return isPersistedBridgeSession(value, this.cwdHash, cutoff) &&
        value.bridgeSessionId === bridgeSessionId
        ? value
        : null;
    } catch {
      return null;
    }
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
   * Publishes a tombstone rather than unlinking, so a login-record adoption
   * that still finds the record in this login's own directory cannot
   * re-publish it. The tombstone is collected by `load()` once it passes
   * retention.
   */
  async remove(bridgeSessionId: string): Promise<void> {
    await this.publishRemoval(bridgeSessionId).catch((error) => this.warnPersistenceFailure(error));
  }

  /**
   * `remove`, but a failed tombstone write rejects instead of warning.
   *
   * The ordinary tab close must not confirm a removal it did not publish: a
   * record left on disk is restored as a live session on the next start.
   */
  async publishRemoval(bridgeSessionId: string): Promise<void> {
    const attempt = this.writeChain.then(async () => {
      await this.ensurePrivateStorage();
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
    await attempt;
  }

  /**
   * Moves the records a bridge on this login kept in its own `CODEX_HOME`,
   * before the state directory was shared across accounts, into the shared one.
   * Each is published only where none exists, so a newer write or a tombstone
   * already there wins, and is then removed from the login's directory. Copied
   * rather than linked, because the two homes can be on different filesystems.
   */
  private async adoptLoginRecords(): Promise<void> {
    const source = this.loginRecordsDir();
    if (!source) return;
    const names = (await readdir(source).catch(() => [] as string[])).filter((name) =>
      name.endsWith(".json"),
    );
    if (names.length === 0) return;
    await this.ensurePrivateStorage();
    await Promise.all(
      names.map(async (name) => {
        const from = join(source, name);
        const target = join(this.recordsDir(), name);
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, await readFile(from), { mode: PRIVATE_FILE_MODE });
        await chmod(temporary, PRIVATE_FILE_MODE);
        try {
          await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
        await chmod(target, PRIVATE_FILE_MODE);
        await rm(from, { force: true }).catch(() => undefined);
      }),
    );
  }

  private async writeRecordAtomic(session: PersistedBridgeSession): Promise<void> {
    await this.ensurePrivateStorage();
    await this.writeAtomicPath(
      this.recordPath(session.bridgeSessionId),
      `${JSON.stringify(session, null, 2)}\n`,
    );
  }

  private async writeAtomicPath(path: string, payload: string): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
    });
    await chmod(temporary, PRIVATE_FILE_MODE);
    await rename(temporary, path).catch(async (error: unknown) => {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    });
    await chmod(path, PRIVATE_FILE_MODE);
  }

  private warnPersistenceFailure(error: unknown): void {
    log.warn("registry.persist-failed", { error: formatLogError(error, { stack: false }) });
  }

  toRecord(options: {
    bridgeSessionId: string;
    threadId: string;
    cwd: string;
    config: EngineTurnConfig;
    title?: string;
    titleSource?: SessionTitleSource;
    lastAcceptedRequestId?: string;
    structuredOutputRequestId?: string;
    structuredOutput?: StructuredOutputResult;
    structuredOutputTurns?: StructuredOutputTurnRecord[];
    restartFailure?: RestartFailureNotice;
    confirmedModelsByTurn?: Record<string, string>;
    asyncQuestionItemIds?: string[];
  }): PersistedBridgeSession {
    const { agentMcp: _agentMcp, ...persistedConfig } = options.config;
    return {
      bridgeSessionId: options.bridgeSessionId,
      threadId: options.threadId,
      cwdHash: hashCwd(options.cwd),
      config: persistedConfig,
      title: options.title,
      titleSource: options.titleSource,
      lastAcceptedRequestId: options.lastAcceptedRequestId,
      structuredOutputRequestId: options.structuredOutputRequestId,
      structuredOutput: options.structuredOutput,
      structuredOutputTurns: options.structuredOutputTurns?.map((entry) => ({ ...entry })),
      restartFailure: options.restartFailure ? { ...options.restartFailure } : undefined,
      confirmedModelsByTurn: options.confirmedModelsByTurn,
      asyncQuestionItemIds: options.asyncQuestionItemIds,
      lastAccessed: new Date(this.now()).toISOString(),
    };
  }
}
