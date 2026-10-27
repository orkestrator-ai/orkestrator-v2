/**
 * `transcript_media_open_stream`: range-capable playback of environment media
 * through the artifact content origin, instead of base64 through `invoke`.
 *
 * Resolution goes only through the existing confined readers:
 *
 * - Local environments: `openReadableHostFile` (path-safety.ts), the same
 *   confinement as `read_file_base64` / `read_environment_file_base64`,
 *   rooted at the environment's own worktree (lexical and canonical form).
 *   Every served request re-opens the file through it, so a file replaced by
 *   a symbolic link, moved out, or deleted stops being served. Ranged reads
 *   go straight to the opened handle; nothing is buffered whole.
 * - Container environments: the container safe reader
 *   (`buildContainerSafeBase64Reader`, `stream` mode: the attachment
 *   validation with raw output) copies the file once into a private backend
 *   staging directory, bounded per file, per environment and in total, with
 *   at most two copies at a time. The copy is discarded unless the reader's
 *   final stability check passes. Staged copies are removed when their stream
 *   closes or expires, when their environment disappears, and wholesale at
 *   startup.
 *
 * The media type is sniffed from the bytes (media-stream-sniff.ts), never
 * the file name; only audio, video and raster images are served. Capability
 * URLs are bearer secrets and are never logged.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  TRANSCRIPT_MEDIA_STREAM_MAX_CONTAINER_BYTES,
  TRANSCRIPT_MEDIA_STREAM_MAX_HOST_BYTES,
  type TranscriptMediaStreamResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  ArtifactFailure,
  artifactError,
  type ArtifactErrorCode,
} from "@orkestrator/protocol/transcript-artifacts";

import { openReadableHostFile, validateRelativeFilePath } from "../path-safety.js";
import type { MintMediaInput, OpenedMediaFile } from "./media-stream-route.js";
import { MEDIA_SNIFF_BYTES, sniffServedMediaMime } from "./media-stream-sniff.js";

/** Staged container bytes allowed per environment and in total. */
export const MEDIA_STAGING_ENVIRONMENT_QUOTA_BYTES = 1024 * 1024 * 1024;
export const MEDIA_STAGING_TOTAL_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const MEDIA_STAGING_MAX_CONCURRENT_COPIES = 2;
export const MEDIA_STAGING_COPY_TIMEOUT_MS = 10 * 60 * 1000;
export const MEDIA_STREAM_MAX_SESSIONS = 128;
const MEDIA_SWEEP_INTERVAL_MS = 60_000;

/** The content listener's media surface (LoopbackArtifactContentServer). */
export interface MediaStreamServer {
  origin(): string | null;
  mintMedia(input: MintMediaInput): { url: string; expiresAt: string; generation: string };
  revokeMedia(generation: string): void;
  mediaLive(generation: string): boolean;
}

export interface MediaStreamEnvironment {
  id: string;
  environmentType: string;
  worktreePath?: string | null;
  containerId?: string | null;
  deletionRequestedAt?: string | null;
}

/** Starts the container reader for one file; stdout carries the raw bytes. */
export type ContainerReaderSpawner = (input: {
  containerId: string;
  workspacePath: string;
  maxBytes: number;
}) => ChildProcessWithoutNullStreams;

export interface TranscriptMediaStreamsOptions {
  server: () => MediaStreamServer | null;
  getEnvironment: (environmentId: string) => Promise<MediaStreamEnvironment | null>;
  stagingRoot: string;
  spawnContainerReader: ContainerReaderSpawner;
  containerIdMatches?: (known: string, candidate: string) => boolean;
  limits?: Partial<{
    maxHostBytes: number;
    maxContainerBytes: number;
    environmentQuotaBytes: number;
    totalQuotaBytes: number;
    maxConcurrentCopies: number;
    copyTimeoutMs: number;
    maxSessions: number;
  }>;
}

interface StreamSession {
  environmentId: string;
  kind: "host" | "container";
  worktreePath?: string;
  containerId?: string;
  stagedPath?: string;
  stagedBytes: number;
}

function fail(code: ArtifactErrorCode, message: string): never {
  throw new ArtifactFailure(artifactError(code, message));
}

