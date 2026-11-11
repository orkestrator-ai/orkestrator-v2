/**
 * One-time, idempotent import of surviving command-change journals as
 * legacy-summary-only records (delivery phase 7).
 *
 * Imported records keep their original counts, truncation and the
 * `approximate` flag as partial quality. No snapshot, body or boundary is
 * invented and nothing is re-read from today's disk. Records whose identity
 * cannot be recovered (hashed path segments) are skipped rather than guessed.
 *
 * Bridge-side journals stay with their bridges, which keep serving them as
 * the legacy `commandChanges` transcript field; only backend-local journals
 * (OpenCode) are imported here.
 */

import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { CommandChangeJournal } from "@orkestrator/protocol/node/command-change-journal";
import type { ChangeTrackingService } from "./service.js";

/**
 * Where the OpenCode 1.x provider journalled measured shell changes: under the
 * backend data directory, one subdirectory per environment, one `.jsonl` file
 * per session. Nothing writes here any more; existing journals are imported
 * once and removed with their environment.
 */
export const OPENCODE_COMMAND_CHANGES_DIRECTORY = "opencode-command-changes";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const HASHED_SEGMENT = /^[0-9a-f]{40}$/;
const IMPORT_MARKER = "legacy-import:opencode:v1";

export async function importOpenCodeCommandJournals(
  service: ChangeTrackingService,
  dataDir: string,
  options: { maxFiles?: number } = {},
): Promise<{ files: number; records: number; skipped: number }> {
  const result = { files: 0, records: 0, skipped: 0 };
  if (service.ledger.meta(IMPORT_MARKER)) return result;
  const root = path.join(dataDir, OPENCODE_COMMAND_CHANGES_DIRECTORY);
  const environments = await readdir(root).catch(() => [] as string[]);
  const maxFiles = options.maxFiles ?? 10_000;
  for (const environmentId of environments) {
    if (!SAFE_SEGMENT.test(environmentId) || HASHED_SEGMENT.test(environmentId)) {
      result.skipped++;
      continue;
    }
    const files = await readdir(path.join(root, environmentId)).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const conversationId = file.slice(0, -".jsonl".length);
      if (!SAFE_SEGMENT.test(conversationId) || HASHED_SEGMENT.test(conversationId)) {
        result.skipped++;
        continue;
      }
      const marker = `legacy-import:opencode:file:${environmentId}:${conversationId}`;
      if (service.ledger.meta(marker)) continue;
      if (result.files >= maxFiles) return result;
      const records = await new CommandChangeJournal(path.join(root, environmentId, file)).read();
      result.files++;
      result.records += service.importLegacyJournal({
        environmentId,
        provider: "opencode",
        conversationId,
        records,
      });
      service.ledger.transaction(() => service.ledger.setMeta(marker, "done"));
    }
  }
  service.ledger.transaction(() => service.ledger.setMeta(IMPORT_MARKER, new Date().toISOString()));
  return result;
}

/**
 * Delete the journals an environment's OpenCode 1.x sessions left behind.
 * Never rejects; a leftover journal only costs disk. An unusual environment id
 * was journalled under its hash, exactly as the writer named it.
 */
export async function removeOpenCodeCommandChangeJournals(
  dataDir: string,
  environmentId: string,
): Promise<void> {
  const segment = SAFE_SEGMENT.test(environmentId)
    ? environmentId
    : createHash("sha256").update(environmentId).digest("hex").slice(0, 40);
  await rm(path.join(dataDir, OPENCODE_COMMAND_CHANGES_DIRECTORY, segment), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
}
