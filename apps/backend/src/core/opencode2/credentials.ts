/**
 * OpenCode 2.x credentials: the host's sign-in store and the copy containers
 * are handed.
 *
 * - **The 2.x database is the host's store.** Every host 2.x server shares
 *   one database under `<data>/opencode2/` (`openCode2HostPaths`). Settings →
 *   OpenCode signs providers in through a 2.x server's own integration routes
 *   (`opencode-provider-login.ts`), which write it; every host server reads
 *   credentials from it per use, and 2.x refreshes OAuth logins in it.
 * - **`auth.json` is the container hand-off.** Containers are handed the
 *   host's logins access-only from OpenCode 1.x's `auth.json`
 *   (`pushedLoginHostFile(context, "opencode")`, `agent-accounts-containers.ts`),
 *   which `ContainerLoginFileWatcher` polls. That file is kept in step with
 *   the database here: a sign-in change writes the provider's entry (or
 *   removes it), and while a host 2.x server runs, a login 2.x has refreshed
 *   replaces the file's older copy of the same login
 *   ({@link exportOpenCode2Refreshes}). The database's first start still
 *   imports the file once (2.x behaviour), and a database from before 1.x was
 *   retired is reconciled with the file once (`credential-upgrade.ts`).
 * - **Only the same login is renewed.** Development profiles have their own
 *   databases and can share the user's file, so a refresh is exported only
 *   onto an entry provably of the same login: the same account where both
 *   name one, otherwise a refresh token this database has held (its
 *   lineage, kept as one-way fingerprints in `refresh-lineage.json` beside
 *   the database, never the tokens).
 *
 * The mapping between the two shapes is exactly 2.x's own import
 * (`packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts`
 * at v2.2.6) and its reverse: an API key is a `key` credential with its
 * metadata, an OAuth login an `oauth` credential whose method id is
 * `chatgpt-browser` for `openai`, `device` for `github-copilot`, `opencode`
 * and `xai`, and `oauth` otherwise. The integration id is the provider id
 * without trailing slashes.
 *
 * Credential values are secrets: they are read from the 2.x server's own API
 * or the file and written to the other, never logged, returned or kept.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isSelectableOpenCodeProvider,
  type NativeAgentAuthStatus,
} from "@orkestrator/protocol/native-agent";
import type { LocalServerRuntime } from "../local-server-runtime.js";
import { OpenCode2Client } from "./client.js";
import { openCode2ServerKey } from "./host-server-state.js";

/** A larger file is not an `auth.json` OpenCode wrote. */
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_CREDENTIALS = 512;
/** The credential list carries every stored value. */
const MAX_CREDENTIAL_LIST_BYTES = 2 * 1024 * 1024;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const MAX_STATUS_PROVIDERS = 128;
const MAX_METADATA_ENTRIES = 32;