function identityOf(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function defaultContainerIdMatches(known: string, candidate: string): boolean {
  const left = known.trim();
  const right = candidate.trim();
  return left.length > 0 && right.length > 0 && (left.startsWith(right) || right.startsWith(left));
}

/** Classifies a host confinement or open failure without echoing the path. */
function hostOpenFailure(error: unknown): ArtifactFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ArtifactFailure(artifactError("not_found", "The file does not exist"));
  }
  if (code === "ELOOP" || /symbolic link/i.test(message)) {
    return new ArtifactFailure(
      artifactError("policy_denied", "Symbolic links are not served as media"),
    );
  }
  if (/outside|absolute path|traversal|control characters|stay inside/i.test(message)) {
    return new ArtifactFailure(
      artifactError("policy_denied", "The file is outside the environment's workspace"),
    );
  }
  if (/regular file/i.test(message)) {
    return new ArtifactFailure(artifactError("policy_denied", "Only regular files are served"));
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ArtifactFailure(artifactError("policy_denied", "Access to the file was denied"));
  }
  return new ArtifactFailure(artifactError("not_found", "The file is unavailable"));
}

async function readHead(handle: FileHandle, size: number): Promise<Uint8Array> {
  const buffer = Buffer.alloc(Math.min(size, MEDIA_SNIFF_BYTES));
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

function relativeContainerPath(value: string): string {
  const stripped = value.startsWith("/workspace/") ? value.slice("/workspace/".length) : value;
  try {
    return validateRelativeFilePath(stripped);
  } catch {
    fail("policy_denied", "The file is outside the container workspace");
  }
}

export class TranscriptMediaStreams {
  private readonly sessions = new Map<string, StreamSession>();
  private readonly limits: Required<NonNullable<TranscriptMediaStreamsOptions["limits"]>>;
  private readonly containerIdMatches: (known: string, candidate: string) => boolean;
  private activeCopies = 0;
  /** Bytes staged or reserved by in-flight copies, per environment. */
  private readonly stagedByEnvironment = new Map<string, number>();
  private stagedTotal = 0;
  /** Wipes a previous process's copies (never served again) once, at creation. */
  private readonly stagingReady: Promise<void>;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly options: TranscriptMediaStreamsOptions) {
    this.containerIdMatches = options.containerIdMatches ?? defaultContainerIdMatches;
    this.limits = {
      maxHostBytes: TRANSCRIPT_MEDIA_STREAM_MAX_HOST_BYTES,
      maxContainerBytes: TRANSCRIPT_MEDIA_STREAM_MAX_CONTAINER_BYTES,
      environmentQuotaBytes: MEDIA_STAGING_ENVIRONMENT_QUOTA_BYTES,
      totalQuotaBytes: MEDIA_STAGING_TOTAL_QUOTA_BYTES,
      maxConcurrentCopies: MEDIA_STAGING_MAX_CONCURRENT_COPIES,
      copyTimeoutMs: MEDIA_STAGING_COPY_TIMEOUT_MS,
      maxSessions: MEDIA_STREAM_MAX_SESSIONS,
      ...options.limits,
    };
    this.stagingReady = fs
      .rm(options.stagingRoot, { recursive: true, force: true })
      .then(() => fs.mkdir(options.stagingRoot, { recursive: true, mode: 0o700 }))
      .then(() => undefined);
    // Observed here so a failure surfaces at first use, never as an unhandled rejection.
    this.stagingReady.catch(() => undefined);
  }

  async open(request: Record<string, unknown>): Promise<TranscriptMediaStreamResponse> {
    if (this.closed) fail("renderer_unavailable", "Media streaming is unavailable");
    const { environmentId, path: requestedPath, containerId } = request;
    if (
      typeof environmentId !== "string" ||
      environmentId.length === 0 ||
      environmentId.length > 256
    ) {
      fail("invalid_input", "environmentId is required");
    }
    if (
      typeof requestedPath !== "string" ||
      requestedPath.length === 0 ||
      requestedPath.length > 4096
    ) {
      fail("invalid_input", "path is required");
    }
    if (containerId !== undefined && containerId !== null && typeof containerId !== "string") {
      fail("invalid_input", "containerId must be a string");
    }
    const server = this.options.server();
    if (!server || server.origin() === null) {
      fail("renderer_unavailable", "The artifact content origin is unavailable");
    }
    const environment = await this.environment(environmentId);
    if (environment.environmentType === "local") {
      if (typeof containerId === "string" && containerId.length > 0) {
        fail("invalid_input", "This environment has no container");
      }
      return this.openHost(server, environment, requestedPath);
    }
    if (!environment.containerId) fail("not_found", "The environment's container is unavailable");
    if (
      typeof containerId === "string" &&
      containerId.length > 0 &&
      !this.containerIdMatches(environment.containerId, containerId)
    ) {
      fail("policy_denied", "The container does not belong to this environment");
    }
    return this.openContainer(server, environment, requestedPath);
  }

  /** Revokes one stream and releases its staged copy. Unknown ids are ignored. */
  close(streamId: unknown): void {
    if (typeof streamId !== "string" || streamId.length > 256) return;
    this.release(streamId);
  }

  /** Releases expired or revoked streams and streams of environments that are gone. */
  async sweep(): Promise<void> {
    const server = this.options.server();
    const environments = new Map<string, boolean>();
    for (const [streamId, session] of Array.from(this.sessions)) {
      if (!server || !server.mediaLive(streamId)) {
        this.release(streamId);
        continue;
      }
      let present = environments.get(session.environmentId);
      if (present === undefined) {
        present = await this.options
          .getEnvironment(session.environmentId)
          .then((environment) => Boolean(environment && !environment.deletionRequestedAt))
          .catch(() => true);
        environments.set(session.environmentId, present);
      }
      if (!present) this.release(streamId);
    }
    if (this.sessions.size === 0) this.stopSweep();
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.stopSweep();
    for (const streamId of Array.from(this.sessions.keys())) this.release(streamId);
    // The staging root is re-created at construction without being awaited;
    // settle it so nothing lands in the root after its owner removed it.
    await this.stagingReady.catch(() => undefined);
  }

  /** Live stream count (tests and diagnostics). */
  size(): number {
    return this.sessions.size;
  }

  stagedBytes(environmentId?: string): number {
    return environmentId === undefined
      ? this.stagedTotal
      : (this.stagedByEnvironment.get(environmentId) ?? 0);
  }

  private async environment(environmentId: string): Promise<MediaStreamEnvironment> {
    let environment: MediaStreamEnvironment | null;
    try {
      environment = await this.options.getEnvironment(environmentId);
    } catch {
      environment = null;
    }
    if (!environment || environment.deletionRequestedAt) {
      fail("not_found", "Environment not found");
    }
    return environment;
  }

  private async environmentStillServes(session: StreamSession): Promise<boolean> {
    const environment = await this.options.getEnvironment(session.environmentId);
    if (!environment || environment.deletionRequestedAt) return false;
    if (session.kind === "host") {
      return (
        environment.environmentType === "local" && environment.worktreePath === session.worktreePath
      );
    }
    return (
      environment.environmentType !== "local" &&
      !!environment.containerId &&
      environment.containerId === session.containerId
    );
  }

  private async openHost(
    server: MediaStreamServer,
    environment: MediaStreamEnvironment,
    requestedPath: string,
  ): Promise<TranscriptMediaStreamResponse> {
    const worktreePath = environment.worktreePath;
    if (!worktreePath) fail("not_found", "The environment has no worktree");
    const roots = [worktreePath];
    const canonical = await fs.realpath(worktreePath).catch(() => null);
    if (canonical && canonical !== worktreePath) roots.push(canonical);
    let absolute: string;
    if (path.isAbsolute(requestedPath)) absolute = path.resolve(requestedPath);
    else {
      try {
        absolute = path.join(worktreePath, validateRelativeFilePath(requestedPath));
      } catch {
        fail("policy_denied", "The file is outside the environment's workspace");
      }
    }
    const resolve = async (): Promise<OpenedMediaFile> => {
      const { handle, stats } = await openReadableHostFile(absolute, roots);
      return { handle, size: stats.size, identity: identityOf(stats) };
    };
    let opened: OpenedMediaFile;
    try {
      opened = await resolve();
    } catch (error) {
      throw hostOpenFailure(error);
    }
    let mimeType: string | null;
    try {
      if (opened.size > this.limits.maxHostBytes) {
        fail("package_size_exceeded", "The file is larger than the media streaming limit");
      }
      mimeType = sniffServedMediaMime(await readHead(opened.handle, opened.size));
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
    if (!mimeType)
      fail(
        "unsupported_kind",
        "The file's contents are not a supported audio, video or image type",
      );
    const session: StreamSession = {
      environmentId: environment.id,
      kind: "host",
      worktreePath,
      stagedBytes: 0,
    };
    return this.mint(server, session, {
      mimeType,
      byteLength: opened.size,
      identity: opened.identity,
      resolve,
    });
  }

  private async openContainer(
    server: MediaStreamServer,
    environment: MediaStreamEnvironment,
    requestedPath: string,
  ): Promise<TranscriptMediaStreamResponse> {
    const containerId = environment.containerId!;
    const workspacePath = `/workspace/${relativeContainerPath(requestedPath)}`;
    if (this.activeCopies >= this.limits.maxConcurrentCopies) {
      fail("capacity_exceeded", "Too many media files are being prepared; try again shortly");
    }
    // Reserve before awaiting so concurrent opens cannot oversubscribe the quota.
    this.makeRoom(environment.id);
    const reserve = Math.min(
      this.limits.maxContainerBytes,
      this.limits.environmentQuotaBytes - this.stagedBytes(environment.id),
      this.limits.totalQuotaBytes - this.stagedTotal,
    );
    if (reserve <= 0) fail("capacity_exceeded", "The media staging quota is exhausted");
    this.activeCopies++;
    this.account(environment.id, reserve);
    let stagedPath: string | undefined;
    let stagedBytes = 0;
    try {
      stagedPath = await this.stagingPath(environment.id);
      stagedBytes = await this.copyFromContainer(
        containerId,
        workspacePath,
        reserve,
        stagedPath,
        reserve < this.limits.maxContainerBytes,
      );
    } catch (error) {
      if (stagedPath) await fs.rm(stagedPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      this.activeCopies--;
      this.account(environment.id, -reserve);
    }
    this.account(environment.id, stagedBytes);
    const staged = stagedPath;
    const resolve = async (): Promise<OpenedMediaFile> => {
      const handle = await fs.open(staged, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new Error("not a regular file");
        return { handle, size: stats.size, identity: identityOf(stats) };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    };
    const session: StreamSession = {
      environmentId: environment.id,
      kind: "container",
      containerId,
      stagedPath: staged,
      stagedBytes,
    };
    try {
      const opened = await resolve();
      let mimeType: string | null;
      try {
        mimeType = sniffServedMediaMime(await readHead(opened.handle, opened.size));
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
      if (!mimeType)
        fail(
          "unsupported_kind",
          "The file's contents are not a supported audio, video or image type",
        );
      return this.mint(server, session, {
        mimeType,
        byteLength: opened.size,
        identity: opened.identity,
        resolve,
      });
    } catch (error) {
      this.account(environment.id, -stagedBytes);
      await fs.rm(staged, { force: true }).catch(() => undefined);
      if (error instanceof ArtifactFailure) throw error;
      fail("storage_unavailable", "The staged media copy could not be read");
    }
  }

  private mint(
    server: MediaStreamServer,
    session: StreamSession,
    file: Pick<MintMediaInput, "mimeType" | "byteLength" | "identity" | "resolve">,
  ): TranscriptMediaStreamResponse {
    let streamId: string | undefined;
    let minted: { url: string; expiresAt: string; generation: string };
    try {
      minted = server.mintMedia({
        ownerKey: session.environmentId,
        ...file,
        // Every served request: this stream is still open and its environment
        // still exists with the same worktree or container. Read-only.
        authorize: async () => {
          try {
            if (streamId === undefined || this.sessions.get(streamId) !== session) return false;
            return await this.environmentStillServes(session);
          } catch {
            return false;
          }
        },
      });
    } catch {
      fail("renderer_unavailable", "The artifact content origin is unavailable");
    }
    streamId = minted.generation;
    this.sessions.set(streamId, session);
    while (this.sessions.size > this.limits.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.release(oldest);
    }
    this.startSweep();
    return {
      url: minted.url,
      mimeType: file.mimeType,
      byteLength: file.byteLength,
      expiresAt: minted.expiresAt,
      streamId,
    };
  }

  private release(streamId: string): void {
    const session = this.sessions.get(streamId);
    this.sessions.delete(streamId);
    this.options.server()?.revokeMedia(streamId);
    if (!session) return;
    if (session.stagedPath) {
      this.account(session.environmentId, -session.stagedBytes);
      void fs.rm(session.stagedPath, { force: true }).catch(() => undefined);
    }
  }

  private account(environmentId: string, delta: number): void {
    const next = Math.max(0, (this.stagedByEnvironment.get(environmentId) ?? 0) + delta);
    if (next === 0) this.stagedByEnvironment.delete(environmentId);
    else this.stagedByEnvironment.set(environmentId, next);
    this.stagedTotal = Math.max(0, this.stagedTotal + delta);
  }

  /**
   * Oldest-first eviction of this environment's staged streams until a
   * maximum-size copy fits its quota (and the total quota).
   */
  private makeRoom(environmentId: string): void {
    const max = this.limits.maxContainerBytes;
    for (const [streamId, session] of Array.from(this.sessions)) {
      const environmentFull =
        this.stagedBytes(environmentId) + max > this.limits.environmentQuotaBytes;
      const totalFull = this.stagedTotal + max > this.limits.totalQuotaBytes;
      if (!environmentFull && !totalFull) return;
      if (!session.stagedPath) continue;
      // A full environment quota only evicts that environment's copies.
      if (session.environmentId === environmentId || !environmentFull) this.release(streamId);
    }
  }

  private async stagingPath(environmentId: string): Promise<string> {
    await this.stagingReady;
    const directory = path.join(
      this.options.stagingRoot,
      createHash("sha256").update(environmentId).digest("hex").slice(0, 24),
    );
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return path.join(directory, `${randomUUID()}.media`);
  }

  /** Streams the container reader's output into `destination`; returns the byte count. */
  private copyFromContainer(
    containerId: string,
    workspacePath: string,
    maxBytes: number,
    destination: string,
    limitedByQuota: boolean,
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let received = 0;
      let overflow = false;
      let stderr = "";
      const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.options.spawnContainerReader({ containerId, workspacePath, maxBytes });
      } catch {
        output.destroy();
        reject(new ArtifactFailure(artifactError("not_found", "The container is unavailable")));
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(
          new ArtifactFailure(
            artifactError("capacity_exceeded", "Preparing the media file timed out"),
          ),
        );
      }, this.limits.copyTimeoutMs);
      const finish = (error: ArtifactFailure | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          child.kill("SIGKILL");
          output.destroy();
          reject(error);
          return;
        }
        output.once("finish", () => resolve(received));
        output.once("error", () =>
          reject(
            new ArtifactFailure(
              artifactError("storage_unavailable", "The media staging area is unavailable"),
            ),
          ),
        );
        output.end();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        received += chunk.byteLength;
        if (received > maxBytes) {
          overflow = true;
          finish(this.sizeFailure(limitedByQuota));
          return;
        }
        if (!output.write(chunk)) {
          child.stdout.pause();
          output.once("drain", () => child.stdout.resume());
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 512) stderr += chunk.toString("utf8").slice(0, 512 - stderr.length);
      });
      output.on("error", () =>
        finish(
          new ArtifactFailure(
            artifactError("storage_unavailable", "The media staging area is unavailable"),
          ),
        ),
      );
      child.on("error", () =>
        finish(new ArtifactFailure(artifactError("not_found", "The container is unavailable"))),
      );
      child.on("close", (code) => {
        if (overflow) return;
        if (code === 0) finish(null);
        else finish(this.containerReadFailure(stderr, limitedByQuota));
      });
    });
  }

  private sizeFailure(limitedByQuota: boolean): ArtifactFailure {
    return limitedByQuota
      ? new ArtifactFailure(
          artifactError(
            "capacity_exceeded",
            "The media staging quota is exhausted; close other media and try again",
          ),
        )
      : new ArtifactFailure(
          artifactError(
            "package_size_exceeded",
            "The file is larger than the media streaming limit",
          ),
        );
  }

  /** Classifies the container reader's safe messages; never echoes paths. */
  private containerReadFailure(stderr: string, limitedByQuota: boolean): ArtifactFailure {
    if (/outside the container workspace/i.test(stderr)) {
      return new ArtifactFailure(
        artifactError("policy_denied", "The file is outside the container workspace"),
      );
    }
    if (/symbolic-link/i.test(stderr)) {
      return new ArtifactFailure(
        artifactError("policy_denied", "Symbolic links are not served as media"),
      );
    }
    if (/stable regular file/i.test(stderr)) {
      return new ArtifactFailure(artifactError("policy_denied", "Only regular files are served"));
    }
    if (/size limit/i.test(stderr)) return this.sizeFailure(limitedByQuota);
    if (/changed while it was being read/i.test(stderr)) {
      return new ArtifactFailure(
        artifactError("not_found", "The file changed while it was being prepared; try again", {
          retryClass: "transient",
        }),
      );
    }
    return new ArtifactFailure(artifactError("not_found", "The file is unavailable"));
  }

  private startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, MEDIA_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  private stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
