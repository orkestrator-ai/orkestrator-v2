/**
 * The one-time reconcile of a host OpenCode 2.x database from before 1.x was
 * retired (2026-11-11).
 *
 * Until then `auth.json` was the host's sign-in store: Settings → OpenCode
 * signed providers in through 1.x, and a 2.x database the preview had created
 * was made to match the file at every 2.x host start. Now the database is the
 * store and the file only the copy containers are handed (`credentials.ts`),
 * so a database that already existed can hold what the file no longer does:
 * a provider signed out through 1.x while the preview was off, or lack one
 * signed in since. Its first host start after the upgrade makes it match the
 * file once, the way the old start did, with one exception: an OAuth login
 * the database holds newer than the file's copy of the same login (same
 * account, or the same refresh token) is kept, because 2.x refreshed it and
 * the file's tokens may no longer work. The refresh export then moves the
 * file forward.
 *
 * A marker in the data directory records that it ran; it runs again only if
 * it failed. A database created by this start imported the file itself
 * (2.x behaviour), so the reconcile changes nothing there. A login the file
 * cannot hold (an `external` one) is left in the database.
 *
 * Nothing here logs or returns a credential.
 */
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { OpenCode2Client } from "./client.js";
import {
  legacyLoginFromOpenCode2,
  openCode2CredentialFromLegacy,
  openCode2IntegrationId,
  recordOpenCode2RefreshLineage,
  type OpenCode2CredentialValue,
} from "./credentials.js";

const log = createLogger("native-agent.opencode2");

const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_CREDENTIALS = 512;
const MAX_CREDENTIAL_LIST_BYTES = 2 * 1024 * 1024;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/** The marker a data directory keeps once its database matches the file. */
export function openCode2LegacyReconcileMarker(dataDir: string): string {
  return path.join(dataDir, "opencode2", "legacy-credentials-reconciled");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

/** The file's logins by integration; missing is empty, unreadable throws. */
async function readFileLogins(file: string): Promise<Map<string, OpenCode2CredentialValue>> {
  let text: string;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_AUTH_FILE_BYTES) {
      throw new Error("OpenCode's credential store cannot be read");
    }
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return new Map();
    throw new Error("OpenCode's credential store could not be read");
  }
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (!parsed) throw new Error("OpenCode's credential store is not valid");
  const logins = new Map<string, OpenCode2CredentialValue>();
  for (const [key, value] of Object.entries(parsed)) {
    const integrationId = openCode2IntegrationId(key);
    if (!PROVIDER_ID_PATTERN.test(integrationId) || logins.has(integrationId)) continue;
    const credential = openCode2CredentialFromLegacy(integrationId, value);
    if (credential) logins.set(integrationId, credential);
  }
  return logins;
}

interface StoredCredential {
  id: string;
  integrationID: string;
  active: boolean;
  value: unknown;
}

async function readStore(client: Pick<OpenCode2Client, "api">): Promise<StoredCredential[]> {
  const list = await client.api<unknown>("GET", "/api/credential", "OpenCode credential list", {
    maxBytes: MAX_CREDENTIAL_LIST_BYTES,
  });
  if (!Array.isArray(list) || list.length > MAX_CREDENTIALS) {
    throw new Error("OpenCode credential list is malformed");
  }
  return list.flatMap((candidate) => {
    const entry = record(candidate);
    return entry && nonEmpty(entry.id) && nonEmpty(entry.integrationID)
      ? [
          {
            id: entry.id,
            integrationID: entry.integrationID,
            active: entry.active === true,
            value: entry.value,
          },
        ]
      : [];
  });
}

/** The integration's active credential, else its last. */
function chosen(entries: readonly StoredCredential[]): StoredCredential | undefined {
  return entries.findLast((entry) => entry.active) ?? entries.at(-1);
}

/** Whether the store's login is the file's, refreshed since. */
function storeRefreshedFileLogin(stored: unknown, file: OpenCode2CredentialValue): boolean {
  const login = legacyLoginFromOpenCode2(stored);
  if (login?.type !== "oauth" || file.type !== "oauth") return false;
  if ((login.expires as number) <= file.expires) return false;
  const fileAccount = file.metadata?.accountID;
  if (nonEmpty(login.accountId) && nonEmpty(fileAccount)) return login.accountId === fileAccount;
  return login.refresh === file.refresh;
}

