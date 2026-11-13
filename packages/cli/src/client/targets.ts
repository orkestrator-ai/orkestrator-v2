import { constants as fsConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { isIPv4 } from "node:net";
import {
  BACKEND_INSTANCE_DESCRIPTOR_FILE,
  BACKEND_INSTANCE_DESCRIPTOR_MAX_BYTES,
  parseBackendInstanceDescriptor,
  type BackendInstanceDescriptor,
} from "@orkestrator/protocol/backend-instance";
import type { PublicConnectionIdentity } from "@orkestrator/protocol/public-api";
import {
  defaultRuntimeProfileRoots,
  parseRuntimeStatusManifest,
  runtimeProfileStatusPath,
} from "@orkestrator/protocol/node/runtime-profile-status";
import { assertPrivateFile, CliConfigStore, type SavedConnection } from "./config.js";
import { CliError } from "./errors.js";
import {
  readLinuxProcessIdentity,
  readProcessStartTime,
  type ProcessStartReader,
} from "./process-start.js";

/**
 * A concrete backend the client will talk to. Resolution is explicit:
 * `--profile` or `--connection`, otherwise the saved default. A selector that
 * cannot be resolved fails; it never falls back to another backend, and there
 * is no port scan.
 */
export interface ResolvedTarget {
  identity: PublicConnectionIdentity;
  /** Base URL of the gateway (no credentials, path, query or fragment). */
  baseUrl: string;
  /** Reads the credential fresh from its private file on every call. */
  readToken(): Promise<string>;
  /** Identity the backend must report; undefined only for legacy profiles. */
  expectedInstallationId?: string;
  /** Generation the descriptor named; a restart legitimately changes it. */
  descriptorGeneration?: string;
  /** Re-resolve after the backend reports a different generation. */
  refresh?(): Promise<ResolvedTarget>;
}

const MAX_TOKEN_FILE_BYTES = 16 * 1024;

export function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "invalid-url";
  }
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("invalid-input", "Connection URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("invalid-input", "Connection URL must use http or https");
  }
  if (url.username || url.password) {
    throw new CliError(
      "invalid-input",
      "Connection URLs must not embed credentials; use --credential-file or --token-stdin",
    );
  }
  if (url.search || url.hash) {
    throw new CliError("invalid-input", "Connection URLs must not carry a query or fragment");
  }
  if (
    url.protocol === "http:" &&
    !isLoopbackHost(url.hostname) &&
    !url.hostname.endsWith(".ts.net")
  ) {
    throw new CliError(
      "invalid-input",
      "Plain http is only accepted for loopback or Tailscale addresses; use https",
    );
  }
  return `${url.protocol}//${url.host}`;
}

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    (isIPv4(hostname) && hostname.startsWith("127."))
  );
}

/** Reads a gateway token from `{"token": "..."}` JSON or a bare-token file. */
export async function readTokenFile(file: string, requirePrivate: boolean): Promise<string> {
  if (requirePrivate) await assertPrivateFile(file, "Credential file");
  let text: string;
  try {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_TOKEN_FILE_BYTES) throw new Error("invalid");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    throw new CliError("auth-failed", "The credential file could not be read");
  }
  let token: unknown = text.trim();
  if (text.trimStart().startsWith("{")) {
    try {
      token = (JSON.parse(text) as { token?: unknown }).token;
    } catch {
      throw new CliError("auth-failed", "The credential file is malformed");
    }
  }
  if (typeof token !== "string" || token.trim().length < 16 || token.trim().length > 1024) {
    throw new CliError("auth-failed", "The credential file does not contain a valid token");
  }
  return token.trim();
}

/**
 * Why a descriptor file must not be trusted, or null when it may be. The
 * descriptor names the URL the client sends the bearer token to, so it has to
 * come from the current user's own backend: owned by that user, with no
 * permission bits for anyone else (the backend publishes it mode 0600). A
 * platform without POSIX ownership (`currentUid` undefined) skips both checks.
 */
