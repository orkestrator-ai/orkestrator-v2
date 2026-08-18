/**
 * Slash Command Discovery Service
 *
 * Discovers available slash commands by scanning:
 * 1. Plugin `commands/` directories
 * 2. Project `.claude/commands/` directory (repo-scoped commands)
 * 3. Built-in Claude slash commands
 *
 * Returns commands in the same string format as the SDK's `slash_commands`
 * array (e.g., "/name - description"), which the frontend's `parseSlashCommands()`
 * already handles.
 */

import { open, readdir, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { join, basename, dirname } from "node:path";
import { getMergedPlugins, readPluginManifest } from "./plugin-config.js";

/**
 * Cached frontmatter `description` per command file, validated against the
 * file's identity and mtime (same fingerprint shape as `json-file-cache.ts`).
 *
 * `GET /plugins/commands` re-runs discovery on every call, and without this
 * each call read every plugin command file in full. A stale entry is detected
 * by the stat, so an edited command re-parses on the next discovery.
 */
interface CommandDescriptionCacheEntry {
  fingerprint: string;
  description: string | undefined;
}

const commandDescriptions = new Map<string, CommandDescriptionCacheEntry>();

/**
 * Hard cap on retained entries.
 *
 * Pruning only covers directories discovery re-scanned, so a path that stops
 * being scanned at all — a plugin that was uninstalled, a repo the bridge no
 * longer serves — would otherwise sit in this process-lifetime Map forever.
 * The cap is far above any realistic command count (a project plus its plugins
 * exposes tens), and evicting an entry costs one re-read on the next
 * discovery, never a wrong answer.
 *
 * Exported so tests can size their churn from it rather than a magic number.
 */
export const MAX_COMMAND_DESCRIPTION_CACHE_ENTRIES = 512;

function rememberCommandDescription(filePath: string, entry: CommandDescriptionCacheEntry): void {
  // Re-insert so eviction below drops the least recently *parsed* path.
  commandDescriptions.delete(filePath);
  commandDescriptions.set(filePath, entry);
  while (commandDescriptions.size > MAX_COMMAND_DESCRIPTION_CACHE_ENTRIES) {
    const oldest = commandDescriptions.keys().next();
    if (oldest.done) break;
    commandDescriptions.delete(oldest.value);
  }
}

/**
 * Frontmatter is normally tiny, so reads stay chunked. A larger valid block is
 * read until its closing delimiter, subject to a safety cap so a malformed
 * command cannot make discovery read an unbounded file.
 */
const FRONTMATTER_READ_CHUNK_BYTES = 8 * 1024;
const MAX_FRONTMATTER_READ_BYTES = 256 * 1024;

function fingerprintOf(stats: { mtimeMs: number; size: number; ino: number; dev: number }): string {
  // `ino`/`dev` catch an atomic replace that happens to preserve mtime and
  // size — the common shape of a file written via rename.
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

function hasCompleteFrontmatter(content: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content);
}

async function readFileFrontmatter(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    let content = "";
    let position = 0;

    while (position < MAX_FRONTMATTER_READ_BYTES) {
      const readLength = Math.min(
        FRONTMATTER_READ_CHUNK_BYTES,
        MAX_FRONTMATTER_READ_BYTES - position,
      );
      const buffer = Buffer.allocUnsafe(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, position);
      if (bytesRead === 0) break;

      position += bytesRead;
      content += decoder.write(buffer.subarray(0, bytesRead));

      // Once the first chunk proves there is no frontmatter, the body cannot
      // change that fact. Otherwise continue only until the closing delimiter.
      if (
        (position >= FRONTMATTER_READ_CHUNK_BYTES &&
          !content.startsWith("---\n") &&
          !content.startsWith("---\r\n")) ||
        hasCompleteFrontmatter(content)
      ) {
        break;
      }
    }

    return content + decoder.end();
  } finally {
    await handle.close();
  }
}

/**
 * Resolve a command file's description, serving repeats from the cache until
 * the file changes on disk.
 */
