/**
 * The one-time upgrade, at bridge start, of the state a bridge before the
 * shared state directory (#1295, first in v2.32.0-beta) wrote into each Codex
 * login's own `CODEX_HOME/orkestrator-bridge`.
 *
 * On an added account the state directory is the host login's
 * (`bridge-state-dir.ts`), so the account's own directory may still hold
 * titles, command-change measurements, change evidence and a dispatch journal
 * written before then. They are user state: each is merged into the shared
 * directory once, here, and then retired, so no read path looks at the login
 * directory. Session records are not adopted: they expire after seven days
 * without access, so none written before #1295 is still live.
 *
 * - Titles and command changes are appended where the shared copy lacks them,
 *   then the source is renamed `*.adopted`.
 * - The dispatch journal is merged with its at-most-once rules (a conflicting
 *   record is quarantined), published, then removed. A journal that cannot be
 *   merged makes the runtime refuse every dispatch, as an unreadable journal
 *   does, because it may hold a prompt that ran.
 * - Change evidence is imported synchronously before the spool opens
 *   (`adoptLoginChangeEvidence`), then the source entry file is removed.
 *
 * Every step is idempotent, so a crash part-way is finished by the next start,
 * and bounded: the title index by size, command-change journals by count per
 * start, the dispatch journal and change evidence by their own limits. Where
 * the login directory is the state directory (the host login), there is
 * nothing to adopt and nothing is read.
 */
import { join, resolve } from "node:path";
import { codexBridgeStateDir, codexLoginBridgeDir } from "./bridge-state-dir.js";
import { migrateCodexChangeEvidence } from "./change-evidence-migration.js";
import { codexChangeEvidenceDir } from "./change-evidence.js";
import { adoptLoginSessionTitles, SESSION_TITLE_INDEX_FILENAME } from "./session-title-index.js";
import { adoptLoginCommandChanges } from "./sessions/command-changes.js";
import { DispatchJournal, dispatchJournalFileName } from "./sessions/dispatch-journal.js";
import { hashCwd } from "./sessions/persistence.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.codex");

export interface LoginStateAdoptionOptions {
  codexHome: string;
  cwd: string;
  /** The runtime journal's limits, so the merged journal fits them. */
  dispatchJournalMaxRecords?: number;
  dispatchJournalMaxBytes?: number;
}

export interface LoginStateAdoption {
  /** Set when the login's dispatch journal could not be merged; the runtime then refuses dispatch. */
  journalError?: unknown;
}

/** The login's own directory, or undefined when it is the state directory. */
function loginDirectoryToAdopt(codexHome: string): string | undefined {
  const login = codexLoginBridgeDir(codexHome);
  return resolve(login) === resolve(codexBridgeStateDir(codexHome)) ? undefined : login;
}

/**
 * Titles, command changes and the dispatch journal. Never rejects. Run before
 * the runtime's dispatch journal loads, so an adopted record is there to stop
 * a re-send.
 */
export async function adoptLoginBridgeState(
  options: LoginStateAdoptionOptions,
): Promise<LoginStateAdoption> {
  const login = loginDirectoryToAdopt(options.codexHome);
  if (!login) return {};
  const adopted: string[] = [];
  try {
    if (
      await adoptLoginSessionTitles(options.codexHome, join(login, SESSION_TITLE_INDEX_FILENAME))
    ) {
      adopted.push("titles");
    }
  } catch (error) {
    log.warn("login-state.titles-failed", { error: formatLogError(error, { stack: false }) });
  }
  try {
    if ((await adoptLoginCommandChanges(options.codexHome, join(login, "command-changes"))) > 0) {
      adopted.push("command-changes");
    }
  } catch (error) {
    log.warn("login-state.command-changes-failed", {
      error: formatLogError(error, { stack: false }),
    });
  }
  let journalError: unknown;
  try {
    const journal = new DispatchJournal({
      codexHome: options.codexHome,
      cwd: options.cwd,
      maxRecords: options.dispatchJournalMaxRecords,
      maxBytes: options.dispatchJournalMaxBytes,
    });
    if (await journal.adoptFrom(join(login, dispatchJournalFileName(hashCwd(options.cwd))))) {
      adopted.push("dispatch-journal");
    }
  } catch (error) {
    journalError = error;
    log.error("login-state.dispatch-journal-failed", {
      error: formatLogError(error, { stack: false }),
    });
  }
  if (adopted.length > 0) log.info("login-state.adopted", { adopted: adopted.join(",") });
  return journalError === undefined ? {} : { journalError };
}

/**
 * Change evidence, before the spool for `cwd` opens (it reads its directory
 * when constructed). Never throws: a source that cannot be imported safely
 * (conflicting identities, over capacity) stays where it is, unread, for a
 * later start, and the spool opens without it.
 */
export function adoptLoginChangeEvidence(codexHome: string, cwd: string): void {
  const login = loginDirectoryToAdopt(codexHome);
  if (!login) return;
  try {
    migrateCodexChangeEvidence(
      join(login, "change-evidence", hashCwd(cwd)),
      codexChangeEvidenceDir(codexHome, cwd),
    );
  } catch (error) {
    log.error("login-state.change-evidence-failed", {
      error: formatLogError(error, { stack: false }),
    });
  }
}
