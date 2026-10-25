import {
  assertWorktreePathUnlinked,
  captureWorktreePathIdentity,
} from "@orkestrator/protocol/node/worktree-paths";
import {
  STORAGE_DATABASE_FILE,
  readStorageDatabaseStore,
} from "@orkestrator/protocol/node/storage-database";
import { restrictGrokAuthSnapshot } from "@orkestrator/protocol/login-snapshots";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  DEV_PROFILE_FORMAT_VERSION,
  DEV_PROFILE_SENTINEL,
  DEV_WORKTREES_SENTINEL,
  assertSafeProfileResetTarget,
  isExternalWorktreeDir,
  defaultRuntimeProfileRoots,
  parseRuntimeProfile,
  parseRuntimeStatusManifest,
  type RuntimeProcessName,
  type RuntimeProfile,
  type RuntimeProfileRoots,
  type RuntimeStatusManifest,
} from "../../electron/runtime-profile.js";
import { pinnedArtifactDirectory } from "@orkestrator/toolchain/manager";
import {
  isSupportToolName,
  pinnedToolchainArtifacts,
  type ToolchainArtifact,
} from "@orkestrator/toolchain/manifest";

const MAX_MODEL_CACHE_BYTES = 16 * 1024 * 1024;
const MODEL_CACHE_COPY_CHUNK_BYTES = 64 * 1024;

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temporary, filePath);
    await chmod(filePath, mode);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function initializeProfile(profile: RuntimeProfile): Promise<string> {
  parseRuntimeProfile(profile);
  assertWorktreePathUnlinked(profile.profileRoot);
  assertWorktreePathUnlinked(profile.worktreeDir);
  const recheckProfile = captureWorktreePathIdentity(profile.profileRoot);
  const recheckWorktrees = captureWorktreePathIdentity(profile.worktreeDir);
  if (isExternalWorktreeDir(profile)) {
    await mkdir(path.dirname(profile.worktreeDir), { recursive: true, mode: 0o700 });
    assertWorktreePathUnlinked(profile.worktreeDir);
    let created = false;
    try {
      await mkdir(profile.worktreeDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      await writeFile(
        path.join(profile.worktreeDir, DEV_WORKTREES_SENTINEL),
        JSON.stringify({ version: DEV_PROFILE_FORMAT_VERSION, profile: profile.id }),
        { mode: 0o600, flag: "wx" },
      );
    }
    await assertExternalWorktreeOwnership(profile);
  }
  for (const directory of [
    profile.profileRoot,
    profile.dataDir,
    profile.runtimeDir,
    profile.worktreeDir,
    profile.logDir,
    profile.fixtureDir,
  ]) {
    recheckProfile();
    recheckWorktrees();
    assertWorktreePathUnlinked(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    assertWorktreePathUnlinked(directory);
    await chmod(directory, 0o700);
  }
  recheckProfile();
  recheckWorktrees();
  const profilePath = path.join(profile.profileRoot, "profile.json");
  await atomicWriteJson(profilePath, profile);
  await atomicWriteJson(path.join(profile.profileRoot, DEV_PROFILE_SENTINEL), {
    version: DEV_PROFILE_FORMAT_VERSION,
    profile: profile.id,
  });
  return profilePath;
}

/**
 * Deletes a worktree folder kept outside the profile, only while its
 * sentinel still names this profile: the folder sits in a location the user
 * chose, so anything not provably ours is left alone.
 */
export async function assertExternalWorktreeOwnership(profile: RuntimeProfile): Promise<void> {
  assertWorktreePathUnlinked(profile.profileRoot);
  assertWorktreePathUnlinked(profile.worktreeDir);
  if (!isExternalWorktreeDir(profile)) return;
  const stats = await lstat(profile.worktreeDir).catch(() => null);
  const marker = path.join(profile.worktreeDir, DEV_WORKTREES_SENTINEL);
  const markerStats = await lstat(marker).catch(() => null);
  const sentinel = await readFile(marker, "utf8")
    .then((text) => JSON.parse(text) as { version?: unknown; profile?: unknown })
    .catch(() => null);
  if (
    !stats?.isDirectory() ||
    !markerStats?.isFile() ||
    sentinel?.version !== DEV_PROFILE_FORMAT_VERSION ||
    sentinel.profile !== profile.id
  ) {
    throw new Error("External worktree sentinel is missing or does not match the selected profile");
  }
}

async function removeExternalWorktreeDir(profile: RuntimeProfile): Promise<void> {
  const recheck = captureWorktreePathIdentity(profile.worktreeDir);
  await assertExternalWorktreeOwnership(profile);
  recheck();
  if (isExternalWorktreeDir(profile))
    await rm(profile.worktreeDir, { recursive: true, force: true });
}

/**
 * Delete disposable profile state without ever following directory symlinks.
 * Kept as one tested production helper so both reset modes retain that safety
 * property when provider-owned credential paths are added or changed.
 */
export async function removeProfileState(
  profile: RuntimeProfile,
  keepToolchains: boolean,
): Promise<void> {
  const recheckProfile = captureWorktreePathIdentity(profile.profileRoot);
  await removeExternalWorktreeDir(profile);
  recheckProfile();
  if (!keepToolchains) {
    await rm(profile.profileRoot, { recursive: true, force: true });
    return;
  }
  for (const child of await readdir(profile.profileRoot)) {
    if (child === "profile.json" || child === ".orkestrator-dev-profile") continue;
    if (child === "data") {
      for (const dataChild of await readdir(profile.dataDir).catch(() => [])) {
        if (dataChild !== "toolchains") {
          await rm(path.join(profile.dataDir, dataChild), { recursive: true, force: true });
        }
      }
    } else {
      await rm(path.join(profile.profileRoot, child), { recursive: true, force: true });
    }
  }
}

type ModelCacheSeedOptions = {
  roots?: RuntimeProfileRoots;
  env?: NodeJS.ProcessEnv;
  afterSourceValidation?: (label: string) => void | Promise<void>;
};

type BoundedSeedCandidate = {
  label: string;
  source: string;
  destination: string;
  replace?: boolean;
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isSameFile(initial: Stats, current: Stats): boolean {
  return (
    current.isFile() &&
    current.dev === initial.dev &&
    current.ino === initial.ino &&
    current.size === initial.size &&
    current.mtimeMs === initial.mtimeMs &&
    current.ctimeMs === initial.ctimeMs
  );
}

async function seedBoundedFiles(
  candidates: readonly BoundedSeedCandidate[],
  options: ModelCacheSeedOptions,
  onFailure?: () => void,
): Promise<string[]> {
  const copied: string[] = [];
  for (const candidate of candidates) {
    let temporary: string | undefined;
    let sourceHandle: FileHandle | undefined;
    let temporaryHandle: FileHandle | undefined;
    try {
      if (!candidate.replace && (await pathExists(candidate.destination))) continue;
      sourceHandle = await open(candidate.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const initialSourceInfo = await sourceHandle.stat();
      if (!initialSourceInfo.isFile() || initialSourceInfo.size > MAX_MODEL_CACHE_BYTES)
        throw new Error("Seed source is not a bounded regular file");
      await options.afterSourceValidation?.(candidate.label);

      await mkdir(path.dirname(candidate.destination), { recursive: true, mode: 0o700 });
      temporary = `${candidate.destination}.${process.pid}.${Date.now()}.tmp`;
      temporaryHandle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );

      let totalBytes = 0;
      while (totalBytes <= MAX_MODEL_CACHE_BYTES) {
        const remaining = MAX_MODEL_CACHE_BYTES + 1 - totalBytes;
        const chunk = Buffer.allocUnsafe(Math.min(MODEL_CACHE_COPY_CHUNK_BYTES, remaining));
        const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        totalBytes += bytesRead;
        if (totalBytes > MAX_MODEL_CACHE_BYTES)
          throw new Error("Seed source exceeds the size limit");

        let written = 0;
        while (written < bytesRead) {
          const result = await temporaryHandle.write(chunk, written, bytesRead - written);
          if (result.bytesWritten === 0) throw new Error("Seed write made no progress");
          written += result.bytesWritten;
        }
      }

      const [finalSourceInfo, currentSourceInfo] = await Promise.all([
        sourceHandle.stat(),
        lstat(candidate.source),
      ]);
      if (
        !isSameFile(initialSourceInfo, finalSourceInfo) ||
        !currentSourceInfo.isFile() ||
        currentSourceInfo.dev !== initialSourceInfo.dev ||
        currentSourceInfo.ino !== initialSourceInfo.ino
      ) {
        throw new Error("Seed source changed while it was being copied");
      }

      await temporaryHandle.chmod(0o600);
      await temporaryHandle.close();
      temporaryHandle = undefined;
      if (candidate.replace) {
        await rename(temporary, candidate.destination);
        temporary = undefined;
      } else {
        await link(temporary, candidate.destination);
      }
      copied.push(candidate.label);
    } catch (error) {
      if (sourceHandle || (error as NodeJS.ErrnoException).code !== "ENOENT") onFailure?.();
      // Provider state is an optional convenience, never a startup dependency.
    } finally {
      await sourceHandle?.close().catch(() => undefined);
      await temporaryHandle?.close().catch(() => undefined);
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  return copied;
}

/**
 * Seed model metadata into an isolated agent-test profile without copying
 * credentials, sessions, prompts, projects, or application configuration.
 * Existing profile caches always win so a restart cannot discard live data.
 * Invalid seeds remain harmless because their normal consumers validate them.
 */
export async function seedInstalledModelCatalogCaches(
  profile: RuntimeProfile,
  options: ModelCacheSeedOptions = {},
): Promise<string[]> {
  const roots = options.roots ?? defaultRuntimeProfileRoots();
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME?.trim() || path.join(roots.homeDir, ".codex");
  const isolatedCodexHome = path.join(profile.dataDir, "agent-credentials", "codex");
  const isolatedHome = path.join(profile.dataDir, "agent-credentials", "home");
  // The backend keeps these catalogues in its database. A profile that already
  // has one owns its catalogues; a new one imports the seeded JSON on first
  // start, exactly like a data directory upgraded from the JSON stores.
  const profileHasDatabase = await pathExists(path.join(profile.dataDir, STORAGE_DATABASE_FILE));
  const exported = profileHasDatabase
    ? null
    : await exportDatabaseCatalogues(roots.productionDataDir);
  const catalogues = profileHasDatabase
    ? []
    : ["agent-model-catalog.json", "opencode-model-catalog.json"].map((label) => ({
        label,
        source: exported?.files.get(label) ?? path.join(roots.productionDataDir, label),
        destination: path.join(profile.dataDir, label),
      }));
  const candidates = [
    ...catalogues,
    {
      label: "codex/models_cache.json",
      source: path.join(codexHome, "models_cache.json"),
      destination: path.join(isolatedCodexHome, "models_cache.json"),
    },
    {
      label: "codex/orkestrator-bridge/models-cache.json",
      source: path.join(codexHome, "orkestrator-bridge", "models-cache.json"),
      destination: path.join(isolatedCodexHome, "orkestrator-bridge", "models-cache.json"),
    },
    {
      label: "grok/models_cache.json",
      source: path.join(roots.homeDir, ".grok", "models_cache.json"),
      destination: path.join(isolatedHome, ".grok", "models_cache.json"),
    },
  ];
  try {
    return await seedBoundedFiles(candidates, options);
  } finally {
    if (exported) await rm(exported.directory, { recursive: true, force: true });
  }
}

/**
 * Writes the production database's model catalogues to private temporary JSON
 * files, read-only and without running the backend's migrations. A production
 * directory the backend has not opened since the SQLite move has no database;
 * its JSON files are then used directly.
 */
async function exportDatabaseCatalogues(
  productionDataDir: string,
): Promise<{ directory: string; files: Map<string, string> } | null> {
  const stores = [
    ["agent-model-catalog.json", "agent-model-catalog"],
    ["opencode-model-catalog.json", "opencode-model-catalog"],
  ] as const;
  const values = stores
    .map(([label, store]) => [label, readStorageDatabaseStore(productionDataDir, store)] as const)
    .filter(([, value]) => value !== undefined);
  if (values.length === 0) return null;
  const directory = await mkdtemp(path.join(os.tmpdir(), "ork-catalogue-seed-"));
  await chmod(directory, 0o700);
  const files = new Map<string, string>();
  for (const [label, value] of values) {
    const file = path.join(directory, label);
    await writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    files.set(label, file);
  }
  return { directory, files };
}

export type ToolchainSeedOptions = {
  roots?: RuntimeProfileRoots;
  /** Defaults to the pinned manifest; narrowed by tests. */
  artifacts?: readonly ToolchainArtifact[];
  platform?: NodeJS.Platform;
  architecture?: string;
  /** Defaults to `console.warn`; a path-free line, never the copy's paths. */
  warn?: (message: string) => void;
};

export type ToolchainSeedResult = {
  /** `name@version` for each artifact copied from the host installation. */
  seeded: string[];
  /**
   * Artifacts whose copy failed for a reason other than "the host has not
   * installed this".
   *
   * Reported separately because the two are indistinguishable in the outcome —
   * both fall through to the installer's download — but not in what they mean. A
   * bare host is the expected case; a permission error, a full disk, or a layout
   * change that makes the source path wrong is a seeder that has silently
   * stopped working, and its only other symptom is a startup that is minutes
   * slower than it should be.
   */
  failed: string[];
};

/**
 * Pre-populate an isolated profile's managed toolchain from the host install.
 *
 * Without this, `dev:test` would download every pinned toolchain again for each
 * profile — hundreds of megabytes of identical, hash-pinned bytes. The copy is
 * one-way and read-only with respect to the host: nothing is written back, no
 * install lock is taken there, and the production activation directory is never
 * touched. Anything missing or damaged simply falls through to the installer's
 * normal download, because it re-verifies every artifact against the manifest
 * before activating it.
 *
 * A profile that already has the artifact is left alone, so a restart cannot
 * disturb a toolchain a running backend resolved through.
 */
export async function seedInstalledAgentToolchains(
  profile: RuntimeProfile,
  options: ToolchainSeedOptions = {},
): Promise<ToolchainSeedResult> {
  if (profile.agentPlatforms.length === 0) return { seeded: [], failed: [] };
  const roots = options.roots ?? defaultRuntimeProfileRoots();
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const selected = new Set<string>(profile.agentPlatforms);
  const artifacts = (options.artifacts ?? pinnedToolchainArtifacts()).filter(
    (artifact) =>
      (selected.has(artifact.name) || isSupportToolName(artifact.name)) &&
      artifact.platform === platform &&
      artifact.architecture === architecture,
  );

  const warn = options.warn ?? ((message: string) => console.warn(message));
  const seeded: string[] = [];
  const failed: string[] = [];
  for (const artifact of artifacts) {
    const label = `${artifact.name}@${artifact.version}`;
    const source = pinnedArtifactDirectory(roots.productionDataDir, artifact);
    const destination = pinnedArtifactDirectory(profile.dataDir, artifact);
    // Staged beside the destination and renamed, so an interrupted copy cannot
    // leave a partial tree where the installer expects a complete one.
    const staging = `${destination}.${process.pid}.${Date.now()}.seed`;
    try {
      if (await pathExists(destination)) continue;
      const sourceInfo = await lstat(source);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) continue;
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await cp(source, staging, {
        recursive: true,
        preserveTimestamps: true,
        // Never follow a link out of the host toolchain tree, and never carry
        // one into the profile.
        dereference: false,
        verbatimSymlinks: true,
        // Finder droppings are not in the manifest, and Cursor's bundle is
        // verified by an aggregate digest over the whole tree — one stray file
        // would fail that check and force the download this exists to avoid.
        filter: (candidate) => path.basename(candidate) !== ".DS_Store",
      });
      await rename(staging, destination);
      seeded.push(label);
    } catch (error) {
      // Either way the installer downloads it — seeding is an optimization,
      // never a dependency — but only one of the two is expected.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        failed.push(label);
        warn(
          `Could not seed ${label} from the host install (${
            (error as NodeJS.ErrnoException).code ?? "unknown error"
          }); it will be downloaded instead.`,
        );
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { seeded, failed };
}

/** An access token this close to expiry is not worth handing over. */
const PROVIDER_SNAPSHOT_MIN_VALIDITY_MS = 60_000;

/**
 * Shared with the container imports: each login's access token, with its
 * refresh token blanked, and expired logins dropped. See
 * `packages/protocol/src/login-snapshots.ts` for why a copy may never refresh.
 */
export { restrictGrokAuthSnapshot };

/** Never a real OAuth refresh token; see `restrictCodexAuthSnapshot`. */
export const CODEX_SNAPSHOT_REFRESH_TOKEN_PREFIX = "orkestrator-agent-test-snapshot-no-refresh-";

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** A JWT's `exp` in milliseconds, or undefined for an opaque token. */
function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    ).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reduce a copy of the host's Codex `auth.json` to what an isolated profile
 * may hold: an API key, or the ChatGPT login's access and id tokens with a
 * placeholder in place of the refresh token.
 *
 * ChatGPT refresh tokens rotate: a profile that refreshed with the host's
 * token would retire it and sign the host's own Codex out. The placeholder is
 * non-empty because the Codex bridge treats a login without a refresh token
 * or key as no login, and is derived from the access token so a new snapshot
 * is a new login identity. `last_refresh` is the copy's time so Codex does
 * not try its interval refresh; a refresh it still attempts (after a 401)
 * fails on the placeholder and signs only the profile out. An access token
 * that has expired, or nearly, is withheld rather than copied.
 */
export function restrictCodexAuthSnapshot(
  text: string,
  nowMs = Date.now(),
): { text: string } | { withheld: string } {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = jsonRecord(JSON.parse(text));
  } catch {
    return { withheld: "the host Codex auth.json is not valid JSON" };
  }
  if (!parsed) return { withheld: "the host Codex auth.json has an unknown shape" };
  const apiKey = nonBlank(parsed.OPENAI_API_KEY);
  const tokens = jsonRecord(parsed.tokens);
  const accessToken = nonBlank(tokens?.access_token);
  if (accessToken) {
    const expiresAt = jwtExpiryMs(accessToken);
    if (expiresAt !== undefined && expiresAt - nowMs < PROVIDER_SNAPSHOT_MIN_VALIDITY_MS) {
      if (apiKey) return { text: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey }) };
      return {
        withheld:
          "the host Codex login has expired and the profile may not refresh it; run codex on the host (codex login if it is signed out there), then restart the profile",
      };
    }
    const placeholder = `${CODEX_SNAPSHOT_REFRESH_TOKEN_PREFIX}${createHash("sha256")
      .update(accessToken)
      .digest("hex")
      .slice(0, 16)}`;
    return {
      text: JSON.stringify({
        ...(typeof parsed.auth_mode === "string" ? { auth_mode: parsed.auth_mode } : {}),
        OPENAI_API_KEY: apiKey ?? null,
        tokens: {
          ...(nonBlank(tokens?.id_token) ? { id_token: tokens?.id_token } : {}),
          access_token: accessToken,
          refresh_token: placeholder,
          ...(nonBlank(tokens?.account_id) ? { account_id: tokens?.account_id } : {}),
        },
        last_refresh: new Date(nowMs).toISOString(),
      }),
    };
  }
  if (apiKey) return { text: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey }) };
  return { withheld: "the host Codex auth.json has no API key or ChatGPT access token" };
}

