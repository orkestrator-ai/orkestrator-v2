/** Credential updates run as root inside the owning container; secrets travel only on stdin. */
import { CONTAINER_ROOT_PATH } from "../container-scripts.js";
import { OPENCODE2_SERVER_PORT } from "../constants.js";
import { quoteShell } from "../commands-agent-support.js";
import { OPENCODE2_DB_PATH, OPENCODE2_LEGACY_DB_PATH } from "../container-state-layout.js";
import { openCode2CredentialFromLegacy } from "./credentials.js";

export function openCode2ContainerCredentialPayload(payload: string): string {
  const parsed = JSON.parse(payload) as { logins: Record<string, unknown>; accessOnly: string[] };
  const credentials: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(parsed.logins)) {
    const entry = raw as Record<string, unknown>;
    // A rotating refresh token is deliberately absent from this container's login.
    const accessOnly =
      parsed.accessOnly.includes(id) && entry.type === "oauth" && entry.refresh === "";
    const credential = openCode2CredentialFromLegacy(
      id,
      accessOnly ? { ...entry, refresh: "access-only" } : entry,
    );
    if (credential?.type === "oauth" && accessOnly) credential.refresh = "";
    if (credential) credentials[id] = credential;
  }
  // Expired host OAuth entries must remove any old refresh-capable database copy too.
  for (const id of parsed.accessOnly) if (!(id in credentials)) credentials[id] = null;
  return JSON.stringify(credentials);
}

/** A missing server is harmless: the next ensure reconciles after starting it. */
export function buildSyncOpenCode2ContainerCredentials(
  options: { tokenFile?: string; baseUrl?: string; bunPath?: string } = {},
): string {
  return `cd / && /usr/bin/env -i PATH=${CONTAINER_ROOT_PATH} ${quoteShell(options.bunPath ?? "/usr/local/bin/bun")} --no-env-file -e ${quoteShell(`
const fs = require("node:fs");
(async () => {
  const input = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error();
  const credentials = JSON.parse(input);
  const tokenFile = ${JSON.stringify(options.tokenFile ?? "/run/orkestrator-bridge/opencode2-token")};
  if (!fs.existsSync(tokenFile)) return;
  const password = fs.readFileSync(tokenFile, "utf8").trim();
  const headers = { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64"), "content-type": "application/json" };
  const api = async (method, route, body) => {
    const response = await fetch(${JSON.stringify(options.baseUrl ?? `http://127.0.0.1:${OPENCODE2_SERVER_PORT}`)} + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    let bytes = 0; const chunks = [];
    if (response.body) for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new Error(); chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text).data : undefined;
  };
  // Token files survive a container restart. A stopped process is reconciled by ensure.
  const info = await fetch(${JSON.stringify((options.baseUrl ?? `http://127.0.0.1:${OPENCODE2_SERVER_PORT}`) + "/api/info")}, { headers, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  if (!info) return;
  if (!info.ok) throw new Error();
  const previous = await api("GET", "/api/credential");
  if (!Array.isArray(previous) || previous.length > 512 || Object.keys(credentials).length > 512) throw new Error();
  for (const [integrationID, value] of Object.entries(credentials)) {
    if (value) {
      const saved = await api("POST", "/api/credential", { integrationID, label: "Managed login", value, activate: true });
      if (!saved || typeof saved.id !== "string" || !saved.id) throw new Error();
    }
    for (const entry of previous) if (entry.integrationID === integrationID) await api("DELETE", "/api/credential/" + encodeURIComponent(entry.id));
  }
})().catch(() => { process.stderr.write("OpenCode 2 credential synchronization failed\\n"); process.exitCode = 1; });
`)}`;
}
export const SYNC_OPENCODE2_CONTAINER_CREDENTIALS = buildSyncOpenCode2ContainerCredentials();

/** Used only after the owning server stopped. Keep session tables and their history intact. */
export function buildScrubOpenCode2ContainerCredentials(
  paths: readonly string[] = [OPENCODE2_DB_PATH, OPENCODE2_LEGACY_DB_PATH],
  bunPath = "/usr/local/bin/bun",
): string {
  return `cd / && /usr/bin/env -i PATH=${CONTAINER_ROOT_PATH} ${quoteShell(bunPath)} --no-env-file -e ${quoteShell(`
const fs = require("node:fs");
const { Database } = require("bun:sqlite");
try {
  for (const file of ${JSON.stringify(paths)}) {
    if (!fs.existsSync(file)) continue;
    const db = new Database(file, { create: false });
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON");
      if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='credential'").get()) db.exec("DELETE FROM credential");
      const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint && checkpoint.busy !== 0) throw new Error();
    } finally { db.close(); }
  }
} catch { process.stderr.write("OpenCode 2 credential cleanup failed\\n"); process.exitCode = 1; }
`)}`;
}
export const SCRUB_OPENCODE2_CONTAINER_CREDENTIALS = buildScrubOpenCode2ContainerCredentials();
