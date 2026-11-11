import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { snapshotFixtureFiles } from "./codex-fixture-files";

/**
 * Whether a directory entry exists, the entry itself rather than what it
 * points at: `existsSync` follows a link, so a link to a missing target
 * (dangling) reads as absent although a write through it would create that
 * target wherever it points.
 */
function entryExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * A `dev:test` profile's own Pi agent directory: `.pi/agent` under the
 * profile's isolated home, which is where its Pi bridge reads `settings.json`.
 * Never the host's `~/.pi` (an authorized Pi profile is handed only the host's
 * `auth.json`, by path). Throws when the directory, after links, is not inside
 * the profile's data directory, including through a link whose target does
 * not exist.
 */
export function profilePiAgentDirectory(dataDir: string): string {
  const root = path.resolve(dataDir);
  const directory = path.join(root, "agent-credentials", "home", ".pi", "agent");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = realpathSync(root);
  const inside = (candidate: string) => {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      // A dangling link resolves nowhere: never create through it.
      return false;
    }
    return real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
  };
  // Checked before creating anything, so a linked ancestor (dangling or not)
  // is never written through.
  let existing = directory;
  while (!entryExists(existing)) existing = path.dirname(existing);
  if (!inside(existing)) throw new Error("The profile's Pi directory escapes the profile");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!inside(directory)) throw new Error("The profile's Pi directory escapes the profile");
  return directory;
}

type JsonObject = Record<string, unknown>;

/**
 * Rewrites files in a profile's Pi agent directory, each through its own edit
 * of the current JSON (`{}` when absent), and returns the restore. Every file
 * is checked before anything is snapshotted or written: one that is a link,
 * dangling or not, is refused rather than followed, so nothing outside the
 * profile is created, changed, or left behind by the restore. The one writer
 * for every fake-model spec and live scenario that edits Pi's `models.json`
 * or `settings.json`.
 */
export function editProfilePiFiles(
  dataDir: string,
  edits: Record<string, (current: JsonObject) => JsonObject>,
): () => void {
  const directory = profilePiAgentDirectory(dataDir);
  const files = Object.keys(edits).map((name) => {
    if (path.basename(name) !== name) throw new Error(`Not a Pi file name: ${name}`);
    return path.join(directory, name);
  });
  for (const file of files) {
    if (entryExists(file) && lstatSync(file).isSymbolicLink())
      throw new Error(`The profile's Pi file ${path.basename(file)} is a link`);
  }
  const restore = snapshotFixtureFiles(files);
  for (const file of files) {
    const current = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as JsonObject) : {};
    const next = edits[path.basename(file)]!(current);
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }
  return restore;
}

/**
 * `settings` with `compaction.keepRecentTokens` set to 1, the rest of
 * `compaction` and every other setting kept. Pi refuses to compact a session
 * shorter than `keepRecentTokens` ("Nothing to compact (session too small)"),
 * and a scenario's worker session is a few short turns, so `/compact` would be
 * refused rather than run.
 */
export function withKeepRecentTokensForShortSessions(settings: JsonObject): JsonObject {
  const compaction =
    settings.compaction && typeof settings.compaction === "object" ? settings.compaction : {};
  return { ...settings, compaction: { ...compaction, keepRecentTokens: 1 } };
}

/**
 * Sets the profile's Pi `compaction.keepRecentTokens` to 1 and returns the
 * restore (see `withKeepRecentTokensForShortSessions`). A `settings.json`
 * that is a link is refused rather than followed.
 */
export function keepRecentTokensForShortSessions(dataDir: string): () => void {
  return editProfilePiFiles(dataDir, { "settings.json": withKeepRecentTokensForShortSessions });
}