/**
 * Reduce a copy of the host's OpenCode `auth.json` to what an isolated profile
 * may hold: API keys and well-known tokens as they are, and each OAuth login's
 * access token with its refresh token blanked, for the same reason as Codex
 * and Grok. Expired OAuth logins and unknown entry types are dropped.
 */
export function restrictOpenCodeAuthSnapshot(
  text: string,
  nowMs = Date.now(),
): { text: string } | { withheld: string } {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = jsonRecord(JSON.parse(text));
  } catch {
    return { withheld: "the host OpenCode auth.json is not valid JSON" };
  }
  if (!parsed) return { withheld: "the host OpenCode auth.json has an unknown shape" };
  const kept: Record<string, unknown> = {};
  for (const [provider, value] of Object.entries(parsed)) {
    const entry = jsonRecord(value);
    if (entry?.type === "api" && nonBlank(entry.key)) {
      kept[provider] = { type: "api", key: entry.key };
    } else if (entry?.type === "wellknown" && nonBlank(entry.key) && nonBlank(entry.token)) {
      kept[provider] = { type: "wellknown", key: entry.key, token: entry.token };
    } else if (
      entry?.type === "oauth" &&
      nonBlank(entry.access) &&
      typeof entry.expires === "number" &&
      entry.expires - nowMs >= PROVIDER_SNAPSHOT_MIN_VALIDITY_MS
    ) {
      kept[provider] = {
        type: "oauth",
        access: entry.access,
        expires: entry.expires,
        refresh: "",
        ...(nonBlank(entry.accountId) ? { accountId: entry.accountId } : {}),
        ...(nonBlank(entry.enterpriseUrl) ? { enterpriseUrl: entry.enterpriseUrl } : {}),
      };
    }
  }
  if (Object.keys(kept).length === 0) {
    return {
      withheld:
        "the host OpenCode auth.json has no API key or unexpired login the profile may use; run opencode auth login on the host, then restart the profile",
    };
  }
  return { text: JSON.stringify(kept) };
}

