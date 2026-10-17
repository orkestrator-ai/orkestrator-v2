/**
 * Which Claude commands are bound to the terminal, remembered per CLI version.
 *
 * Only a turn's `system/init` frame says which commands need Claude's own
 * terminal (`terminal_slash_commands`). `SlashCommand` carries no such marker,
 * and the control-only discovery probe never sees an init frame. Observed on
 * CLI 2.1.296: a new tab's probe listed `/color`, `/focus` and
 * `/reload-plugins` as available, and only the first turn marked them
 * `requires-interactive-ui`.
 *
 * The list belongs to the CLI build rather than to a session, so the bridge
 * keeps the newest one each version reported and applies it to probe rows
 * until the session's own init arrives. It is the CLI's own answer, never a
 * guess: a version this bridge has not seen a turn of gets no list. Persisted
 * beside the session preference files so a bridge restart keeps it; several
 * bridges share that home, and a lost update only costs one entry until the
 * next turn records it again.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeOrkestratorDir } from "./claude-home.js";

const FILE_NAME = "terminal-slash-commands.json";
/** Versions kept; older ones only matter while a host still runs them. */
const MAX_VERSIONS = 4;
const MAX_NAMES = 512;
const MAX_NAME_BYTES = 256;
const MAX_VERSION_LENGTH = 64;

interface StoredEntry {
  version: string;
  commands: string[];
}

let loaded: Promise<StoredEntry[]> | null = null;
let entries: StoredEntry[] = [];
let writes: Promise<void> = Promise.resolve();

function filePath(): string {
  return join(claudeOrkestratorDir(), FILE_NAME);
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_VERSION_LENGTH;
}

function validNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(
      (name): name is string =>
        typeof name === "string" && name.length > 0 && Buffer.byteLength(name) <= MAX_NAME_BYTES,
    )
    .slice(0, MAX_NAMES);
}

function parseEntries(raw: string): StoredEntry[] {
  const parsed: unknown = JSON.parse(raw);
  const list = (parsed as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(list)) return [];
  const result: StoredEntry[] = [];
  for (const candidate of list.slice(0, MAX_VERSIONS)) {
    const record = candidate as { version?: unknown; commands?: unknown } | null;
    const commands = validNames(record?.commands);
    if (!validVersion(record?.version) || !commands) continue;
    if (result.some((entry) => entry.version === record!.version)) continue;
    result.push({ version: record!.version as string, commands });
  }
  return result;
}

/** Read the file once per process. A missing or unreadable file is empty. */
function load(): Promise<StoredEntry[]> {
  loaded ??= readFile(filePath(), "utf8")
    .then(parseEntries, () => [])
    .catch(() => [])
    .then((stored) => {
      // An init recorded while the read was in flight is newer than the file.
      const recorded = new Set(entries.map((entry) => entry.version));
      entries = [...entries, ...stored.filter((entry) => !recorded.has(entry.version))].slice(
        0,
        MAX_VERSIONS,
      );
      return entries;
    });
  return loaded;
}

/**
 * The terminal-bound command names the given CLI version last reported, or
 * undefined when no turn of that version has been seen.
 */
export async function rememberedTerminalSlashCommands(
  version: string | undefined,
): Promise<string[] | undefined> {
  if (!validVersion(version)) return undefined;
  const stored = await load();
  return stored.find((entry) => entry.version === version)?.commands.slice();
}

/**
 * Record what a turn's init frame reported. Absent fields record nothing: an
 * older CLI omits the list, and so does a session where no command carries
 * the tag, and the two cannot be told apart. Best effort; never throws.
 */
export function recordTerminalSlashCommands(version: unknown, commands: unknown): void {
  const names = validNames(commands);
  if (!validVersion(version) || !names) return;
  const previous = entries.find((entry) => entry.version === version);
  if (previous && JSON.stringify(previous.commands) === JSON.stringify(names)) return;
  entries = [
    { version, commands: names },
    ...entries.filter((entry) => entry.version !== version),
  ].slice(0, MAX_VERSIONS);
  writes = writes
    .then(async () => {
      await load();
      const directory = claudeOrkestratorDir();
      await mkdir(directory, { recursive: true });
      const target = filePath();
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ versions: entries })}\n`, {
        mode: 0o600,
      });
      await rename(temporary, target);
    })
    .catch(() => {
      // The in-memory list still serves this process; the next init retries.
    });
}

/** Settles once every queued write has finished. Test-only. */
export function terminalSlashCommandWritesForTesting(): Promise<void> {
  return writes;
}

export function resetTerminalSlashCommandsForTesting(): void {
  loaded = null;
  entries = [];
  writes = Promise.resolve();
}
