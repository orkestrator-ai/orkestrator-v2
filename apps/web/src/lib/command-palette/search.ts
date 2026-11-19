/**
 * Ranks the palette's commands for a query. Destinations (projects and
 * environments) keep their own ranking (`searchProjectsAndEnvironments`);
 * commands and settings use the same token scoring (`scoreHaystacks`) over
 * their label and curated aliases, never over a target's name, so a project
 * called "stop" does not turn every Stop command into a match.
 *
 * Group order is fixed (destinations, actions, settings, history) so the
 * palette never reorders sections under the user. Within a group: recently
 * used commands first, then match quality, then available before
 * unavailable, then catalogue order.
 */
import { ALL_MACHINES } from "@/lib/federation/aggregate";
import {
  parseProjectSearchQuery,
  scoreHaystacks,
  THIS_MACHINE,
  type ProjectSearchMachineFilter,
} from "@/lib/project-search";
import {
  commandAvailability,
  commandTarget,
  filterShowsGroup,
  type CommandAvailability,
  type CommandDescriptor,
  type CommandTarget,
  type PaletteContext,
  type PaletteFilter,
} from "./model";

export const PALETTE_COMMAND_LIMIT = 20;
/** Commands an empty query suggests: recents and the context's suggested actions. */
export const PALETTE_SUGGESTION_LIMIT = 6;
export const RECENT_COMMAND_LIMIT = 8;

export interface CommandResult {
  /** Unique in the palette: `command:<id>`. */
  rowId: string;
  command: CommandDescriptor;
  target: CommandTarget;
  availability: CommandAvailability;
  score: number;
  recent: boolean;
}

export interface CommandResults {
  actions: CommandResult[];
  settings: CommandResult[];
}

export function commandRowId(commandId: string): string {
  return `command:${commandId}`;
}

/** Whether a target on `target`'s machine is in the machine filter's scope. */
export function commandInMachineScope(
  target: CommandTarget,
  filter: ProjectSearchMachineFilter,
): boolean {
  if (filter === ALL_MACHINES) return true;
  // Window commands and a single-machine client's are this machine's.
  if (!target.machine) return filter === THIS_MACHINE;
  if (filter === THIS_MACHINE) return target.machine.bound;
  return target.machine.connectionId === filter;
}

export function searchCommands({
  query,
  filter,
  machineFilter = ALL_MACHINES,
  commands,
  context,
  recentCommandIds,
  limit = PALETTE_COMMAND_LIMIT,
  suggestionLimit = PALETTE_SUGGESTION_LIMIT,
}: {
  query: string;
  filter: PaletteFilter;
  machineFilter?: ProjectSearchMachineFilter;
  commands: readonly CommandDescriptor[];
  context: PaletteContext;
  recentCommandIds: readonly string[];
  limit?: number;
  suggestionLimit?: number;
}): CommandResults {
  const tokens = parseProjectSearchQuery(query);
  const recentIndex = new Map(recentCommandIds.map((id, index) => [id, index]));
  const recency = (id: string) => recentIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
  const catalogueIndex = new Map(commands.map((command, index) => [command.id, index]));
  const results: CommandResults = { actions: [], settings: [] };

  for (const command of commands) {
    if (!filterShowsGroup(filter, command.group)) continue;
    if (command.hidden?.(context)) continue;
    const target = commandTarget(command, context);
    if (!commandInMachineScope(target, machineFilter)) continue;
    const availability = commandAvailability(command, context);
    const recent = recentIndex.has(command.id);
    let score = 0;
    if (tokens.length > 0) {
      const matched = scoreHaystacks([command.label, ...command.aliases], tokens);
      if (matched === null) continue;
      score = matched;
    } else if (filter === "all") {
      // An empty query in All suggests: recents and the context's useful
      // actions that can run now. A category filter lists its whole group.
      if (command.group !== "actions") continue;
      if (!recent && !(command.suggested && availability.available)) continue;
    }
    results[command.group].push({
      rowId: commandRowId(command.id),
      command,
      target,
      availability,
      score,
      recent,
    });
  }

  const compare = (left: CommandResult, right: CommandResult) =>
    recency(left.command.id) - recency(right.command.id) ||
    right.score - left.score ||
    Number(right.availability.available) - Number(left.availability.available) ||
    (catalogueIndex.get(left.command.id) ?? 0) - (catalogueIndex.get(right.command.id) ?? 0);
  const cap = tokens.length === 0 && filter === "all" ? suggestionLimit : limit;
  return {
    actions: results.actions.sort(compare).slice(0, cap),
    settings: results.settings.sort(compare).slice(0, cap),
  };
}

/** `recentCommandIds` after `commandId` was used: newest first, deduplicated, bounded. */
export function noteRecentCommand(
  recentCommandIds: readonly string[],
  commandId: string,
  limit = RECENT_COMMAND_LIMIT,
): string[] {
  return [commandId, ...recentCommandIds.filter((id) => id !== commandId)].slice(0, limit);
}