export function descriptorTrustRefusal(
  stat: { uid: number; mode: number },
  currentUid: number | undefined,
): string | null {
  if (currentUid === undefined) return null;
  if (stat.uid !== currentUid) {
    return `it is owned by another user (uid ${stat.uid}, you are uid ${currentUid})`;
  }
  if ((stat.mode & 0o077) !== 0) {
    return `it is accessible to other users (mode ${(stat.mode & 0o777).toString(8).padStart(4, "0")}); if your own backend published it, restrict it with chmod 600`;
  }
  return null;
}

// O_NOFOLLOW refuses a symlink at the final component; O_NONBLOCK keeps a FIFO
// planted in its place from blocking the open. Both are absent on Windows.
const DESCRIPTOR_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** Marks a descriptor that exists but was refused, as opposed to one that is absent. */
const UNTRUSTED_DESCRIPTOR = "untrusted";

function refuseDescriptor(file: string, reason: string): CliError {
  return new CliError(
    "connection-failed",
    `Refusing to use the backend instance descriptor ${file}: ${reason}`,
    { details: { descriptor: UNTRUSTED_DESCRIPTOR } },
  );
}

/** True for a descriptor that was present but refused; callers must not fall back past it. */
export function isDescriptorRefusal(error: unknown): boolean {
  return error instanceof CliError && error.details?.descriptor === UNTRUSTED_DESCRIPTOR;
}

export async function readDescriptor(
  file: string,
  currentUid: number | undefined = process.getuid?.(),
): Promise<BackendInstanceDescriptor> {
  let handle: FileHandle;
  try {
    handle = await fs.open(file, DESCRIPTOR_OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw refuseDescriptor(file, "it is a symbolic link, not a regular file");
    }
    if (code !== "ENOENT") {
      throw refuseDescriptor(file, `it could not be opened (${code ?? "unknown error"})`);
    }
    throw new CliError(
      "connection-failed",
      `No running backend published ${path.basename(file)} at the selected location`,
      { details: { descriptor: "missing" } },
    );
  }
  let text: string;
  try {
    // Checked on the opened file, so a swap after the check cannot change
    // what is read.
    const stat = await handle.stat();
    if (!stat.isFile()) throw refuseDescriptor(file, "it is not a regular file");
    const refusal = descriptorTrustRefusal(stat, currentUid);
    if (refusal) throw refuseDescriptor(file, refusal);
    if (stat.size > BACKEND_INSTANCE_DESCRIPTOR_MAX_BYTES) {
      throw refuseDescriptor(file, "it is too large");
    }
    text = await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw refuseDescriptor(file, "its metadata or contents could not be read");
  } finally {
    await handle.close();
  }
  try {
    return parseBackendInstanceDescriptor(JSON.parse(text));
  } catch {
    throw refuseDescriptor(file, "its contents are invalid");
  }
}

/**
 * Whether `pid` is a live process this user can signal. `EPERM` means the pid
 * now belongs to another user, so it is not our backend: counting it as alive
 * would let a stale descriptor send the token to whoever took over its port.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * How far the descriptor's pid may have started before its `startedAt`. The
 * backend writes `startedAt` once it is serving, after opening its store and
 * starting its listeners, so the process legitimately predates it by however
 * long that boot took. A pid reused after the backend exited can only have
 * started later, so this bound costs nothing against reuse; it refuses a pid
 * that names some much older process instead (a descriptor written in another
 * pid namespace, for instance).
 */
export const DESCRIPTOR_START_BEFORE_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * How far the pid's process may appear to have started after `startedAt`.
 * A genuine backend started before writing it, so this only absorbs
 * measurement: `/proc/stat`'s boot time and `ps -o lstart` both have
 * one-second resolution, and a small wall-clock correction between the write
 * and the check shifts one reading against the other. A reused pid would have
 * to belong to a process started within this window after the backend wrote
 * its descriptor, which needs the backend to die and the pid space to wrap in
 * that time.
 */
export const DESCRIPTOR_START_AFTER_TOLERANCE_MS = 30 * 1000;

/**
 * Why the process holding `descriptor.pid` is not the backend that wrote the
 * descriptor, or null when it is; the reason completes "The backend …".
 * Checked before any token is read or sent: a stale descriptor whose pid now
 * belongs to another process of this user would otherwise send the token to
 * whoever took over the old port. A start time that cannot be read is refused
 * rather than trusted, since nothing then ties the pid to the backend.
 */
