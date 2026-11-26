/**
 * Switching a Codex plugin on or off
 * (docs/architecture/agent-capabilities-management.md, "Codex plugins").
 *
 * Codex 0.169.0 records every installed plugin in `$CODEX_HOME/config.toml`
 * as `[plugins."<name>@<marketplace>"]` with `enabled = true|false`, and
 * honours the flag in both `codex plugin list --json` and the skills a
 * session is given. Orkestrator does not install Codex plugins (Codex
 * resolves them from its marketplaces); it only flips that one flag for a
 * plugin Codex itself reports as installed.
 *
 * Ownership rules:
 *
 * - the plugin must be in Codex's own installed list, observed just before;
 * - its entry must already exist as a `[plugins."id"]` table; inline or
 *   dotted layouts stay read-only, and no entry is ever added or removed;
 * - only the `enabled` key changes (`toml-edit.ts` keeps every other byte),
 *   and the result is re-parsed and compared with the intended document;
 * - the file is replaced atomically, keeping its mode, only if it still has
 *   the bytes that were edited (compare-and-swap); a linked or oversized file
 *   is refused;
 * - the outcome is read back from the file, and the caller confirms it with
 *   Codex's own list.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  McpSourceStore,
  scanTomlLayout,
  tomlDeepEqual,
  tomlEntryLayout,
  TomlEditError,
  updateTomlEntry,
} from "../../mcp-management/index.js";
import { assertCapabilityDirectory, CapabilityError, writeFileAtomically } from "../security.js";
import type { ProviderCli } from "./provider-cli.js";

const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;
type ConfigLock = <T>(file: string, work: () => Promise<T>) => Promise<T>;
const sourceLock = new McpSourceStore({ keyFile: "" });

/** One installed plugin from `codex plugin list --json`. */
export interface CodexInstalledPlugin {
  pluginId: string;
  enabled: boolean;
}

/** `codex plugin list --json`: only plugins Codex reports as installed; `null` when unreadable. */
export function parseCodexInstalledPlugins(stdout: string): CodexInstalledPlugin[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const installed = (value as { installed?: unknown } | null)?.installed;
  if (!Array.isArray(installed)) return null;
  return installed.flatMap((raw): CodexInstalledPlugin[] => {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry.pluginId !== "string" || entry.installed === false) return [];
    return [{ pluginId: entry.pluginId, enabled: entry.enabled !== false }];
  });
}

function parseToml(text: string): Record<string, unknown> {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    throw new CapabilityError("unsafe-content", "Codex's config.toml could not be read as TOML.");
  }
}

function pluginEntry(document: Record<string, unknown>, pluginId: string) {
  const plugins = document.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return undefined;
  const entry = (plugins as Record<string, unknown>)[pluginId];
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : undefined;
}

export interface CodexPluginToggleResult {
  pluginId: string;
  enabled: boolean;
  changed: boolean;
}

/**
 * Sets `enabled` for one installed Codex plugin. `installed` is Codex's own
 * list, read just before; a plugin it does not report is refused.
 */
export async function setCodexPluginEnabled(input: {
  codexHome: string;
  pluginId: string;
  enabled: boolean;
  installed: readonly CodexInstalledPlugin[];
  isolationRoot?: string;
  withSourceLock?: ConfigLock;
  afterWrite?: () => void;
}): Promise<CodexPluginToggleResult> {
  const { pluginId } = input;
  if (!PLUGIN_ID.test(pluginId)) {
    throw new CapabilityError("invalid-request", "A Codex plugin is named name@marketplace.");
  }
  if (!input.installed.some((entry) => entry.pluginId === pluginId)) {
    throw new CapabilityError(
      "not-found",
      `Codex does not report ${pluginId} as installed; install it in Codex first.`,
    );
  }
  const file = path.join(input.codexHome, "config.toml");
  const lock = input.withSourceLock ?? sourceLock.withLock.bind(sourceLock);
  return lock(file, () => editCodexPluginFlag(file, input));
}

