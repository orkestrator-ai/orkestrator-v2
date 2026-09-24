/**
 * Bounded reads, opaque revisions, locking and atomic replacement for native
 * provider configuration files.
 *
 * Guarantees, and their limits:
 *
 * - Cooperating Orkestrator writers (this process and other backends of the
 *   same OS user, including dev/test profiles) serialize on a lock keyed by the
 *   file's real path, so two windows cannot lose each other's edit.
 * - Every commit re-reads the file immediately before the rename and refuses
 *   when its revision moved. A non-cooperating editor that writes between that
 *   final check and the rename can still be overwritten; a filesystem rename
 *   is not a compare-and-swap, and nothing here claims otherwise.
 * - The replacement is a same-directory private temporary file, flushed and
 *   renamed over the target, so a crash leaves either the old or the new file.
 */

import { createHmac, randomBytes, randomUUID, createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { mcpFailure } from "@orkestrator/protocol/mcp-management";

export type SourceReadState = "ok" | "absent" | "oversized" | "permission-denied" | "invalid";

export interface SourceFileSnapshot {
  path: string;
  /** Real path of an existing file, or the resolved destination of an absent one. */
  realPath: string;
  state: SourceReadState;
  text: string | null;
  revision: string | null;
  /**
   * Unkeyed `sha256:<base64url>` of the exact bytes read, when they were read.
   * Backend-only: it is what bridges report for the files a runtime loaded, so
   * the apply scheduler can match the two. Never sent to the renderer, because
   * an unkeyed digest lets a caller confirm a guess about a low-entropy secret.
   */
  contentDigest?: string;
  mode: number | null;
  /** Why the file cannot be written, when it can still be read. */
  writeBlock?: string;
  error?: string;
}

export interface SourceWritePolicy {
  /** Real path the source (and any created parents) must stay inside. */
  allowedRoot?: string;
  /** Mode for a newly created file. Existing files keep their mode. */
  createMode: number;
  /** User configuration can contain literal credentials, including after this edit. */
  privateExisting?: boolean;
  maxBytes: number;
}

export const ABSENT_REVISION = "absent";

/**
 * The digest format bridges use for a configuration file they loaded:
 * `sha256:` followed by the unpadded base64url SHA-256 of the exact bytes.
 */
export function contentDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("base64url")}`;
}

const LOCK_WAIT_MS = 5_000;
/** Age after which an unparseable lock body (a crashed creator) is taken over. */
const LOCK_STALE_UNVERIFIABLE_MS = 10 * 60_000;

function isErrno(error: unknown, ...codes: string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    codes.includes((error as NodeJS.ErrnoException).code ?? "")
  );
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readProcStart(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    // Field 22 (starttime) follows the parenthesised command, which may contain spaces.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

export class McpSourceStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private key: Buffer | null = null;
  private selfStart: string | null | undefined;

  constructor(
    private readonly options: {
      /** Private file holding the revision HMAC key; created on first use. */
      keyFile: string;
      lockDir?: string;
      /** How long to wait for another writer before reporting `busy`. */
      lockWaitMs?: number;
    },
  ) {}

  /** Private per-backend key; also used for operation fingerprints. */
  async secretKey(): Promise<Buffer> {
    if (this.key) return this.key;
    try {
      const existing = await fs.readFile(this.options.keyFile);
      if (existing.byteLength >= 32) {
        this.key = existing;
        return existing;
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const created = randomBytes(32);
    await fs.mkdir(path.dirname(this.options.keyFile), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(this.options.keyFile, created, { mode: 0o600, flag: "wx" });
      this.key = created;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      this.key = await fs.readFile(this.options.keyFile);
    }
    return this.key;
  }

  /**
   * Opaque revision of whole-file bytes. Keyed, so a revision cannot be used
   * to confirm a guess about a low-entropy secret inside the file.
   */
  async revisionOf(bytes: Uint8Array | null): Promise<string> {
    if (bytes === null) return ABSENT_REVISION;
    const digest = createHmac("sha256", await this.secretKey())
      .update(bytes)
      .digest("base64url");
    return `r1.${digest.slice(0, 32)}`;
  }

  async read(filePath: string, policy: SourceWritePolicy): Promise<SourceFileSnapshot> {
    let realPath = filePath;
    let writeBlock: string | undefined;
    try {
      await fs.lstat(filePath);
      // Resolve every component: a symlinked parent directory can lead out of
      // the worktree just as a symlinked file can.
      realPath = await fs.realpath(filePath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return this.absentSnapshot(filePath, policy);
      }
      if (isErrno(error, "EACCES", "EPERM")) {
        return {
          path: filePath,
          realPath,
          state: "permission-denied",
          text: null,
          revision: null,
          mode: null,
          error: "Permission denied.",
        };
      }
      throw error;
    }
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(realPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return this.absentSnapshot(filePath, policy);
      if (isErrno(error, "EACCES", "EPERM")) {
        return {
          path: filePath,
          realPath,
          state: "permission-denied",
          text: null,
          revision: null,
          mode: null,
          error: "Permission denied.",
        };
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        return {
          path: filePath,
          realPath,
          state: "invalid",
          text: null,
          revision: null,
          mode: null,
          error: "Not a regular file.",
        };
      }
      if (stat.size > policy.maxBytes) {
        return {
          path: filePath,
          realPath,
          state: "oversized",
          text: null,
          revision: null,
          mode: stat.mode & 0o777,
          error: `Larger than ${Math.round(policy.maxBytes / 1024)} KiB; left read-only.`,
        };
      }
      // Read one byte past the limit so a file growing between stat and read is caught.
      const buffer = Buffer.alloc(Math.min(policy.maxBytes + 1, stat.size + 1));
      let total = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
        if (total >= buffer.length) break;
      }
      if (total > policy.maxBytes) {
        return {
          path: filePath,
          realPath,
          state: "oversized",
          text: null,
          revision: null,
          mode: stat.mode & 0o777,
          error: "File grew beyond the size limit.",
        };
      }
      const bytes = buffer.subarray(0, total);
      if (policy.allowedRoot) {
        const root = await fs.realpath(policy.allowedRoot).catch(() => policy.allowedRoot!);
        if (!within(root, realPath))
          writeBlock = "The file links outside the worktree, so it is read-only here.";
      }
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        writeBlock = "The file is owned by another user.";
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return {
          path: filePath,
          realPath,
          state: "invalid",
          text: null,
          revision: await this.revisionOf(bytes),
          contentDigest: contentDigest(bytes),
          mode: stat.mode & 0o777,
          error: "Not valid UTF-8.",
        };
      }
      return {
        path: filePath,
        realPath,
        state: "ok",
        text,
        revision: await this.revisionOf(bytes),
        contentDigest: contentDigest(bytes),
        mode: stat.mode & 0o777,
        writeBlock,
      };
    } finally {
      await handle.close();
    }
  }

  private async absentSnapshot(
    filePath: string,
    policy: SourceWritePolicy,
  ): Promise<SourceFileSnapshot> {
    const snapshot: SourceFileSnapshot = {
      path: filePath,
      realPath: filePath,
      state: "absent",
      text: null,
      revision: ABSENT_REVISION,
      mode: null,
    };
    // Resolve the nearest existing ancestor; a symlinked parent must not lead out of the root.
    let ancestor = path.dirname(filePath);
    const missing: string[] = [path.basename(filePath)];
    for (;;) {
      try {
        const real = await fs.realpath(ancestor);
        snapshot.realPath = path.join(real, ...missing);
        break;
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          snapshot.writeBlock = "The configuration directory is not accessible.";
          return snapshot;
        }
        missing.unshift(path.basename(ancestor));
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    if (policy.allowedRoot) {
      const root = await fs.realpath(policy.allowedRoot).catch(() => policy.allowedRoot!);
      if (!within(root, snapshot.realPath)) {
        snapshot.writeBlock = "The configuration directory links outside the worktree.";
      }
    }
    return snapshot;
  }

  /**
   * Serialize work on one backing file across this process and other
   * cooperating backends. Different sources that share one file (Claude's user
   * and private-local maps) must pass the same `filePath`.
   */
  async withLock<T>(filePath: string, work: () => Promise<T>): Promise<T> {
    const resolved = await this.lockIdentity(filePath);
    const previous = this.queues.get(resolved) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const release = await this.acquireFileLock(resolved);
        try {
          return await work();
        } finally {
          await release();
        }
      });
    const settled = run.catch(() => undefined);
    this.queues.set(resolved, settled);
    void settled.then(() => {
      if (this.queues.get(resolved) === settled) this.queues.delete(resolved);
    });
    return run;
  }

  private async lockIdentity(filePath: string): Promise<string> {
    try {
      return await fs.realpath(filePath);
    } catch {
      const parent = await fs.realpath(path.dirname(filePath)).catch(() => path.dirname(filePath));
      return path.join(parent, path.basename(filePath));
    }
  }

  private lockDir(): string {
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    return this.options.lockDir ?? path.join(os.tmpdir(), `orkestrator-mcp-locks-${uid}`);
  }

  private async acquireFileLock(identity: string): Promise<() => Promise<void>> {
    const dir = this.lockDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(
      dir,
      `${createHash("sha256").update(identity).digest("hex").slice(0, 40)}.lock`,
    );
    if (this.selfStart === undefined) this.selfStart = await readProcStart(process.pid);
    const token = randomUUID();
    const body = JSON.stringify({ pid: process.pid, start: this.selfStart, token, at: Date.now() });
    const deadline = Date.now() + (this.options.lockWaitMs ?? LOCK_WAIT_MS);
    for (;;) {
      try {
        await fs.writeFile(lockPath, body, { flag: "wx", mode: 0o600 });
        return async () => {
          try {
            const current = await fs.readFile(lockPath, "utf8");
            if (current.includes(token)) await fs.unlink(lockPath);
          } catch {
            // Already gone; nothing to release.
          }
        };
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      if (await this.lockIsStale(lockPath)) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw mcpFailure("busy", {
          message: "Another Orkestrator window is changing this file. Retry shortly.",
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  private async lockIsStale(lockPath: string): Promise<boolean> {
    let holder: { pid?: unknown; start?: unknown; at?: unknown };
    try {
      holder = JSON.parse(await fs.readFile(lockPath, "utf8"));
    } catch (error) {
      // Mid-write by its creator, or removed: not stale, just retry.
      if (isErrno(error, "ENOENT")) return false;
      const stat = await fs.stat(lockPath).catch(() => null);
      return !!stat && Date.now() - stat.mtimeMs > LOCK_STALE_UNVERIFIABLE_MS;
    }
    const pid = typeof holder.pid === "number" ? holder.pid : null;
    if (pid === null || !pidAlive(pid)) return true;
    // A live pid may have been reused: prove identity by its start time.
    if (typeof holder.start === "string") {
      const current = await readProcStart(pid);
      if (current !== null) return current !== holder.start;
    }
    // A live holder whose identity cannot be checked (no /proc) is never taken
    // over on age alone: a slow write in another window is still a write, and
    // breaking its lock could lose it. The caller reports `busy` instead.
    return false;
  }

  /**
   * Replace the file with `text` if its revision still equals `expected`.
   * Must be called inside {@link withLock} for the same path.
   */
  async commit(
    snapshot: SourceFileSnapshot,
    expected: string,
    text: string,
    policy: SourceWritePolicy,
  ): Promise<SourceFileSnapshot> {
    if (snapshot.writeBlock) throw mcpFailure("read-only-source", { message: snapshot.writeBlock });
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength > policy.maxBytes) {
      throw mcpFailure("oversized-source", {
        message: "The result would exceed the file size limit.",
      });
    }
    const target = snapshot.realPath;
    const directory = path.dirname(target);
    if (snapshot.state === "absent") {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (policy.allowedRoot) {
        const root = await fs.realpath(policy.allowedRoot);
        if (!within(root, await fs.realpath(directory))) {
          throw mcpFailure("read-only-source", {
            message: "The configuration directory links outside the worktree.",
          });
        }
      }
    }
    const temporary = path.join(
      directory,
      `.${path.basename(target)}.orkestrator-${randomUUID()}.tmp`,
    );
    const mode = policy.privateExisting
      ? (snapshot.mode ?? policy.createMode) & 0o700
      : (snapshot.mode ?? policy.createMode);
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        mode,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.chmod(temporary, mode);
      // Last check before the rename: refuse if anything moved under us.
      const current = await this.read(snapshot.path, policy);
      if (current.revision !== expected || current.realPath !== target) {
        throw mcpFailure("revision-conflict");
      }
      await fs.rename(temporary, target);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      if (isErrno(error, "ENOSPC"))
        throw mcpFailure("internal", { message: "The disk is full; the file was left unchanged." });
      if (isErrno(error, "EROFS", "EACCES", "EPERM")) {
        throw mcpFailure("read-only-source", {
          message: "The file system refused the write; the file was left unchanged.",
        });
      }
      throw error;
    }
    await this.syncDirectory(directory);
    return this.read(snapshot.path, policy);
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(directory, fsConstants.O_RDONLY);
      await handle.sync();
    } catch {
      // Not supported on every platform/filesystem; the rename already happened.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