type RestrictedCredentialSeed = {
  /** Display name in warnings, for example `Codex`. */
  provider: string;
  label: string;
  authorized: boolean;
  source: string;
  destination: string;
  restrict: (text: string, nowMs?: number) => { text: string } | { withheld: string };
  /**
   * `always` removes the destination whenever no snapshot was published.
   * `seeded` revokes only credentials whose digests match the ownership marker.
   * OpenCode entries are tracked individually to preserve profile-owned providers.
   */
  revoke: "always" | "seeded";
};

/** Stable across provider rewrites that only reorder JSON object keys. */
function credentialDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    const record = jsonRecord(item);
    return record
      ? Object.fromEntries(
          Object.keys(record)
            .sort()
            .map((key) => [key, canonical(record[key])]),
        )
      : item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Missing files are expected; unreadable ownership or credentials are not. */
async function readCredentialFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Remove only credentials still owned by a previous host snapshot. Return any
 * profile-owned contents for merging on an authorized refresh. Failure must
 * stop startup, since a readable stale credential could otherwise be loaded.
 */
async function revokeRestrictedCredential(
  seed: RestrictedCredentialSeed,
): Promise<string | undefined> {
  const marker = `${seed.destination}.orkestrator-host-snapshot`;
  try {
    if (seed.revoke === "always") {
      await rm(seed.destination, { force: true });
      return undefined;
    }
    const ownership = await readCredentialFile(marker);
    const current = await readCredentialFile(seed.destination);
    if (ownership !== undefined) {
      const recorded = jsonRecord(JSON.parse(ownership));
      if (recorded?.version !== 1 || typeof recorded.digest !== "string")
        throw new Error("Unknown credential ownership");
      if (current !== undefined) {
        // Invalid JSON cannot equal a published snapshot; it belongs to the profile.
        let parsed: unknown;
        try {
          parsed = JSON.parse(current);
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined && credentialDigest(parsed) === recorded.digest) {
          await rm(seed.destination, { force: true });
        } else if (
          seed.provider === "OpenCode" &&
          jsonRecord(parsed) &&
          jsonRecord(recorded.entries)
        ) {
          const remaining = { ...jsonRecord(parsed) };
          let changed = false;
          for (const [provider, digest] of Object.entries(jsonRecord(recorded.entries)!)) {
            if (
              Object.hasOwn(remaining, provider) &&
              credentialDigest(remaining[provider]) === digest
            ) {
              delete remaining[provider];
              changed = true;
            }
          }
          if (Object.keys(remaining).length === 0) await rm(seed.destination, { force: true });
          else {
            if (changed) await atomicWriteJson(seed.destination, remaining);
            await rm(marker, { force: true });
            return JSON.stringify(remaining);
          }
        } else {
          await rm(marker, { force: true });
          return current;
        }
      }
      await rm(marker, { force: true });
      return undefined;
    }
    return current;
  } catch {
    throw new Error(
      `Could not revoke previous ${seed.provider} host credentials; reset the profile before startup.`,
    );
  }
}