export async function descriptorProcessRefusal(
  descriptor: Pick<BackendInstanceDescriptor, "pid" | "startedAt" | "processIdentity">,
  readStart: ProcessStartReader = readProcessStartTime,
  alive: (pid: number) => boolean = processIsAlive,
): Promise<string | null> {
  if (!alive(descriptor.pid)) return "is not running as your user (its descriptor is stale)";
  if (process.platform === "linux" && readStart === readProcessStartTime) {
    if (!descriptor.processIdentity) {
      return "cannot be confirmed: restart an upgraded backend to publish its Linux process identity";
    }
    const identity = await readLinuxProcessIdentity(descriptor.pid);
    if (identity === null)
      return "cannot be confirmed: its Linux process identity could not be read";
    return identity === descriptor.processIdentity
      ? null
      : "is not running: its process identity changed (its descriptor is stale)";
  }
  const startedAt = Date.parse(descriptor.startedAt);
  if (!Number.isFinite(startedAt)) {
    return "cannot be confirmed: its descriptor has no valid start time";
  }
  const actual = await readStart(descriptor.pid);
  if (actual === null) {
    return `cannot be confirmed: the start time of process ${descriptor.pid} could not be read`;
  }
  if (
    actual > startedAt + DESCRIPTOR_START_AFTER_TOLERANCE_MS ||
    actual < startedAt - DESCRIPTOR_START_BEFORE_TOLERANCE_MS
  ) {
    return `is not running: pid ${descriptor.pid} belongs to a process started at ${new Date(actual).toISOString()}, but the backend started at ${new Date(startedAt).toISOString()} (its descriptor is stale)`;
  }
  return null;
}

async function descriptorTarget(
  name: string,
  kind: PublicConnectionIdentity["kind"],
  descriptor: BackendInstanceDescriptor,
  expectedInstallationId: string | undefined,
  refresh: () => Promise<ResolvedTarget>,
  readStart: ProcessStartReader,
): Promise<ResolvedTarget> {
  const refusal = await descriptorProcessRefusal(descriptor, readStart);
  if (refusal) {
    throw new CliError("connection-failed", `The backend for ${kind} '${name}' ${refusal}`);
  }
  if (expectedInstallationId && descriptor.installationId !== expectedInstallationId) {
    throw new CliError(
      "identity-mismatch",
      `The backend at ${kind} '${name}' is a different installation than the one saved`,
      { details: { expected: expectedInstallationId, actual: descriptor.installationId } },
    );
  }
  const baseUrl = normalizeBaseUrl(descriptor.url);
  return {
    identity: {
      name,
      kind,
      endpoint: redactEndpoint(baseUrl),
      installationId: descriptor.installationId,
      generation: descriptor.generation,
    },
    baseUrl,
    // The service's own auth file is created mode 0600 by the backend.
    readToken: async () => {
      const refusal = await descriptorProcessRefusal(descriptor, readStart);
      if (refusal)
        throw new CliError("connection-failed", `The backend for ${kind} '${name}' ${refusal}`);
      return readTokenFile(descriptor.authFile, true);
    },
    expectedInstallationId: descriptor.installationId,
    descriptorGeneration: descriptor.generation,
    refresh,
  };
}

export interface TargetSelection {
  connection?: string;
  profile?: string;
}

export async function resolveTarget(
  selection: TargetSelection,
  store: CliConfigStore,
  env: Record<string, string | undefined>,
): Promise<ResolvedTarget> {
  if (selection.profile !== undefined) return resolveProfile(selection.profile, env);
  const config = await store.read();
  const name = selection.connection ?? config.defaultConnection;
  if (!name) {
    throw new CliError(
      "connection-not-configured",
      "No backend selected. Pass --profile NAME or --connection NAME, or save a default with `orkestrator connection default NAME`.",
    );
  }
  const saved = config.connections[name];
  if (!saved) {
    throw new CliError("connection-not-configured", `No saved connection named '${name}'`);
  }
  return resolveSavedConnection(name, saved);
}

