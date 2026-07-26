import type { SlashCommandOption } from "@/components/chat/SlashCommandMenu";

export type SlashCommand = SlashCommandOption;

/** Normalize a command name to always carry the "/" prefix. */
function normalizeCommandName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Parse slash commands from an array of command strings.
 *
 * Commands arrive from the Claude SDK as strings like "/compact" or "/clear".
 * Custom commands may carry a description in the form "/name - description".
 */
export function parseSlashCommands(
  commandStrings: string[] | undefined,
): SlashCommand[] {
  if (!commandStrings || commandStrings.length === 0) {
    return [];
  }

  // Deduplicate by name, preferring the entry that carries a description.
  const commandMap = new Map<string, SlashCommand>();

  for (const cmd of commandStrings) {
    const dashIndex = cmd.indexOf(" - ");
    let name: string;
    let description: string | undefined;

    if (dashIndex !== -1) {
      name = normalizeCommandName(cmd.slice(0, dashIndex));
      description = cmd.slice(dashIndex + 3).trim();
    } else {
      name = normalizeCommandName(cmd);
    }

    const existing = commandMap.get(name);
    if (!existing || (description && !existing.description)) {
      commandMap.set(name, { name, description });
    }
  }

  return Array.from(commandMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