async function editCodexPluginFlag(
  file: string,
  {
    pluginId,
    enabled,
    isolationRoot,
    afterWrite,
  }: Pick<
    Parameters<typeof setCodexPluginEnabled>[0],
    "pluginId" | "enabled" | "isolationRoot" | "afterWrite"
  >,
): Promise<CodexPluginToggleResult> {
  const directory = path.dirname(file);
  assertCapabilityDirectory(directory, isolationRoot);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile()) {
    throw new CapabilityError(
      "unsupported",
      stat
        ? "Codex's config.toml is not a regular file, so Orkestrator leaves it to Codex."
        : "Codex's config.toml is missing.",
    );
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new CapabilityError("too-large", "Codex's config.toml is too large to edit safely.");
  }
  const text = await fs.readFile(file, "utf8");
  const document = parseToml(text);
  const previous = pluginEntry(document, pluginId);
  const layout = tomlEntryLayout(scanTomlLayout(text), ["plugins"], pluginId);
  if (!previous || layout.kind !== "tables") {
    throw new CapabilityError(
      "unsupported",
      layout.kind === "unsupported"
        ? `${pluginId} is ${layout.reason} in config.toml; switch it in Codex instead.`
        : `config.toml has no [plugins."${pluginId}"] table; switch it in Codex instead.`,
    );
  }
  if (previous.enabled === enabled) return { pluginId, enabled, changed: false };

  let next: string;
  try {
    next = updateTomlEntry(text, ["plugins"], pluginId, previous, { ...previous, enabled });
  } catch (error) {
    throw new CapabilityError(
      "unsupported",
      error instanceof TomlEditError
        ? `config.toml cannot be edited safely here (${error.message}).`
        : "config.toml cannot be edited safely here.",
    );
  }
  // Exactly one value may change.
  const intended = structuredClone(document);
  (pluginEntry(intended, pluginId) as Record<string, unknown>).enabled = enabled;
  if (!tomlDeepEqual(parseToml(next), intended)) {
    throw new CapabilityError(
      "unsafe-content",
      "The edited config.toml would differ in more than the plugin's enabled flag; it was left unchanged.",
    );
  }
  // Compare-and-swap against a writer (Codex, MCP settings) that changed the file meanwhile.
  assertCapabilityDirectory(directory, isolationRoot);
  if ((await fs.readFile(file, "utf8")) !== text) {
    throw new CapabilityError(
      "conflict",
      "Codex's config.toml changed while it was being edited; try again.",
    );
  }
  await writeFileAtomically(file, next, stat.mode & 0o777, isolationRoot);
  afterWrite?.();

  assertCapabilityDirectory(directory, isolationRoot);
  const after = pluginEntry(parseToml(await fs.readFile(file, "utf8")), pluginId);
  if (after?.enabled !== enabled) {
    throw new CapabilityError(
      "conflict",
      `${pluginId} is not ${enabled ? "enabled" : "disabled"} after the edit; another writer changed config.toml.`,
    );
  }
  return { pluginId, enabled, changed: true };
}

/** Reads Codex's installed list, flips the flag, and confirms the change with Codex itself. */
export async function toggleCodexPlugin(
  deps: {
    codexHome: string;
    cli: ProviderCli;
    isolationRoot?: string;
    withSourceLock?: ConfigLock;
    afterWrite?: () => void;
  },
  pluginId: string,
  enabled: boolean,
): Promise<CodexPluginToggleResult> {
  const list = async () => {
    const plugins = parseCodexInstalledPlugins(
      (await deps.cli(["plugin", "list", "--json"])).stdout,
    );
    if (!plugins) {
      throw new CapabilityError("source-unavailable", "Codex's plugin list could not be read.");
    }
    return plugins;
  };
  const result = await setCodexPluginEnabled({
    codexHome: deps.codexHome,
    pluginId,
    enabled,
    installed: await list(),
    isolationRoot: deps.isolationRoot,
    afterWrite: deps.afterWrite,
    ...(deps.withSourceLock ? { withSourceLock: deps.withSourceLock } : {}),
  });
  const confirmed = (await list()).find((entry) => entry.pluginId === pluginId);
  if (confirmed?.enabled !== enabled) {
    throw new CapabilityError(
      "conflict",
      `Codex does not report ${pluginId} as ${enabled ? "enabled" : "disabled"} after the edit.`,
    );
  }
  return result;
}
