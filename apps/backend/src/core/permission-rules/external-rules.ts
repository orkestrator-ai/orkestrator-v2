import { promises as fs } from "node:fs";
import path from "node:path";
import {
  codexRuleEntries,
  type ExternalPermissionRuleFile,
  type ExternalPermissionRulesSnapshot,
} from "@orkestrator/protocol/permission-rules";
import { agentAccountHome, hostClaudeConfigDir, hostCodexHome } from "../agent-accounts-homes.js";
import type { CommandContext } from "../commands-context.js";
import { dockerExec } from "../commands-container-exec.js";
import type { Environment } from "../models.js";

/**
 * Rules the providers keep themselves (todo 0723, phase 5), listed read-only:
 * Codex `rules/*.rules` in the host's Codex home, each added account's and
 * each running container's, and Claude `permissions.allow` in its user and
 * project settings. Nothing here writes: neither provider has an API for it
 * and Codex's docs mark its rules format experimental, so the guidance says
 * where to edit.
 *
 * Every read is bounded (files, bytes, entries) and best effort: a file that
 * cannot be read is listed with an error instead of failing the whole view.
 * Nothing is logged; entries can hold commands and paths.
 */

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES_PER_FILE = 200;
const MAX_ENTRY_LENGTH = 1_000;
const MAX_CODEX_RULE_FILES = 32;
const MAX_ENVIRONMENTS = 32;
const CONTAINER_READ_TIMEOUT_MS = 5_000;

// Measured on Codex 0.166.0 (`live-policy-amendment.test.ts`, todo 0160): a
// thread reads the rules once, when it starts.
const CODEX_GUIDANCE =
  "Saved by Codex itself (for example by an older Orkestrator's “Approve with command policy” " +
  "or “Approve with network policy”). Delete the rule from this file to remove it: new Codex " +
  "sessions ask again, and a session already running keeps the rule until it ends. " +
  "Run `codex execpolicy check` to test a command.";
const CLAUDE_GUIDANCE =
  "Saved by Claude Code. Remove the entry with `/permissions` in Claude Code, or edit " +
  "`permissions.allow` in this file.";

function bounded(entries: string[]): { entries: string[]; truncated: boolean } {
  const trimmed = entries
    .slice(0, MAX_ENTRIES_PER_FILE)
    .map((entry) =>
      entry.length > MAX_ENTRY_LENGTH ? `${entry.slice(0, MAX_ENTRY_LENGTH - 1)}…` : entry,
    );
  return { entries: trimmed, truncated: entries.length > MAX_ENTRIES_PER_FILE };
}

/** Claude's `permissions.allow`, or `null` when the JSON is not a settings object. */
export function claudeAllowEntries(text: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const permissions = (value as Record<string, unknown>).permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return [];
  const allow = (permissions as Record<string, unknown>).allow;
  return Array.isArray(allow)
    ? allow.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function readBounded(file: string): Promise<{ text: string; truncated: boolean } | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, Math.min(bytesRead, MAX_FILE_BYTES)).toString("utf8"),
      truncated: bytesRead > MAX_FILE_BYTES,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Files read once each, by real path: account directories link the host's. */
class FileCollector {
  readonly files: ExternalPermissionRuleFile[] = [];
  private readonly seen = new Set<string>();

  async add(
    file: string,
    meta: Omit<ExternalPermissionRuleFile, "path" | "entries" | "truncated" | "error">,
    parse: (text: string) => string[] | null,
  ): Promise<void> {
    let real = file;
    try {
      real = await fs.realpath(file);
    } catch {
      return; // Absent.
    }
    if (this.seen.has(real)) return;
    this.seen.add(real);
    let read: Awaited<ReturnType<typeof readBounded>>;
    try {
      read = await readBounded(real);
    } catch {
      this.files.push({ ...meta, path: file, entries: [], truncated: false, error: "Unreadable" });
      return;
    }
    if (!read) return;
    const parsed = parse(read.text);
    if (parsed === null) {
      this.files.push({
        ...meta,
        path: file,
        entries: [],
        truncated: false,
        error: "Not valid JSON",
      });
      return;
    }
    if (parsed.length === 0) return;
    const { entries, truncated } = bounded(parsed);
    this.files.push({ ...meta, path: file, entries, truncated: truncated || read.truncated });
  }
}

async function codexRuleFiles(directory: string): Promise<string[]> {
  try {
    const names = await fs.readdir(path.join(directory, "rules"));
    return names
      .filter((name) => name.endsWith(".rules"))
      .sort()
      .slice(0, MAX_CODEX_RULE_FILES)
      .map((name) => path.join(directory, "rules", name));
  } catch {
    return [];
  }
}