/** 2.x's `Credential.Value`, as the create route takes it. */
export type OpenCode2CredentialValue =
  | { type: "key"; key: string; metadata?: Record<string, string> }
  | {
      type: "oauth";
      methodID: string;
      refresh: string;
      access: string;
      expires: number;
      metadata?: Record<string, string>;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringMetadata(value: unknown): Record<string, string> | undefined {
  const entries = Object.entries(record(value) ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .slice(0, MAX_METADATA_ENTRIES);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function validExpiry(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The OAuth method id 2.x's import gives a provider. */
export function openCode2OAuthMethodId(integrationId: string): string {
  if (integrationId === "openai") return "chatgpt-browser";
  if (["github-copilot", "opencode", "xai"].includes(integrationId)) return "device";
  return "oauth";
}

/** The integration id 2.x files a provider's credential under. */
export function openCode2IntegrationId(providerId: string): string {
  return providerId.replace(/\/+$/, "");
}

/** One `auth.json` entry as a 2.x credential, or undefined for a shape 2.x would skip. */
export function openCode2CredentialFromLegacy(
  integrationId: string,
  raw: unknown,
): OpenCode2CredentialValue | undefined {
  const entry = record(raw);
  if (!entry) return undefined;
  if (entry.type === "api" && nonEmpty(entry.key)) {
    const metadata = stringMetadata(entry.metadata);
    return { type: "key", key: entry.key, ...(metadata ? { metadata } : {}) };
  }
  if (entry.type === "wellknown" && nonEmpty(entry.token)) {
    return { type: "key", key: entry.token };
  }
  if (
    entry.type === "oauth" &&
    nonEmpty(entry.refresh) &&
    nonEmpty(entry.access) &&
    validExpiry(entry.expires)
  ) {
    const metadata = {
      ...(nonEmpty(entry.accountId) ? { accountID: entry.accountId } : {}),
      ...(nonEmpty(entry.enterpriseUrl) ? { enterpriseUrl: entry.enterpriseUrl } : {}),
    };
    return {
      type: "oauth",
      methodID: openCode2OAuthMethodId(integrationId),
      refresh: entry.refresh,
      access: entry.access,
      expires: entry.expires,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }
  return undefined;
}

/**
 * A 2.x credential as the `auth.json` entry 2.x's import would turn back into
 * it, or undefined for one `auth.json` cannot hold (an `external` login such
 * as an AWS profile, which names host configuration rather than a secret).
 */
export function legacyLoginFromOpenCode2(raw: unknown): Record<string, unknown> | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const metadata = stringMetadata(value.metadata);
  if (value.type === "key" && nonEmpty(value.key)) {
    return { type: "api", key: value.key, ...(metadata ? { metadata } : {}) };
  }
  if (
    value.type === "oauth" &&
    nonEmpty(value.refresh) &&
    nonEmpty(value.access) &&
    validExpiry(value.expires)
  ) {
    return {
      type: "oauth",
      refresh: value.refresh,
      access: value.access,
      expires: value.expires,
      ...(nonEmpty(metadata?.accountID) ? { accountId: metadata.accountID } : {}),
      ...(nonEmpty(metadata?.enterpriseUrl) ? { enterpriseUrl: metadata.enterpriseUrl } : {}),
    };
  }
  return undefined;
}

// ── the host store, through a 2.x server's API ───────────────────────────────

/** A stored credential's identity; its value is never part of it. */
export interface OpenCode2CredentialRef {
  id: string;
  integrationID: string;
  active: boolean;
}

/** `GET /api/credential`, of which every value is dropped on read. */
async function readCredentialList(
  client: Pick<OpenCode2Client, "api">,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const list = await client.api<unknown>("GET", "/api/credential", "OpenCode credential list", {
    maxBytes: MAX_CREDENTIAL_LIST_BYTES,
    signal,
  });
  if (!Array.isArray(list) || list.length > MAX_CREDENTIALS)
    throw new Error("OpenCode credential list is malformed");
  return list.flatMap((candidate) => {
    const entry = record(candidate);
    return entry && nonEmpty(entry.id) && nonEmpty(entry.integrationID) ? [entry] : [];
  });
}

export async function listOpenCode2CredentialRefs(
  client: Pick<OpenCode2Client, "api">,
  signal?: AbortSignal,
): Promise<OpenCode2CredentialRef[]> {
  return (await readCredentialList(client, signal)).map((entry) => ({
    id: entry.id as string,
    integrationID: entry.integrationID as string,
    active: entry.active === true,
  }));
}

async function deleteCredential(
  client: Pick<OpenCode2Client, "api">,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.api(
    "DELETE",
    `/api/credential/${encodeURIComponent(id)}`,
    "OpenCode credential remove",
    { signal },
  );
}

function assertProviderId(providerId: string): string {
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error("Invalid OpenCode provider id");
  return openCode2IntegrationId(providerId);
}

/**
 * After a connect: keep the one active credential of this integration (the
 * connect activates the one it saved) and remove the others, so a provider
 * holds one login, as it did on 1.x. With none active nothing is removed.
 */
export async function keepActiveOpenCode2Credential(
  client: Pick<OpenCode2Client, "api">,
  providerId: string,
  signal?: AbortSignal,
): Promise<void> {
  const integrationId = assertProviderId(providerId);
  const refs = (await listOpenCode2CredentialRefs(client, signal)).filter(
    (ref) => ref.integrationID === integrationId,
  );
  const keep = refs.findLast((ref) => ref.active);
  if (!keep) return;
  for (const ref of refs) if (ref.id !== keep.id) await deleteCredential(client, ref.id, signal);
}

/** Sign a provider out: remove every credential of its integration. Returns how many. */
export async function removeOpenCode2Credentials(
  client: Pick<OpenCode2Client, "api">,
  providerId: string,
  signal?: AbortSignal,
): Promise<number> {
  const integrationId = assertProviderId(providerId);
  const refs = (await listOpenCode2CredentialRefs(client, signal)).filter(
    (ref) => ref.integrationID === integrationId,
  );
  for (const ref of refs) await deleteCredential(client, ref.id, signal);
  return refs.length;
}

/** Each integration's active credential (else its last), as `auth.json` entries. */
async function readStoreAsLegacyLogins(
  client: Pick<OpenCode2Client, "api">,
  signal?: AbortSignal,
): Promise<Map<string, Record<string, unknown> | undefined>> {
  const chosen = new Map<string, Record<string, unknown>>();
  for (const entry of await readCredentialList(client, signal)) {
    const integrationId = entry.integrationID as string;
    if (!PROVIDER_ID_PATTERN.test(integrationId)) continue;
    const previous = chosen.get(integrationId);
    if (!previous || entry.active === true || previous.active !== true) {
      chosen.set(integrationId, entry);
    }
  }
  return new Map(
    Array.from(chosen, ([integrationId, entry]) => [
      integrationId,
      legacyLoginFromOpenCode2(entry.value),
    ]),
  );
}

// ── the container hand-off file ──────────────────────────────────────────────

const fileQueues = new Map<string, Promise<unknown>>();

/** One read-modify-write of `auth.json` at a time per file, in this backend. */
function serialized<T>(file: string, run: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  const tail = next.catch(() => undefined);
  fileQueues.set(file, tail);
  void tail.then(() => {
    if (fileQueues.get(file) === tail) fileQueues.delete(file);
  });
  return next;
}

/**
 * The file's entries; a missing file is empty. One that cannot be read or
 * parsed throws, so a transient failure never replaces the user's logins.
 */
async function readLoginFile(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) throw new Error("OpenCode's credential store is not a file");
    if (stat.size > MAX_AUTH_FILE_BYTES) {
      throw new Error("OpenCode's credential store is too large to read");
    }
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw new Error("OpenCode's credential store could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenCode's credential store is not valid JSON");
  }
  const store = record(parsed);
  if (!store) throw new Error("OpenCode's credential store is not an object");
  return store;
}

/**
 * Apply `change` to the file's entries and replace it atomically (mode 0600)
 * when `change` reports a difference. Returns whether the file was written.
 */
async function updateLoginFile(
  file: string,
  change: (entries: Record<string, unknown>) => boolean,
): Promise<boolean> {
  return serialized(file, async () => {
    const entries = await readLoginFile(file);
    if (!change(entries)) return false;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const staged = path.join(path.dirname(file), `.auth.json.${randomUUID()}.tmp`);
    try {
      await writeFile(staged, JSON.stringify(entries, null, 2), { mode: 0o600, flag: "wx" });
      await rename(staged, file);
    } finally {
      await rm(staged, { force: true });
    }
    return true;
  });
}

function keysOf(entries: Record<string, unknown>, integrationId: string): string[] {
  return Object.keys(entries).filter((key) => openCode2IntegrationId(key) === integrationId);
}

function sameLogin(integrationId: string, current: unknown, next: Record<string, unknown>) {
  return (
    JSON.stringify(openCode2CredentialFromLegacy(integrationId, current)) ===
    JSON.stringify(openCode2CredentialFromLegacy(integrationId, next))
  );
}

/**
 * After a sign-in change: make the file hold what the 2.x store now holds
 * for each provider, its login or nothing. A login `auth.json` cannot hold
 * (an `external` one) leaves the file's entry alone.
 */
export async function exportOpenCode2Logins(
  client: Pick<OpenCode2Client, "api">,
  file: string,
  providerIds: readonly string[],
  signal?: AbortSignal,
  options: { lineageFile?: string } = {},
): Promise<void> {
  const integrationIds = providerIds.map(assertProviderId);
  const store = await readStoreAsLegacyLogins(client, signal);
  // What the file is about to hold is this database's own login.
  if (options.lineageFile) {
    await recordOpenCode2RefreshLineage(
      options.lineageFile,
      new Map(integrationIds.map((id) => [id, store.get(id)])),
    );
  }
  await updateLoginFile(file, (entries) => {
    let changed = false;
    for (const integrationId of integrationIds) {
      const keys = keysOf(entries, integrationId);
      if (!store.has(integrationId)) {
        for (const key of keys) delete entries[key];
        changed ||= keys.length > 0;
        continue;
      }
      const login = store.get(integrationId);
      if (!login) continue;
      if (keys.length === 1 && sameLogin(integrationId, entries[keys[0]!], login)) continue;
      for (const key of keys) delete entries[key];
      entries[integrationId] = login;
      changed = true;
    }
    return changed;
  });
}

// ── refresh lineage ──────────────────────────────────────────────────────────

/** Fingerprints kept per integration; a login rotates its refresh token at most this often between passes. */
const MAX_LINEAGE_PER_INTEGRATION = 16;
const MAX_LINEAGE_INTEGRATIONS = 128;
const MAX_LINEAGE_FILE_BYTES = 256 * 1024;

/** Where a data directory keeps its database's refresh lineage. */
export function openCode2RefreshLineageFile(dataDir: string): string {
  return path.join(dataDir, "opencode2", "refresh-lineage.json");
}

/** A one-way fingerprint of a refresh token: enough to recognise it, never to use it. */
export function openCode2RefreshFingerprint(refresh: string): string {
  return createHash("sha256")
    .update("orkestrator-opencode2-refresh\0")
    .update(refresh)
    .digest("hex");
}

type Lineage = Map<string, string[]>;

/** The lineage; a missing, unreadable or malformed file is empty, which only withholds renewals. */
async function readLineage(file: string): Promise<Lineage> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_LINEAGE_FILE_BYTES) return new Map();
    const parsed = record(JSON.parse(await readFile(file, "utf8")));
    const integrations = record(parsed?.integrations);
    if (parsed?.version !== 1 || !integrations) return new Map();
    const lineage: Lineage = new Map();
    for (const [id, value] of Object.entries(integrations).slice(0, MAX_LINEAGE_INTEGRATIONS)) {
      if (!PROVIDER_ID_PATTERN.test(id) || !Array.isArray(value)) continue;
      const prints = value.filter(
        (print): print is string => typeof print === "string" && /^[0-9a-f]{64}$/.test(print),
      );
      lineage.set(id, prints.slice(-MAX_LINEAGE_PER_INTEGRATION));
    }
    return lineage;
  } catch {
    return new Map();
  }
}