/** Whether the store already holds exactly the file's login. */
function sameValue(
  integrationId: string,
  stored: unknown,
  file: OpenCode2CredentialValue,
): boolean {
  const login = legacyLoginFromOpenCode2(stored);
  return (
    !!login &&
    JSON.stringify(openCode2CredentialFromLegacy(integrationId, login)) === JSON.stringify(file)
  );
}

/**
 * Make the database hold what the file holds, once per data directory.
 * Returns what happened; the caller decides whether a failure matters.
 */
export async function reconcileLegacyOpenCodeLoginsOnce(
  client: Pick<OpenCode2Client, "api">,
  options: { authFile: string; dataDir: string; lineageFile?: string },
): Promise<"reconciled" | "already-reconciled"> {
  const marker = openCode2LegacyReconcileMarker(options.dataDir);
  if (await exists(marker)) return "already-reconciled";
  const fileLogins = await readFileLogins(options.authFile);
  const stored = await readStore(client);
  const byIntegration = new Map<string, StoredCredential[]>();
  for (const entry of stored) {
    if (!PROVIDER_ID_PATTERN.test(entry.integrationID)) continue;
    byIntegration.set(entry.integrationID, [
      ...(byIntegration.get(entry.integrationID) ?? []),
      entry,
    ]);
  }
  const integrations = new Set([...fileLogins.keys(), ...byIntegration.keys()]);
  let written = 0;
  let removed = 0;
  for (const integrationId of integrations) {
    const entries = byIntegration.get(integrationId) ?? [];
    const current = chosen(entries);
    const file = fileLogins.get(integrationId);
    if (!file) {
      // Signed out through 1.x. A login the file cannot hold stays.
      const removable = entries.filter((entry) => legacyLoginFromOpenCode2(entry.value));
      for (const entry of removable) await deleteCredential(client, entry.id);
      removed += removable.length;
      continue;
    }
    if (
      current &&
      (sameValue(integrationId, current.value, file) ||
        storeRefreshedFileLogin(current.value, file))
    ) {
      continue;
    }
    const created = await client.api<unknown>(
      "POST",
      "/api/credential",
      "OpenCode credential save",
      {
        body: {
          integrationID: integrationId,
          label: file.type === "oauth" ? "OAuth" : "API key",
          value: file,
          activate: true,
        },
      },
    );
    const id = record(created)?.id;
    if (!nonEmpty(id)) throw new Error("OpenCode did not confirm the saved credential");
    for (const entry of entries) await deleteCredential(client, entry.id);
    written += 1;
  }
  if (options.lineageFile) {
    const logins = new Map<string, Record<string, unknown> | undefined>();
    for (const entry of await readStore(client)) {
      if (!PROVIDER_ID_PATTERN.test(entry.integrationID)) continue;
      logins.set(entry.integrationID, legacyLoginFromOpenCode2(entry.value));
    }
    await recordOpenCode2RefreshLineage(options.lineageFile, logins);
  }
  await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  log.info("credential.legacy-reconciled", { written, removed });
  return "reconciled";
}

async function deleteCredential(client: Pick<OpenCode2Client, "api">, id: string): Promise<void> {
  await client.api(
    "DELETE",
    `/api/credential/${encodeURIComponent(id)}`,
    "OpenCode credential remove",
    {},
  );
}

/** {@link reconcileLegacyOpenCodeLoginsOnce}, logged rather than thrown: the next start retries. */
export async function reconcileLegacyOpenCodeLoginsBestEffort(
  client: Pick<OpenCode2Client, "api">,
  options: { authFile: string; dataDir: string; lineageFile?: string },
): Promise<void> {
  try {
    await reconcileLegacyOpenCodeLoginsOnce(client, options);
  } catch (error) {
    log.warn("credential.legacy-reconcile-failed", {
      error: formatLogError(error, { message: false }),
    });
  }
}
