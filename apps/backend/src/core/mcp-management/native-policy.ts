/**
 * Provider-owned policy that decides whether a source is loaded at all:
 * Codex project trust, Grok folder trust and Grok's compatibility switches.
 *
 * Everything here is read passively from the provider's own files with a
 * bounded read. Anything unreadable or in an unrecognised shape yields
 * "unknown" / the provider default rather than a guess.
 */

import * as fs from "node:fs/promises";
import path from "node:path";

import { MCP_MANAGEMENT_LIMITS } from "@orkestrator/protocol/mcp-management";

/** Bounded text read; `null` when absent, unreadable, oversized or not UTF-8. */
export type TextReader = (filePath: string) => Promise<string | null>;

const POLICY_MAX_BYTES = MCP_MANAGEMENT_LIMITS.sourceFileMaxBytes;

export const readHostText: TextReader = async (filePath) => {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(POLICY_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > POLICY_MAX_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readToml(
  read: TextReader,
  filePath: string,
): Promise<Record<string, unknown> | null> {
  const text = await read(filePath);
  if (text === null) return null;
  try {
    const parsed = Bun.TOML.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface TrustVerdict {
  trust: "allowed" | "excluded" | "unknown";
  reason: string;
}

async function realpathOr(value: string): Promise<string> {
  return fs.realpath(value).catch(() => value);
}

/**
 * The main checkout of a linked git worktree, from its `.git` file
 * (`gitdir: <main>/.git/worktrees/<name>`), or `undefined` for a main checkout.
 */
export async function mainCheckoutOf(
  worktree: string,
  read: TextReader,
): Promise<string | undefined> {
  const text = await read(path.join(worktree, ".git"));
  const match = text ? /^gitdir:\s*(.+)$/m.exec(text) : null;
  if (!match) return undefined;
  const gitDir = path.resolve(worktree, match[1]!.trim());
  const commonText = await read(path.join(gitDir, "commondir"));
  const commonDir = commonText?.trim()
    ? path.resolve(gitDir, commonText.trim())
    : path.dirname(path.dirname(gitDir));
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : undefined;
}

/**
 * Codex trusts a project by `[projects."<path>"] trust_level` in the user
 * config. The worktree's own entry is consulted first, then its main
 * checkout's; keys are compared after resolving symlinks, exactly as written.
 */
export async function codexProjectTrust(
  codexHome: string,
  worktree: string,
  read: TextReader,
): Promise<TrustVerdict> {
  const configPath = path.join(codexHome, "config.toml");
  const config = await readToml(read, configPath);
  if (!config) {
    return {
      trust: "unknown",
      reason:
        "Codex loads project configuration only for projects you have marked trusted in Codex; its trust settings could not be read.",
    };
  }
  const projects = isRecord(config.projects) ? config.projects : {};
  const candidates = [await realpathOr(worktree)];
  const main = await mainCheckoutOf(worktree, read);
  if (main) candidates.push(await realpathOr(main));
  for (const candidate of candidates) {
    const entry = projects[candidate];
    const level = isRecord(entry) ? entry.trust_level : undefined;
    const which = candidate === candidates[0] ? "this worktree" : "its main checkout";
    if (level === "trusted") {
      return { trust: "allowed", reason: `Codex trusts ${which}, so it loads this file.` };
    }
    if (level === "untrusted") {
      return {
        trust: "excluded",
        reason: `Codex marks ${which} untrusted, so it does not load project configuration.`,
      };
    }
  }
  return {
    trust: "unknown",
    reason:
      "Codex has no trust decision for this project; it loads project configuration only after you mark the project trusted in Codex.",
  };
}

function envFlag(value: string | undefined): boolean | undefined {
  const folded = value?.trim().toLowerCase();
  if (!folded) return undefined;
  if (["0", "false", "no", "off"].includes(folded)) return false;
  if (["1", "true", "yes", "on"].includes(folded)) return true;
  return undefined;
}

export interface GrokPolicyInput {
  grokHome: string;
  systemDir: string;
  env: {
    claudeMcps?: string;
    cursorMcps?: string;
    folderTrust?: string;
  };
}

function compatValue(config: Record<string, unknown> | null, vendor: string): boolean | undefined {
  const compat = config && isRecord(config.compat) ? config.compat : undefined;
  const table = compat && isRecord(compat[vendor]) ? compat[vendor] : undefined;
  return typeof table?.mcps === "boolean" ? table.mcps : undefined;
}

export interface GrokCompatVerdict {
  enabled: boolean;
  /** Where a `false` came from, for the excluded reason. */
  source?: string;
}

/**
 * Grok's documented resolution for `[compat.<vendor>] mcps`: environment
 * variable, then requirements, then the user's `config.toml`, then managed
 * config, then the default (on). Project `.grok/config.toml` cannot set it.
 */
export async function grokCompat(
  vendor: "claude" | "cursor",
  input: GrokPolicyInput,
  read: TextReader,
): Promise<GrokCompatVerdict> {
  const variable = vendor === "claude" ? "GROK_CLAUDE_MCPS_ENABLED" : "GROK_CURSOR_MCPS_ENABLED";
  const fromEnv = envFlag(vendor === "claude" ? input.env.claudeMcps : input.env.cursorMcps);
  if (fromEnv !== undefined) return { enabled: fromEnv, source: variable };
  // Highest first. Within requirements the system file is applied last and wins;
  // within managed config the user's copy is applied last and wins.
  const layers: Array<[string, string]> = [
    [path.join(input.systemDir, "requirements.toml"), "Grok's system requirements.toml"],
    [path.join(input.grokHome, "requirements.toml"), "Grok's requirements.toml"],
    [path.join(input.grokHome, "config.toml"), "Grok's config.toml"],
    [path.join(input.grokHome, "managed_config.toml"), "Grok's managed_config.toml"],
    [path.join(input.systemDir, "managed_config.toml"), "Grok's system managed_config.toml"],
  ];
  for (const [file, label] of layers) {
    const value = compatValue(await readToml(read, file), vendor);
    if (value !== undefined) return { enabled: value, source: `[compat.${vendor}] in ${label}` };
  }
  return { enabled: true };
}

function folderTrustEntry(store: Record<string, unknown>, folder: string): boolean | undefined {
  const folders = store.folders;
  const verdict = (value: unknown): boolean | undefined => {
    if (typeof value === "boolean") return value;
    if (value === "trusted") return true;
    if (value === "untrusted") return false;
    if (isRecord(value)) return verdict(value.trusted ?? value.trust ?? value.decision);
    return undefined;
  };
  if (isRecord(folders)) return verdict(folders[folder]);
  if (Array.isArray(folders)) {
    for (const item of folders) {
      if (isRecord(item) && item.path === folder) return verdict(item);
    }
  }
  return undefined;
}

/**
 * Grok's folder-trust store (`$GROK_HOME/trusted_folders.toml`). A grant
 * covers the folder and its subdirectories. The store's layout is not
 * documented, so only recognisable decisions are reported; anything else is
 * "unknown".
 */
export async function grokFolderTrust(
  input: GrokPolicyInput,
  worktree: string,
  read: TextReader,
): Promise<TrustVerdict> {
  if (envFlag(input.env.folderTrust) === false) {
    return { trust: "allowed", reason: "GROK_FOLDER_TRUST=0 turns Grok's folder-trust gate off." };
  }
  const config = await readToml(read, path.join(input.grokHome, "config.toml"));
  const gate = config && isRecord(config.folder_trust) ? config.folder_trust.enabled : undefined;
  if (gate === false) {
    return {
      trust: "allowed",
      reason: "[folder_trust] enabled = false in Grok's config.toml turns the gate off.",
    };
  }
  const store = await readToml(read, path.join(input.grokHome, "trusted_folders.toml"));
  if (store) {
    const own = await realpathOr(worktree);
    let folder = own;
    for (;;) {
      const decision = folderTrustEntry(store, folder);
      if (decision === true) {
        return {
          trust: "allowed",
          reason:
            folder === own
              ? "You trusted this folder in Grok, so it loads project servers."
              : "You trusted a parent folder in Grok, which covers this worktree.",
        };
      }
      if (decision === false) {
        return {
          trust: "excluded",
          reason: "You declined to trust this folder in Grok, so it skips project servers.",
        };
      }
      const parent = path.dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
  }
  return {
    trust: "unknown",
    reason:
      "Grok loads project servers only for folders you have trusted in Grok (--trust or /hooks-trust).",
  };
}