/** Publish owner-only snapshots; optional copy failures never expose raw errors. */
async function seedRestrictedCredential(
  seed: RestrictedCredentialSeed,
  options: ModelCacheSeedOptions & { warn?: (message: string) => void; nowMs?: number },
): Promise<boolean> {
  const { provider, destination } = seed;
  const marker = `${destination}.orkestrator-host-snapshot`;
  // The host copy lands beside the destination, where the provider never
  // reads, and only its restricted form is published under the name it loads.
  const hostCopy = `${destination}.host-copy`;
  const profileOwned = await revokeRestrictedCredential(seed);
  let withheld: string | undefined;
  const copied =
    seed.authorized && !(profileOwned !== undefined && provider === "Codex")
      ? (
          await seedBoundedFiles(
            [{ label: seed.label, source: seed.source, destination: hostCopy, replace: true }],
            options,
            () => {
              withheld = `the authorized host ${provider} auth.json could not be copied`;
            },
          )
        ).length > 0
      : false;
  let published = false;
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  if (copied) {
    const restricted = await readFile(hostCopy, "utf8")
      .then((text) => seed.restrict(text, options.nowMs))
      .catch(() => ({ withheld: `the host ${provider} auth.json could not be read back` }));
    if ("text" in restricted) {
      try {
        published = await (async () => {
          let snapshot = JSON.parse(restricted.text) as Record<string, unknown>;
          if (profileOwned !== undefined) {
            // Codex has one login. OpenCode has independently owned provider entries.
            if (provider !== "OpenCode") return false;
            const own = jsonRecord(JSON.parse(profileOwned));
            if (!own) return false;
            snapshot = Object.fromEntries(
              Object.entries(snapshot).filter(([key]) => !Object.hasOwn(own, key)),
            );
            if (Object.keys(snapshot).length === 0) return false;
          }
          if (seed.revoke === "seeded") {
            await atomicWriteJson(marker, {
              version: 1,
              digest: credentialDigest(snapshot),
              ...(provider === "OpenCode"
                ? {
                    entries: Object.fromEntries(
                      Object.entries(snapshot).map(([key, value]) => [
                        key,
                        credentialDigest(value),
                      ]),
                    ),
                  }
                : {}),
            });
            snapshot = { ...snapshot, ...(profileOwned ? JSON.parse(profileOwned) : {}) };
          }
          await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
          await rename(temporary, destination);
          return true;
        })();
      } catch {
        withheld = `the restricted ${provider} snapshot could not be published`;
      } finally {
        await rm(temporary, { force: true }).catch(() => {
          withheld ??= `the temporary ${provider} snapshot could not be removed`;
        });
      }
    } else {
      withheld = restricted.withheld;
    }
  }
  await rm(hostCopy, { force: true }).catch(() => {
    withheld ??= `the host ${provider} snapshot copy could not be removed`;
  });
  if (withheld) published = false;
  if (!published) await revokeRestrictedCredential(seed);
  if (withheld)
    options.warn?.(`Could not seed ${provider} credentials in this profile: ${withheld}.`);
  return published;
}