/** Add each OAuth login's refresh fingerprint; returns whether anything was added. */
function extendLineage(
  lineage: Lineage,
  logins: ReadonlyMap<string, Record<string, unknown> | undefined>,
): boolean {
  let changed = false;
  for (const [integrationId, login] of logins) {
    if (login?.type !== "oauth" || !nonEmpty(login.refresh)) continue;
    const print = openCode2RefreshFingerprint(login.refresh);
    const prints = lineage.get(integrationId) ?? [];
    if (prints.includes(print)) continue;
    if (!lineage.has(integrationId) && lineage.size >= MAX_LINEAGE_INTEGRATIONS) continue;
    lineage.set(integrationId, [...prints, print].slice(-MAX_LINEAGE_PER_INTEGRATION));
    changed = true;
  }
  return changed;
}

/**
 * Add `logins` to the file's lineage (one read-modify-write at a time per
 * file) and return the result. A failed write keeps what was read.
 */
async function extendLineageFile(
  file: string,
  logins: ReadonlyMap<string, Record<string, unknown> | undefined>,
): Promise<Lineage> {
  return serialized(file, async () => {
    const lineage = await readLineage(file);
    if (!extendLineage(lineage, logins)) return lineage;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const staged = path.join(path.dirname(file), `.refresh-lineage.${randomUUID()}.tmp`);
    try {
      const integrations = Object.fromEntries(lineage);
      await writeFile(staged, JSON.stringify({ version: 1, integrations }), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(staged, file);
    } finally {
      await rm(staged, { force: true });
    }
    return lineage;
  });
}

/** Record logins this database holds as its own lineage. */
export async function recordOpenCode2RefreshLineage(
  file: string,
  logins: ReadonlyMap<string, Record<string, unknown> | undefined>,
): Promise<void> {
  await extendLineageFile(file, logins);
}

/**
 * Whether the file's OAuth entry is provably the store's own login: where
 * both name an account (and an enterprise host), those decide; otherwise the
 * entry's refresh token must be one this database has held.
 */
function sameOAuthLogin(
  current: Record<string, unknown>,
  login: Record<string, unknown>,
  lineage: readonly string[],
): boolean {
  const host = (entry: Record<string, unknown>) =>
    nonEmpty(entry.enterpriseUrl) ? entry.enterpriseUrl : "";
  if (host(current) !== host(login)) return false;
  if (nonEmpty(current.accountId) && nonEmpty(login.accountId)) {
    return current.accountId === login.accountId;
  }
  // One side naming an account the other does not is not evidence either way.
  if (current.refresh === login.refresh) return true;
  return (
    nonEmpty(current.refresh) && lineage.includes(openCode2RefreshFingerprint(current.refresh))
  );
}

/**
 * Hand containers the OAuth logins 2.x has refreshed: an entry the file holds
 * as an older copy of the same login (`sameOAuthLogin`) takes the store's
 * tokens. Nothing else is written, so two backends with their own stores
 * sharing the user's file (development profiles) only ever move their own
 * login forward and never replace another's, whichever expires later. With
 * no `lineageFile` only an account match or an unchanged refresh token
 * proves a login. Returns how many entries were renewed.
 */
export async function exportOpenCode2Refreshes(
  client: Pick<OpenCode2Client, "api">,
  file: string,
  options: { signal?: AbortSignal; lineageFile?: string } = {},
): Promise<number> {
  const store = await readStoreAsLegacyLogins(client, options.signal);
  // Every refresh the store holds now joins its lineage first, so a rotated
  // token is still recognised in the file after the next rotation.
  const lineage: Lineage = options.lineageFile
    ? await extendLineageFile(options.lineageFile, store)
    : new Map();
  let renewed = 0;
  await updateLoginFile(file, (entries) => {
    for (const [integrationId, login] of store) {
      if (login?.type !== "oauth") continue;
      for (const key of keysOf(entries, integrationId)) {
        const current = record(entries[key]);
        if (current?.type !== "oauth" || !validExpiry(current.expires)) continue;
        if ((login.expires as number) <= current.expires) continue;
        if (!sameOAuthLogin(current, login, lineage.get(integrationId) ?? [])) continue;
        entries[key] = {
          ...current,
          refresh: login.refresh,
          access: login.access,
          expires: login.expires,
        };
        renewed += 1;
      }
    }
    return renewed > 0;
  });
  return renewed;
}

/** A running host 2.x server's client, never starting one. All share one store. */
export function runningOpenCode2HostClient(
  localServers: Pick<LocalServerRuntime, "openCode2" | "process">,
): OpenCode2Client | undefined {
  for (const [environmentId, entry] of localServers.openCode2.live()) {
    if (localServers.process(openCode2ServerKey(environmentId)) !== entry.child) continue;
    return new OpenCode2Client({
      baseUrl: `http://127.0.0.1:${entry.port}`,
      password: entry.password,
      directory: entry.directory,
    });
  }
  return undefined;
}

/**
 * Sign-in status of a 2.x session's server, from `GET /api/provider`: a
 * listed provider is one the server can use now (2.x lists no unconnected
 * provider). Signed in means an allowlisted one is listed, as on 1.x.
 */
export function openCode2AuthStatus(
  providers: unknown,
  allowedProviders: readonly string[],
  hint: string,
): NativeAgentAuthStatus {
  const seen = new Set<string>();
  const listed = (Array.isArray(providers) ? providers : []).flatMap((candidate) => {
    const provider = record(candidate);
    const id = typeof provider?.id === "string" ? provider.id.trim() : "";
    if (!id || !PROVIDER_ID_PATTERN.test(id) || seen.has(id)) return [];
    // `auto` is a provider enabled by its credential (2.2.6); `disabled` is off.
    if (provider?.activation === "disabled") return [];
    seen.add(id);
    return [
      {
        id,
        label:
          typeof provider?.name === "string" && provider.name ? provider.name.slice(0, 200) : id,
        state: "signed-in" as const,
        selectable: isSelectableOpenCodeProvider(id, allowedProviders),
      },
    ];
  });
  const ordered = [
    ...listed.filter((provider) => provider.selectable),
    ...listed.filter((provider) => !provider.selectable),
  ].slice(0, MAX_STATUS_PROVIDERS);
  return {
    state: listed.some((provider) => provider.selectable) ? "signed-in" : "needs-auth",
    providers: ordered.map(({ selectable: _selectable, ...provider }) => provider),
    signIn: { kind: "terminal", hint },
    signOut: false,
  };
}
