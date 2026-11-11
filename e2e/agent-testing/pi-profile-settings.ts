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
 * A `dev:test` profile's own Pi agent directory: `.pi/agent` under the
 * profile's isolated home, which is where its Pi bridge reads `settings.json`.
 * Never the host's `~/.pi` (an authorized Pi profile is handed only the host's
 * `auth.json`, by path). Throws when the directory, after links, is not inside
 * the profile's data directory.
 */
export function profilePiAgentDirectory(dataDir: string): string {
  const root = path.resolve(dataDir);
  const directory = path.join(root, "agent-credentials", "home", ".pi", "agent");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = realpathSync(root);
  const inside = (candidate: string) => {
    const real = realpathSync(candidate);
    return real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
  };
  // Checked before creating anything, so a linked ancestor is never written through.
  let existing = directory;
  while (!existsSync(existing)) existing = path.dirname(existing);
  if (!inside(existing)) throw new Error("The profile's Pi directory escapes the profile");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!inside(directory)) throw new Error("The profile's Pi directory escapes the profile");
  return directory;
}

/**
 * Sets the profile's Pi `compaction.keepRecentTokens` to 1 and returns the
 * restore. Pi refuses to compact a session shorter than `keepRecentTokens`
 * ("Nothing to compact (session too small)"), and a scenario's worker session
 * is a few short turns, so `/compact` would be refused rather than run. Other
 * settings, and the rest of `compaction`, are kept. A `settings.json` that is
 * a link is refused rather than followed.
 */
export function keepRecentTokensForShortSessions(dataDir: string): () => void {
  const settings = path.join(profilePiAgentDirectory(dataDir), "settings.json");
  if (existsSync(settings) && lstatSync(settings).isSymbolicLink())
    throw new Error("The profile's Pi settings file is a link");
  const restore = snapshotFixtureFiles([settings]);
  const current = existsSync(settings)
    ? (JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>)
    : {};
  const compaction =
    current.compaction && typeof current.compaction === "object" ? current.compaction : {};
  writeFileSync(
    settings,
    `${JSON.stringify({ ...current, compaction: { ...compaction, keepRecentTokens: 1 } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return restore;
}
