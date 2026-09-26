import { promises as fs } from "node:fs";
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
} from "@orkestrator/protocol/runtime-profile-status";
import { assertPrivateFile, CliConfigStore, type SavedConnection } from "./config.js";
import { CliError } from "./errors.js";

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

function isLoopbackHost(hostname: string): boolean {
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

export async function readDescriptor(file: string): Promise<BackendInstanceDescriptor> {
  let text: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error("not a file");
    if (stat.size > BACKEND_INSTANCE_DESCRIPTOR_MAX_BYTES) throw new Error("too large");
    text = await fs.readFile(file, "utf8");
  } catch {
    throw new CliError(
      "connection-failed",
      `No running backend published ${path.basename(file)} at the selected location`,
    );
  }
  try {
    return parseBackendInstanceDescriptor(JSON.parse(text));
  } catch (error) {
    throw new CliError(
      "connection-failed",
      `The backend instance descriptor is invalid: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function descriptorTarget(
  name: string,
  kind: PublicConnectionIdentity["kind"],
  descriptor: BackendInstanceDescriptor,
  expectedInstallationId: string | undefined,
  refresh: () => Promise<ResolvedTarget>,
): ResolvedTarget {
  if (!processIsAlive(descriptor.pid)) {
    throw new CliError(
      "connection-failed",
      `The backend for ${kind} '${name}' is not running (its descriptor is stale)`,
    );
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
    readToken: () => readTokenFile(descriptor.authFile, true),
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
): Promise<ResolvedTarget> {
  if (saved.kind === "descriptor") {
    const descriptor = await readDescriptor(saved.descriptorPath);
    return descriptorTarget(name, "connection", descriptor, saved.installationId, () =>
      resolveSavedConnection(name, saved),
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
  const refresh = () => resolveProfile(profileName, env);
  if (manifest.dataDir) {
    const descriptorFile = path.join(manifest.dataDir, BACKEND_INSTANCE_DESCRIPTOR_FILE);
    const descriptor = await readDescriptor(descriptorFile).catch(() => null);
    if (descriptor) {
      if (descriptor.pid !== backendPid) {
        throw new CliError(
          "profile-unavailable",
          `Profile '${located.id}' has a descriptor from a different backend process`,
        );
      }
      return descriptorTarget(located.id, "profile", descriptor, undefined, refresh);
    }
  }
  // Backends that predate the instance descriptor: the manifest's own
  // endpoint and auth file, with identity checked from capabilities only.
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