/** A container's own Codex rules, read with one bounded `docker exec`. */
export async function containerCodexRules(
  environment: Environment,
  exec: typeof dockerExec = dockerExec,
): Promise<ExternalPermissionRuleFile[]> {
  if (!environment.containerId || environment.status !== "running") return [];
  const marker = "@@orkestrator-rules-file@@";
  // Fixed script: no environment-supplied text reaches the shell.
  const script = [
    'for f in "$HOME"/.codex/rules/*.rules; do',
    '  [ -f "$f" ] || continue',
    `  printf '%s %s %s\\n' '${marker}' "$(wc -c < "$f")" "$f"`,
    `  head -c ${MAX_FILE_BYTES} "$f"`,
    "  printf '\\n'",
    "done",
  ].join("\n");
  let output: string;
  try {
    output = await exec(environment.containerId, script, CONTAINER_READ_TIMEOUT_MS);
  } catch {
    return [
      {
        provider: "codex",
        location: "container",
        label: `${environment.name} (container)`,
        path: "~/.codex/rules",
        environmentId: environment.id,
        entries: [],
        truncated: false,
        error: "Could not read the container",
        guidance: CODEX_GUIDANCE,
      },
    ];
  }
  const files: ExternalPermissionRuleFile[] = [];
  for (const chunk of output.split(`${marker} `).slice(1, MAX_CODEX_RULE_FILES + 1)) {
    const newline = chunk.indexOf("\n");
    const header = /^(\d+) (.+)$/.exec(newline === -1 ? "" : chunk.slice(0, newline));
    if (!header) continue;
    const file = header[2]!;
    const byteTruncated = Number(header[1]) > MAX_FILE_BYTES;
    let content = chunk.slice(newline + 1);
    // The script appends a framing newline, which does not complete a cut rule.
    if (byteTruncated) {
      content = content.slice(0, -1);
      content = content.slice(0, content.lastIndexOf("\n") + 1);
    }
    const parsed = codexRuleEntries(content);
    if (!file || (parsed.length === 0 && !byteTruncated)) continue;
    const { entries, truncated } = bounded(parsed);
    files.push({
      provider: "codex",
      location: "container",
      label: `${environment.name} (container)`,
      path: file,
      environmentId: environment.id,
      entries,
      truncated: truncated || byteTruncated,
      guidance: CODEX_GUIDANCE,
    });
  }
  return files;
}

export async function listExternalPermissionRules(
  context: CommandContext,
  projectId?: string,
): Promise<ExternalPermissionRulesSnapshot> {
  const collector = new FileCollector();

  // Codex: the host's home, then each added account's (usually a link to the host's).
  const codexHomes: Array<{ home: string; label: string; location: "host" | "account" }> = [
    { home: hostCodexHome(), label: "Host Codex home", location: "host" },
  ];
  const claudeDirs: Array<{ dir: string; label: string; location: "host" | "account" }> = [
    { dir: hostClaudeConfigDir(), label: "Host Claude settings", location: "host" },
  ];
  try {
    const store = await context.storage.agentAccounts.loadAgentAccounts();
    const root = context.storage.agentAccounts.agentAccountsDirectory();
    for (const account of store.accounts) {
      const home = agentAccountHome(root, account.platform, account.id);
      if (account.platform === "codex") {
        codexHomes.push({ home, label: `Codex account ${account.label}`, location: "account" });
      } else if (account.platform === "claude") {
        claudeDirs.push({
          dir: home,
          label: `Claude account ${account.label}`,
          location: "account",
        });
      }
    }
  } catch {
    // Accounts are optional here; the host's files are still listed.
  }
  for (const { home, label, location } of codexHomes) {
    for (const file of await codexRuleFiles(home)) {
      await collector.add(
        file,
        { provider: "codex", location, label, guidance: CODEX_GUIDANCE },
        codexRuleEntries,
      );
    }
  }
  for (const { dir, label, location } of claudeDirs) {
    for (const name of ["settings.json", "settings.local.json"]) {
      await collector.add(
        path.join(dir, name),
        { provider: "claude", location, label, guidance: CLAUDE_GUIDANCE },
        claudeAllowEntries,
      );
    }
  }

  // Project checkouts (Claude project settings) and running containers (Codex).
  let environments: Environment[] = [];
  try {
    environments = (await context.storage.loadEnvironments())
      .filter((environment) => !projectId || environment.projectId === projectId)
      .filter((environment) => !environment.deletionRequestedAt)
      .slice(0, MAX_ENVIRONMENTS);
  } catch {
    environments = [];
  }
  const containerFiles: ExternalPermissionRuleFile[] = [];
  for (const environment of environments) {
    if (environment.environmentType === "local" && environment.worktreePath) {
      for (const name of ["settings.json", "settings.local.json"]) {
        await collector.add(
          path.join(environment.worktreePath, ".claude", name),
          {
            provider: "claude",
            location: "project",
            label: environment.name,
            environmentId: environment.id,
            guidance: CLAUDE_GUIDANCE,
          },
          claudeAllowEntries,
        );
      }
    } else if (environment.environmentType === "containerized") {
      containerFiles.push(...(await containerCodexRules(environment)));
    }
  }
  return { files: [...collector.files, ...containerFiles] };
}
