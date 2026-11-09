/**
 * OpenCode 2.x credentials (build plan phase 5; owner decision 3 of
 * 2026-11-09: one Orkestrator sign-in updates both lines).
 *
 * 2.x imports the user's `auth.json` once, when it first creates its
 * database, and from then on keeps credentials in that database
 * (`/api/credential`). Orkestrator signs providers in through 1.x, which
 * writes `auth.json` (`opencode-provider-login.ts`); after each change the
 * same provider's entry is mirrored into the 2.x database here, so a later
 * sign-in, a new key or a sign-out reaches 2.x sessions too.
 *
 * The mirror applies exactly the mapping 2.x's own import applies
 * (`packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts`
 * at v2.2.6): an API key becomes a `key` credential with its metadata, an
 * OAuth login an `oauth` credential whose method id is `chatgpt-browser` for
 * `openai`, `device` for `github-copilot`, `opencode` and `xai`, and `oauth`
 * otherwise, and a well-known token a `key`. The integration id is the
 * provider id without trailing slashes.
 *
 * Credential values are secrets: they are read from `auth.json` and written
 * to the 2.x server's own API, and never logged, returned or kept. The list
 * route answers stored values too, so only `id` and `integrationID` are read
 * from it.
 */
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isSelectableOpenCodeProvider,
  type NativeAgentAuthStatus,
} from "@orkestrator/protocol/native-agent";
import type { OpenCode2Client } from "./client.js";

/** A larger file is not an `auth.json` OpenCode wrote. */
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_CREDENTIALS = 512;
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
    typeof entry.expires === "number" &&
    Number.isSafeInteger(entry.expires) &&
    entry.expires >= 0
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

/** The 1.x credential store every host OpenCode shares, as `opencode-provider-login.ts` writes it. */
export function legacyOpenCodeAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || os.homedir();
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

/**
 * The provider's entry in `auth.json` as a 2.x credential. `undefined` means
 * the store holds no usable entry for it (signed out); a store that cannot be
 * read or parsed throws, so a transient failure never deletes a 2.x login.
 */
export async function readLegacyOpenCodeCredential(
  file: string,
  providerId: string,
): Promise<OpenCode2CredentialValue | undefined> {
  const integrationId = openCode2IntegrationId(providerId);
  let text: string;
  try {
    if ((await stat(file)).size > MAX_AUTH_FILE_BYTES) {
      throw new Error("OpenCode's credential store is too large to read");
    }
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
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
  for (const [key, value] of Object.entries(store)) {
    if (openCode2IntegrationId(key) !== integrationId) continue;
    const credential = openCode2CredentialFromLegacy(integrationId, value);
    if (credential) return credential;
  }
  return undefined;
}

async function credentialIds(
  client: Pick<OpenCode2Client, "api">,
  integrationId: string,
): Promise<string[]> {
  const list = await client.api<unknown>("GET", "/api/credential", "OpenCode credential list", {});
  if (!Array.isArray(list) || list.length > MAX_CREDENTIALS)
    throw new Error("OpenCode credential list is malformed");
  return list.flatMap((candidate) => {
    // Only the id and owner are read; the stored value is never touched.
    const entry = record(candidate);
    return entry?.integrationID === integrationId && nonEmpty(entry.id) ? [entry.id] : [];
  });
}

/**
 * Make the 2.x database hold exactly `credential` for this provider: create
 * and activate it, then remove every older credential of the same
 * integration; or remove them all when `credential` is undefined.
 */
export async function mirrorOpenCode2Credential(
  client: Pick<OpenCode2Client, "api">,
  providerId: string,
  credential: OpenCode2CredentialValue | undefined,
): Promise<"written" | "removed" | "unchanged"> {
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error("Invalid OpenCode provider id");
  const integrationId = openCode2IntegrationId(providerId);
  const previous = await credentialIds(client, integrationId);
  let created: string | undefined;
  if (credential) {
    const entry = await client.api<unknown>("POST", "/api/credential", "OpenCode credential save", {
      body: {
        integrationID: integrationId,
        label: credential.type === "oauth" ? "OAuth" : "API key",
        value: credential,
        activate: true,
      },
    });
    created = nonEmpty(record(entry)?.id) ? (record(entry)!.id as string) : undefined;
    if (!created) throw new Error("OpenCode did not confirm the saved credential");
  }
  for (const id of previous) {
    if (id === created) continue;
    await client.api(
      "DELETE",
      `/api/credential/${encodeURIComponent(id)}`,
      "OpenCode credential remove",
      {},
    );
  }
  if (credential) return "written";
  return previous.length > 0 ? "removed" : "unchanged";
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

/** Reconcile a previously imported database before its next use after preview was disabled. */
export async function reconcileOpenCode2Credentials(
  client: OpenCode2Client,
  file = legacyOpenCodeAuthFile(),
): Promise<void> {
  let store: Record<string, unknown>;
  try {
    if ((await stat(file)).size > MAX_AUTH_FILE_BYTES)
      throw new Error("Credential store too large");
    store = record(JSON.parse(await readFile(file, "utf8")))!;
    if (!store) throw new Error("Invalid credential store");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") store = {};
    else throw new Error("OpenCode credential store could not be reconciled");
  }
  const stored = await client.api<unknown>(
    "GET",
    "/api/credential",
    "OpenCode credential list",
    {},
  );
  if (!Array.isArray(stored) || stored.length > MAX_CREDENTIALS)
    throw new Error("Invalid credential inventory");
  const ids = new Set([
    ...Object.keys(store).map(openCode2IntegrationId),
    ...stored.map((entry) => record(entry)?.integrationID),
  ]);
  if (ids.size > MAX_CREDENTIALS) throw new Error("Credential inventory too large");
  for (const id of ids) {
    if (typeof id !== "string" || !PROVIDER_ID_PATTERN.test(id))
      throw new Error("Invalid credential owner");
    await mirrorOpenCode2Credential(client, id, await readLegacyOpenCodeCredential(file, id));
  }
}
