/**
 * Slash commands and prompt shaping.
 *
 * Kept out of the engine deliberately: expanding a prompt template, resolving a
 * built-in and applying the plan-mode wrapper are all decisions about *what the
 * model is asked*, independent of how the turn is executed. Extracted from
 * `index.ts` verbatim; behaviour is unchanged.
 */
import { readFile, readdir } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { basename, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { Input, UserInput } from "../codex-item-types.js";
import { refreshRuntimeEnvironment, runtimeEnvironmentWithoutCredentials } from "../runtime-env.js";
import { getCodexHomeDir } from "../history/rollout.js";
import type { PromptAttachmentInput } from "../sessions/thread-registry.js";

const execFile = promisify(execFileCallback);

export type ConversationMode = "build" | "plan";

export interface BridgeSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  source: "prompt" | "builtin";
}

export interface PromptSlashCommand extends BridgeSlashCommand {
  source: "prompt";
  path: string;
  template: string;
}

export interface BuiltinSlashCommand extends BridgeSlashCommand {
  source: "builtin";
}

export type SlashCommandDefinition = PromptSlashCommand | BuiltinSlashCommand;

export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  {
    name: "/help",
    description: "Show available Codex slash commands in native mode.",
    source: "builtin",
  },
  {
    name: "/goal",
    description: "Set or view an experimental goal for a long-running task.",
    argumentHint: "<objective|pause|resume|clear>",
    source: "builtin",
  },
  {
    name: "/models",
    description: "List available Codex models and current selection.",
    source: "builtin",
  },
  {
    name: "/steer",
    description: "Send additional instructions to the active Codex turn.",
    argumentHint: "<instructions>",
    source: "builtin",
  },
];

export function normalizeSlashCommandName(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function parseSlashCommandPrompt(prompt: string): { name: string; args: string } | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\n")) {
    return null;
  }

  const firstSpaceIndex = trimmed.indexOf(" ");
  const rawName = firstSpaceIndex === -1 ? trimmed : trimmed.slice(0, firstSpaceIndex);
  const args = firstSpaceIndex === -1 ? "" : trimmed.slice(firstSpaceIndex + 1).trim();
  const name = normalizeSlashCommandName(rawName);

  return name ? { name, args } : null;
}

/**
 * `/steer` accepts free-form text, including newlines, unlike prompt-template
 * slash commands. Parse it separately so an idle/stale client cannot leak a
 * multiline steering command into a newly started model turn.
 */
export function parseCodexSteerCommand(prompt: string): { args: string } | null {
  const match = /^\/steer(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  return match ? { args: (match[1] ?? "").trim() } : null;
}

export function isCodexCliNativeSlashCommand(name: string): boolean {
  return name.toLowerCase() === "/goal";
}

export function extractFrontmatter(content: string): {
  body: string;
  fields: Record<string, string>;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return { body: content, fields: {} };
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) {
      fields[key] = value;
    }
  }

  return { body: content.slice(match[0].length), fields };
}

export function summarizePromptTemplate(content: string): string | undefined {
  const taskSectionMatch = content.match(/##\s+Your Task\s*\n+([\s\S]+)/i);
  const candidateBlock = taskSectionMatch ? taskSectionMatch[1] : content;
  const line = candidateBlock
    .split("\n")
    .map((entry) => entry.trim())
    .find(
      (entry) =>
        entry.length > 0 &&
        !entry.startsWith("#") &&
        !entry.startsWith("- Current") &&
        !entry.includes("$ARGUMENTS"),
    );

  return line ? line.replace(/\s+/g, " ").trim() : undefined;
}

export async function collectPromptSlashCommandsFromDir(
  rootDir: string,
): Promise<PromptSlashCommand[]> {
  async function walk(dir: string): Promise<PromptSlashCommand[]> {
    let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const commands: PromptSlashCommand[] = [];
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        commands.push(...(await walk(absolutePath)));
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }

      const rawTemplate = await readFile(absolutePath, "utf8").catch(() => null);
      if (!rawTemplate) continue;

      const { body, fields } = extractFrontmatter(rawTemplate);
      const relativePath = relative(rootDir, absolutePath)
        .replace(/\.md$/i, "")
        .split(sep)
        .join("/");
      const name = normalizeSlashCommandName(relativePath);

      if (!name) continue;

      commands.push({
        name,
        description:
          fields.description ||
          fields.short_description ||
          summarizePromptTemplate(body) ||
          `Run ${basename(relativePath)} prompt`,
        argumentHint: fields.argument_hint || fields.arguments || undefined,
        source: "prompt",
        path: absolutePath,
        template: body,
      });
    }

    return commands;
  }

  return walk(rootDir);
}