/**
 * Copy the provider logins an isolated profile may use, re-read on every
 * start so a refreshed or removed host login wins. Each is reduced so that
 * no refresh token reaches the profile, and the profile's provider homes stay
 * its own: nothing the profile does, a Codex trust grant or an MCP editor save
 * included, writes to the host's provider directories.
 *
 * Grok has no documented home-directory override, so its credential is copied
 * into the profile's isolated HOME, reduced by `restrictGrokAuthSnapshot`.
 * Codex and OpenCode get their one credential file in the profile's own
 * `CODEX_HOME` and `XDG_DATA_HOME` (`restrictCodexAuthSnapshot`,
 * `restrictOpenCodeAuthSnapshot`); their config, sessions and MCP servers stay
 * the profile's.
 *
 * Cursor's login is Orkestrator's own, in the production data directory: the
 * stored key in `config.json`, else the key minted by the in-app sign-in. Only
 * the effective key is written, owner-only, to a harness-owned file the backend
 * reads in place of an inherited `CURSOR_API_KEY`. The file is removed when the
 * profile does not authorize Cursor or the host has no usable key.
 */
export async function seedAgentTestProviderCredentials(
  profile: RuntimeProfile,
  options: ModelCacheSeedOptions & { warn?: (message: string) => void; nowMs?: number } = {},
): Promise<string[]> {
  const roots = options.roots ?? defaultRuntimeProfileRoots();
  const env = options.env ?? process.env;
  const credentialRoot = path.join(profile.dataDir, "agent-credentials");
  const hostCodexHome = env.CODEX_HOME?.trim() || path.join(roots.homeDir, ".codex");
  const hostDataHome = env.XDG_DATA_HOME?.trim() || path.join(roots.homeDir, ".local", "share");
  const seeds: RestrictedCredentialSeed[] = [
    {
      provider: "Grok",
      label: "grok/auth.json",
      authorized: profile.credentialSources.includes("grok"),
      source: path.join(roots.homeDir, ".grok", "auth.json"),
      destination: path.join(credentialRoot, "home", ".grok", "auth.json"),
      restrict: restrictGrokAuthSnapshot,
      revoke: "always",
    },
    {
      provider: "Codex",
      label: "codex/auth.json",
      authorized: profile.credentialSources.includes("codex"),
      source: path.join(hostCodexHome, "auth.json"),
      // `CODEX_HOME` in `createBackendProcessEnvironment`.
      destination: path.join(credentialRoot, "codex", "auth.json"),
      restrict: restrictCodexAuthSnapshot,
      revoke: "seeded",
    },
    {
      provider: "OpenCode",
      label: "opencode/auth.json",
      authorized: profile.credentialSources.includes("opencode"),
      source: path.join(hostDataHome, "opencode", "auth.json"),
      // `XDG_DATA_HOME` in `createBackendProcessEnvironment`.
      destination: path.join(credentialRoot, "xdg-data", "opencode", "auth.json"),
      restrict: restrictOpenCodeAuthSnapshot,
      revoke: "seeded",
    },
  ];
  const seeded: string[] = [];
  for (const seed of seeds) {
    if (await seedRestrictedCredential(seed, options)) seeded.push(seed.label);
  }
  if (await seedAgentTestCursorCredential(profile, roots)) seeded.push(CURSOR_SNAPSHOT_LABEL);
  return seeded;
}

