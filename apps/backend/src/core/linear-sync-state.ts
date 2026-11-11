/**
 * What one machine tells another about Linear (docs/architecture/tickets.md,
 * "Linear"): its board links, the disconnects it knows of, and whether it is
 * connected (the key's fingerprint and who it signs in as, never the key).
 * Shared by the leaf's link commands and the command node's sync.
 */
import { createLogger } from "@orkestrator/protocol/logger";
import { linearKeyFingerprint } from "./linear-boards.js";
import type { KanbanStorage, LinearStorage } from "./storage.js";
import {
  isSyncableLinearLinkKey,
  linearBoardLinkKey,
  type LinearBoardLink,
  type LinearRevocation,
} from "./storage-linear.js";

const log = createLogger("linear");

export type LinearSyncStorage = {
  /** This machine's projects: a synced link may not give two of them one board. */
  loadProjects(): Promise<ReadonlyArray<{ id: string; gitUrl?: string | null }>>;
  kanban: Pick<KanbanStorage, "getLinearAuth" | "clearLinearAuth">;
  linear: Pick<
    LinearStorage,
    | "listLinearBoardLinks"
    | "mergeLinearBoardLinks"
    | "listLinearRevocations"
    | "mergeLinearRevocations"
  >;
};

export type LinearSyncState = {
  links: LinearBoardLink[];
  revocations: LinearRevocation[];
  connection: { connected: boolean; keyFingerprint?: string; viewerName?: string };
};

/** This machine's syncable links, disconnects and connection. */
export async function readLinearSyncState(storage: LinearSyncStorage): Promise<LinearSyncState> {
  const [links, revocations, auth] = await Promise.all([
    storage.linear.listLinearBoardLinks(),
    storage.linear.listLinearRevocations(),
    storage.kanban.getLinearAuth(),
  ]);
  return {
    links: links
      .filter((link) => isSyncableLinearLinkKey(link.key))
      .map(({ projectId: _projectId, ...link }) => link),
    revocations,
    connection: auth?.apiKey
      ? {
          connected: true,
          keyFingerprint: linearKeyFingerprint(auth.apiKey),
          ...(auth.viewer?.name ? { viewerName: auth.viewer.name } : {}),
        }
      : { connected: false },
  };
}

/**
 * Clears this machine's key when a disconnect names it and came after it was
 * connected here. A key connected again after the disconnect stays. The
 * connection is judged inside the auth store's lease, so a reconnect (the
 * same key or another) saved while the disconnects were read is never
 * cleared by a disconnect of the connection it replaced.
 */
export async function applyLinearRevocations(storage: LinearSyncStorage): Promise<boolean> {
  if (!(await storage.kanban.getLinearAuth())?.apiKey) return false;
  const revocations = await storage.linear.listLinearRevocations();
  if (revocations.length === 0) return false;
  const cleared = await storage.kanban.clearLinearAuth((auth) =>
    isRevokedConnection(auth, revocations),
  );
  if (cleared) log.info("connection.revoked-by-sync");
  return cleared;
}

/** Whether a disconnect names this connection's key and came after it was connected. */
export function isRevokedConnection(
  auth: { apiKey?: string; connectedAt?: string },
  revocations: readonly LinearRevocation[],
): boolean {
  if (!auth.apiKey) return false;
  const fingerprint = linearKeyFingerprint(auth.apiKey);
  const connectedAt = Date.parse(auth.connectedAt ?? "");
  return revocations.some(
    (revocation) =>
      revocation.keyFingerprint === fingerprint &&
      (Number.isNaN(connectedAt) || Date.parse(revocation.revokedAt) > connectedAt),
  );
}

/** Applies another machine's links and disconnects here. */
export async function applyLinearSyncState(
  storage: LinearSyncStorage,
  input: { links?: unknown; revocations?: unknown },
): Promise<{ applied: number; cleared: boolean }> {
  const links = Array.isArray(input.links) ? input.links : [];
  const revocations = Array.isArray(input.revocations) ? input.revocations : [];
  const localKeys = new Set((await storage.loadProjects()).map(linearBoardLinkKey));
  const applied = storage.linear.mergeLinearBoardLinks(links, localKeys);
  storage.linear.mergeLinearRevocations(revocations);
  const cleared = await applyLinearRevocations(storage);
  return { applied, cleared };
}
