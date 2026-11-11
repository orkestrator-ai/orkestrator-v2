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
  type LinearBoardLink,
  type LinearRevocation,
} from "./storage-linear.js";

const log = createLogger("linear");

export type LinearSyncStorage = {
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
 * connected here. A key connected again after the disconnect stays.
 */
export async function applyLinearRevocations(storage: LinearSyncStorage): Promise<boolean> {
  const auth = await storage.kanban.getLinearAuth();
  if (!auth?.apiKey) return false;
  const fingerprint = linearKeyFingerprint(auth.apiKey);
  const connectedAt = Date.parse(auth.connectedAt);
  const revoked = (await storage.linear.listLinearRevocations()).some(
    (revocation) =>
      revocation.keyFingerprint === fingerprint &&
      (Number.isNaN(connectedAt) || Date.parse(revocation.revokedAt) > connectedAt),
  );
  if (!revoked) return false;
  await storage.kanban.clearLinearAuth();
  log.info("connection.revoked-by-sync");
  return true;
}

/** Applies another machine's links and disconnects here. */
export async function applyLinearSyncState(
  storage: LinearSyncStorage,
  input: { links?: unknown; revocations?: unknown },
): Promise<{ applied: number; cleared: boolean }> {
  const links = Array.isArray(input.links) ? input.links : [];
  const revocations = Array.isArray(input.revocations) ? input.revocations : [];
  const applied = storage.linear.mergeLinearBoardLinks(links);
  storage.linear.mergeLinearRevocations(revocations);
  const cleared = await applyLinearRevocations(storage);
  return { applied, cleared };
}