const CURSOR_SNAPSHOT_LABEL = "cursor/host-api-key.json";
const MAX_CURSOR_SOURCE_BYTES = 1024 * 1024;

/** Read by `loadAgentTestHostCursorApiKey` in `apps/backend/src/core/agent-test-cursor-credential.ts`. */
export function agentTestCursorSnapshotPath(profile: RuntimeProfile): string {
  return path.join(profile.dataDir, "agent-credentials", "cursor", "host-api-key.json");
}

async function seedAgentTestCursorCredential(
  profile: RuntimeProfile,
  roots: RuntimeProfileRoots,
): Promise<boolean> {
  const destination = agentTestCursorSnapshotPath(profile);
  const credential = profile.credentialSources.includes("cursor")
    ? await hostCursorApiKey(roots.productionDataDir).catch(() => undefined)
    : undefined;
  if (!credential) {
    // Not caught: a revoked key that cannot be removed must stop the start.
    await rm(destination, { force: true });
    return false;
  }
  // Like the Grok copy, a seed that cannot be written leaves Cursor signed out.
  try {
    await atomicWriteJson(destination, credential);
    return true;
  } catch {
    // Fail closed even when replacing an existing account. Removal errors
    // propagate so startup cannot load a stale credential.
    await rm(destination, { force: true });
    return false;
  }
}

