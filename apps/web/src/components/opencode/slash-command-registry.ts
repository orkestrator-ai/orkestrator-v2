import type { OpenCodeSlashCommand } from "@/lib/opencode-client";

/**
 * Built-in TUI slash commands documented by OpenCode.
 *
 * The `/command` server endpoint only returns configurable commands
 * (project/global/skills), so we merge this static list in native mode to
 * match TUI command discoverability.
 */
const OPENCODE_TUI_SLASH_COMMANDS: OpenCodeSlashCommand[] = [
  {
    name: "/compact",
    description: "Compact the current session",
  },
  {
    name: "/connect",
    description: "Add a provider",
  },
  {
    name: "/details",
    description: "Toggle tool execution details",
  },
  {
    name: "/editor",
    description: "Open an external editor",
  },
  {
    name: "/exit",
    description: "Exit OpenCode",
  },
  {
    name: "/export",
    description: "Export current conversation",
  },
  {
    name: "/help",
    description: "Show help",
  },
  {
    name: "/init",
    description: "Create or update AGENTS.md",
  },
  {
    name: "/models",
    description: "List available models",
  },
  {
    name: "/new",
    description: "Start a new session",
  },
  {
    name: "/redo",
    description: "Redo the previously undone message",
  },
  {
    name: "/sessions",
    description: "List and switch sessions",
  },
  {
    name: "/share",
    description: "Share current session",
  },
  {
    name: "/themes",
    description: "List available themes",
  },
  {
    name: "/thinking",
    description: "Toggle reasoning visibility",
  },
  {
    name: "/undo",
    description: "Undo the last message",
  },
  {
    name: "/unshare",
    description: "Unshare current session",
  },
];

function normalizeSlashCommandName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function getNativeSlashCommands(
  discoveredCommands: OpenCodeSlashCommand[],
): OpenCodeSlashCommand[] {
  const commandMap = new Map<string, OpenCodeSlashCommand>();

  for (const command of OPENCODE_TUI_SLASH_COMMANDS) {
    commandMap.set(command.name.toLowerCase(), command);
  }

  for (const command of discoveredCommands) {
    const normalizedName = normalizeSlashCommandName(command.name || "");
    if (!normalizedName) {
      continue;
    }

    const key = normalizedName.toLowerCase();
    const existing = commandMap.get(key);

    const normalizedCommand: OpenCodeSlashCommand = {
      ...command,
      name: normalizedName,
    };

    if (!existing) {
      commandMap.set(key, normalizedCommand);
      continue;
    }

    // Prefer metadata discovered from the running OpenCode server while keeping
    // built-in entries as fallback when fields are missing.
    commandMap.set(key, {
      ...existing,
      ...normalizedCommand,
      description: normalizedCommand.description ?? existing.description,
      hints: normalizedCommand.hints ?? existing.hints,
    });
  }

  return Array.from(commandMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
