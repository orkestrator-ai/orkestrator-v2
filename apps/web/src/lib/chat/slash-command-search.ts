/**
 * Picker search over a session's command rows.
 *
 * Search keys are normalized copies (sigil stripped, case folded). The rows
 * themselves are never rewritten, so whatever a row inserts or sends keeps
 * the provider's exact spelling.
 */

/** Fields the search reads. Every command row shape satisfies this. */
export interface SearchableSlashCommand {
  name: string;
  insertText?: string;
  aliases?: string[];
  description?: string;
  source?: string;
}

/** Bounded so a 512-row catalogue with a one-letter query stays cheap to render. */
export const SLASH_COMMAND_SEARCH_LIMIT = 100;

/**
 * Ranking tiers, best first:
 * 0 exact name (or insert text), 1 name prefix, 2 alias match (exact or
 * prefix), 3 any other substring of name, insert text, alias or description.
 */
type Tier = 0 | 1 | 2 | 3;

function searchKey(value: string): string {
  const folded = value.toLowerCase();
  return folded.startsWith("/") || folded.startsWith("$") ? folded.slice(1) : folded;
}

function rankOf(command: SearchableSlashCommand, query: string): Tier | null {
  const names = [command.name, ...(command.insertText ? [command.insertText] : [])].map(searchKey);
  if (names.some((name) => name === query)) return 0;
  if (names.some((name) => name.startsWith(query))) return 1;
  const aliases = (command.aliases ?? []).map(searchKey);
  if (aliases.some((alias) => alias.startsWith(query))) return 2;
  if (
    names.some((name) => name.includes(query)) ||
    aliases.some((alias) => alias.includes(query)) ||
    (command.description ?? "").toLowerCase().includes(query)
  ) {
    return 3;
  }
  return null;
}

/**
 * Filter and rank rows for a query typed after the sigil.
 *
 * An empty query keeps the caller's order (the backend's stable source/name
 * order). Within a tier the caller's order is kept too, so ranking is
 * deterministic and never depends on sort stability or locale.
 */
export function rankSlashCommands<TCommand extends SearchableSlashCommand>(
  commands: readonly TCommand[],
  rawQuery: string,
  limit = SLASH_COMMAND_SEARCH_LIMIT,
): TCommand[] {
  const query = searchKey(rawQuery);
  if (!query) return commands.slice(0, limit);
  const tiers: TCommand[][] = [[], [], [], []];
  for (const command of commands) {
    const tier = rankOf(command, query);
    if (tier !== null) tiers[tier]!.push(command);
  }
  return tiers.flat().slice(0, limit);
}

export interface SlashCommandGroup<TCommand> {
  /** Source of every row in the run. */
  source: string;
  /** Rows with their position in the navigable (flat) list. */
  entries: Array<{ command: TCommand; index: number }>;
}

/**
 * Split a ranked list into consecutive same-source runs.
 *
 * Groups are derived from the list in order rather than by bucketing, so the
 * rendered order is always the keyboard order: a source that reappears
 * further down a ranked list gets a second header instead of pulling its rows
 * up past better matches.
 */
export function groupSlashCommandRuns<TCommand extends SearchableSlashCommand>(
  commands: readonly TCommand[],
): SlashCommandGroup<TCommand>[] {
  const groups: SlashCommandGroup<TCommand>[] = [];
  commands.forEach((command, index) => {
    const source = command.source ?? "unknown";
    const last = groups.at(-1);
    if (last && last.source === source) {
      last.entries.push({ command, index });
    } else {
      groups.push({ source, entries: [{ command, index }] });
    }
  });
  return groups;
}