/** The key a production backend would run Cursor under, in its own order. */
async function hostCursorApiKey(
  productionDataDir: string,
): Promise<{ apiKey: string; apiKeyExpiresAtMs?: number } | undefined> {
  const config = await readBoundedJson(path.join(productionDataDir, "config.json"));
  const configured = (config as { global?: { cursorApiKey?: unknown } } | undefined)?.global
    ?.cursorApiKey;
  if (typeof configured === "string" && configured.trim()) return { apiKey: configured.trim() };

  const login = (await readBoundedJson(path.join(productionDataDir, "cursor-sdk", "auth.json"))) as
    | { apiKey?: unknown; apiKeyExpiresAtMs?: unknown }
    | undefined;
  const minted = typeof login?.apiKey === "string" ? login.apiKey.trim() : "";
  if (!minted) return undefined;
  const expiresAt = login?.apiKeyExpiresAtMs;
  if (typeof expiresAt === "number" && expiresAt <= Date.now()) return undefined;
  return {
    apiKey: minted,
    ...(typeof expiresAt === "number" ? { apiKeyExpiresAtMs: expiresAt } : {}),
  };
}

async function readBoundedJson(filePath: string): Promise<unknown> {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    () => undefined,
  );
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CURSOR_SOURCE_BYTES) return undefined;
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readProfile(profilePath: string): Promise<RuntimeProfile> {
  return parseRuntimeProfile(JSON.parse(await readFile(profilePath, "utf8")) as unknown);
}