export async function resolveSavedConnection(
  name: string,
  saved: SavedConnection,
  readStart: ProcessStartReader = readProcessStartTime,
): Promise<ResolvedTarget> {
  if (saved.kind === "descriptor") {
    const descriptor = await readDescriptor(saved.descriptorPath);
    return descriptorTarget(
      name,
      "connection",
      descriptor,
      saved.installationId,
      () => resolveSavedConnection(name, saved, readStart),
      readStart,
    );
  }
  const baseUrl = normalizeBaseUrl(saved.url);
  return {
    identity: {
      name,
      kind: "connection",
      endpoint: redactEndpoint(baseUrl),
      ...(saved.installationId ? { installationId: saved.installationId } : {}),
    },
    baseUrl,
    readToken: () => readTokenFile(saved.credentialFile, true),
    ...(saved.installationId ? { expectedInstallationId: saved.installationId } : {}),
  };
}

/**
 * Resolve a running isolated development profile through the same status
 * manifest `dev:status` reads. The profile must be `ready` with a live backend.
 */
export async function resolveProfile(
  profileName: string,
  env: Record<string, string | undefined>,
  readStart: ProcessStartReader = readProcessStartTime,
): Promise<ResolvedTarget> {
  let located: ReturnType<typeof runtimeProfileStatusPath>;
  try {
    const developmentRoot =
      env.ORKESTRATOR_DEV_ROOT ?? defaultRuntimeProfileRoots(process.platform, env).developmentRoot;
    located = runtimeProfileStatusPath(developmentRoot, profileName);
  } catch (error) {
    throw new CliError("invalid-input", error instanceof Error ? error.message : "Invalid profile");
  }
  let manifest: ReturnType<typeof parseRuntimeStatusManifest>;
  try {
    const stat = await fs.lstat(located.statusPath);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("invalid");
    manifest = parseRuntimeStatusManifest(
      JSON.parse(await fs.readFile(located.statusPath, "utf8")),
    );
  } catch {
    throw new CliError(
      "profile-unavailable",
      `Profile '${located.id}' is not running; start it with \`mise run dev:test --profile ${located.id}\``,
    );
  }
  if (manifest.status !== "ready") {
    throw new CliError(
      "profile-unavailable",
      `Profile '${located.id}' is ${manifest.status}, not ready`,
    );
  }
  const backendPid = manifest.pids.backend;
  if (!backendPid || !processIsAlive(backendPid)) {
    throw new CliError(
      "profile-unavailable",
      `Profile '${located.id}' reports ready but its backend is not running (stale status)`,
    );
  }
  const refresh = () => resolveProfile(profileName, env, readStart);
  if (manifest.dataDir) {
    const descriptorFile = path.join(manifest.dataDir, BACKEND_INSTANCE_DESCRIPTOR_FILE);
    // A missing descriptor means its backend could not publish one (below); a
    // refused one must stop here rather than fall back to the manifest's endpoint.
    const descriptor = await readDescriptor(descriptorFile).catch((error: unknown) => {
      if (error instanceof CliError && error.details?.descriptor === "missing") return null;
      throw error;
    });
    if (descriptor) {
      if (descriptor.pid !== backendPid) {
        throw new CliError(
          "profile-unavailable",
          `Profile '${located.id}' has a descriptor from a different backend process`,
        );
      }
      return descriptorTarget(located.id, "profile", descriptor, undefined, refresh, readStart);
    }
  }
  // A ready profile without a descriptor: the manifest's own endpoint and auth
  // file, with identity checked from capabilities only. Kept although every
  // backend from v2.21.0 on writes the descriptor before its ready line
  // (`apps/backend/src/main.ts`): the write is best effort there. A failed
  // capabilities read or file write is only logged, and the backend still
  // serves and reports ready, so dev:test can mark the profile ready with no
  // descriptor on disk.
  if (!manifest.browserUrl || !manifest.authFile) {
    throw new CliError(
      "profile-unavailable",
      `Profile '${located.id}' does not publish a gateway endpoint`,
    );
  }
  const baseUrl = normalizeBaseUrl(manifest.browserUrl);
  const authFile = manifest.authFile;
  return {
    identity: { name: located.id, kind: "profile", endpoint: redactEndpoint(baseUrl) },
    baseUrl,
    readToken: () => readTokenFile(authFile, true),
    refresh,
  };
}