async function readCommandDescription(filePath: string): Promise<string | undefined> {
  const fingerprint = fingerprintOf(await stat(filePath));
  const cached = commandDescriptions.get(filePath);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.description;
  }
  const description = parseDescription(await readFileFrontmatter(filePath));
  rememberCommandDescription(filePath, { fingerprint, description });
  return description;
}

function pruneCommandDescriptionCache(commandsDir: string, livePaths: ReadonlySet<string>): void {
  for (const cachedPath of commandDescriptions.keys()) {
    if (dirname(cachedPath) === commandsDir && !livePaths.has(cachedPath)) {
      commandDescriptions.delete(cachedPath);
    }
  }
}

/**
 * Built-in Claude slash commands (always available)
 */
const BUILTIN_COMMANDS: string[] = [
  "/clear - Clear conversation history",
  "/compact - Compact conversation to reduce tokens",
  "/context - Show current context",
  "/cost - Show token usage and cost",
  "/doctor - Check system health",
  "/goal - Set, view, or clear a completion goal",
  "/help - Show available commands",
  "/init - Re-initialize the session",
  "/logout - Log out of Claude",
  "/memory - Show memory usage",
  "/model - Show or change model",
  "/permissions - Manage permissions",
  "/review - Review recent changes",
  "/status - Show session status",
  "/vim - Toggle vim mode",
];

/**
 * Extract the `description` field from YAML frontmatter in a markdown file.
 */
function parseDescription(content: string): string | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return undefined;

  const frontmatter = match[1];
  const descMatch = frontmatter.match(/^description:\s*(?:"([^"]*?)"|'([^']*?)'|(.+?))\s*$/m);
  if (!descMatch) return undefined;

  return (descMatch[1] ?? descMatch[2] ?? descMatch[3])?.trim();
}

/**
 * Scan a `commands/` directory and return command strings.
 * @param commandsDir - Absolute path to the commands directory
 * @param prefix - Optional prefix for the command name (e.g., "superpowers:")
 */
async function scanCommandsDir(commandsDir: string, prefix: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(commandsDir);
  } catch {
    pruneCommandDescriptionCache(commandsDir, new Set());
    return [];
  }

  const commands: string[] = [];
  const livePaths = new Set<string>();

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const name = basename(entry, ".md");
    const fullName = prefix ? `/${prefix}${name}` : `/${name}`;
    const commandPath = join(commandsDir, entry);
    livePaths.add(commandPath);

    let description: string | undefined;
    try {
      description = await readCommandDescription(commandPath);
    } catch {
      // File unreadable, include command without description
    }

    commands.push(description ? `${fullName} - ${description}` : fullName);
  }

  pruneCommandDescriptionCache(commandsDir, livePaths);
  return commands;
}

/**
 * Discover all available slash commands from plugins, project commands, and built-ins.
 *
 * @param cwd - The working directory (project root)
 * @returns Array of command strings in "/name - description" format
 */
export async function discoverSlashCommands(cwd: string): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];

  const addCommand = (cmd: string) => {
    // Extract just the command name for deduplication
    const name = cmd.split(" - ")[0]!.trim().toLowerCase();
    if (!seen.has(name)) {
      seen.add(name);
      result.push(cmd);
    }
  };

  // 1. Scan repo-scoped commands (highest priority)
  const repoCommands = await scanCommandsDir(join(cwd, ".claude", "commands"), "");
  for (const cmd of repoCommands) addCommand(cmd);

  // 2. Scan plugin commands
  try {
    const plugins = await getMergedPlugins(cwd);

    for (const plugin of plugins) {
      const manifest = await readPluginManifest(plugin.path);
      const pluginName = manifest?.name || plugin.path.split("/").pop() || "unknown";
      const commandsDir = join(plugin.path, "commands");
      const pluginCommands = await scanCommandsDir(commandsDir, `${pluginName}:`);
      for (const cmd of pluginCommands) addCommand(cmd);
    }
  } catch (error) {
    console.warn("[slash-commands] Failed to scan plugin commands:", error);
  }

  // 3. Add built-in commands (lowest priority)
  for (const cmd of BUILTIN_COMMANDS) addCommand(cmd);

  return result.sort((a, b) => a.localeCompare(b));
}