export async function readStatus(statusPath: string): Promise<RuntimeStatusManifest | null> {
  try {
    return parseRuntimeStatusManifest(JSON.parse(await readFile(statusPath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export async function reserveLoopbackPort(): Promise<number> {
  return (await reserveLoopbackPorts(1))[0]!;
}

export async function reserveLoopbackPorts(count: number): Promise<number[]> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 16) {
    throw new Error("Loopback port reservation count is invalid");
  }
  const servers: net.Server[] = [];
  const ports: number[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Could not reserve a loopback port");
      ports.push(address.port);
    }
  } finally {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
  return ports;
}

export function processStartTime(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status !== 0) return null;
  const parsed = Date.parse(result.stdout.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function processMatches(
  pid: number | undefined,
  expectedStart: number | undefined,
): boolean {
  if (!pid || !expectedStart) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const actual = processStartTime(pid);
  return actual !== null && Math.abs(actual - expectedStart) < 1_000;
}

export function liveness(
  status: RuntimeStatusManifest | null,
): Record<RuntimeProcessName, boolean> {
  return Object.fromEntries(
    (["launcher", "vite", "electron", "backend"] as const).map((name) => [
      name,
      processMatches(status?.pids[name], status?.processStartTimes[name]),
    ]),
  ) as Record<RuntimeProcessName, boolean>;
}

export async function readAndValidateSentinel(
  profile: RuntimeProfile,
  roots?: RuntimeProfileRoots,
): Promise<unknown> {
  const sentinelPath = path.join(profile.profileRoot, DEV_PROFILE_SENTINEL);
  const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as unknown;
  assertSafeProfileResetTarget({ profile, sentinel, roots });
  return sentinel;
}