export async function getAvailableSlashCommandDefinitions(
  cwd: string,
): Promise<SlashCommandDefinition[]> {
  const commandMap = new Map<string, SlashCommandDefinition>();
  const promptDirs = [join(cwd, ".codex", "prompts"), join(getCodexHomeDir(), "prompts")];

  for (const promptDir of promptDirs) {
    const commands = await collectPromptSlashCommandsFromDir(promptDir);
    for (const command of commands) {
      const key = command.name.toLowerCase();
      if (!commandMap.has(key)) {
        commandMap.set(key, command);
      }
    }
  }

  for (const command of BUILTIN_SLASH_COMMANDS) {
    const key = command.name.toLowerCase();
    // `/steer` is routed to `turn/steer` before prompt-template expansion, so a
    // same-named prompt could be advertised but never executed. Keep this one
    // command reserved while retaining the existing prompt override behaviour
    // for other builtins such as `/help`.
    if (key === "/steer" || !commandMap.has(key)) {
      commandMap.set(key, command);
    }
  }

  return Array.from(commandMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function serializeSlashCommand(command: SlashCommandDefinition): BridgeSlashCommand {
  return {
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    source: command.source,
  };
}

export async function runInlinePromptCommand(command: string, cwd: string): Promise<string> {
  const shell = process.env.SHELL || "/bin/zsh";

  try {
    await refreshRuntimeEnvironment();
    const { stdout, stderr } = await execFile(shell, ["-c", command], {
      cwd,
      // Repository-defined prompt templates execute outside app-server's
      // sandbox and approval flow. They need the refreshed tool PATH, but never
      // the managed GitHub identity reserved for the app-server generation.
      env: runtimeEnvironmentWithoutCredentials(),
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = stdout.trimEnd() || stderr.trimEnd();
    return output.length > 0 ? output : "(no output)";
  } catch (error) {
    const stdout =
      typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    const message =
      stdout.trimEnd() ||
      stderr.trimEnd() ||
      (error instanceof Error ? error.message : "Command failed");
    return message;
  }
}

export async function expandPromptTemplate(
  template: string,
  args: string,
  cwd: string,
): Promise<string> {
  const withArguments = template.replaceAll("$ARGUMENTS", args);
  const matches = Array.from(withArguments.matchAll(/!`([^`]+)`/g));
  if (matches.length === 0) {
    return withArguments;
  }

  let expanded = "";
  let cursor = 0;

  for (const match of matches) {
    const [fullMatch, command = ""] = match;
    const startIndex = match.index ?? cursor;
    expanded += withArguments.slice(cursor, startIndex);
    expanded += await runInlinePromptCommand(command, cwd);
    cursor = startIndex + fullMatch.length;
  }

  expanded += withArguments.slice(cursor);
  return expanded;
}

export function resolveConversationMode(body: Record<string, unknown>): ConversationMode {
  return body.mode === "plan" || body.mode === "build" ? (body.mode as ConversationMode) : "build";
}

// NOTE: This is a soft hint prepended to the user message, not a true system
// prompt.  The model may not enforce it perfectly and a determined user could
// override it.  This is acceptable because plan mode is a UX convenience, not
// a security boundary.
export function wrapPromptForConversationMode(prompt: string, mode: ConversationMode): string {
  if (mode !== "plan") {
    return prompt;
  }

  const preamble = [
    "<system-reminder>",
    "You are in Orkestrator plan mode.",
    "This turn is planning-only. The user expects analysis, a concrete plan, and optional diffs before any implementation.",
    "Treat the current session as consultative and read-only.",
    "Do not claim to have made changes, completed implementation, or written files.",
    "Do not attempt mutating commands or filesystem writes.",
    "Inspect the codebase as needed, then produce:",
    "1. a concise implementation plan,",
    "2. important risks or open questions,",
    "3. exact diffs or patch snippets when useful.",
    "If the user approves the plan later, they will switch you back to build mode in a later turn.",
    "</system-reminder>",
  ].join("\n");

  return `${preamble}\n\n${prompt}`;
}

export function buildPromptInput(prompt: string, attachments: PromptAttachmentInput[]): Input {
  if (attachments.length === 0) {
    return prompt;
  }

  const input: UserInput[] = [];
  if (prompt.length > 0) {
    input.push({ type: "text", text: prompt });
  }

  for (const attachment of attachments) {
    input.push({
      type: "local_image",
      path: attachment.path,
    });
  }

  return input;
}
