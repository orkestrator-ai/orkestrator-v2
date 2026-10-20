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

import { readdir } from "node:fs/promises";
import path from "node:path";
import { CommandChangeJournal } from "@orkestrator/protocol/node/command-change-journal";
import { OPENCODE_COMMAND_CHANGES_DIRECTORY } from "../opencode-command-changes.js";
import type { ChangeTrackingService } from "./service.js";

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
