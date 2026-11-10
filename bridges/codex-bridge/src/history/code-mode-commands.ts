/**
 * Commands a code-mode `exec` cell ran, as a history reload sees them.
 *
 * Live, app-server reports each command a cell runs (`tools.exec_command`) as
 * a `commandExecution` item and never streams the cell. The rollout keeps
 * both: the cell as a `custom_tool_call` named `exec`, and each command as an
 * `event_msg` `item_completed` record whose `item` is the core
 * `CommandExecution` turn item:
 *
 * ```json
 * {"type":"event_msg","payload":{"type":"item_completed","turn_id":"…","item":{
 *   "type":"CommandExecution","id":"exec-…","command":["/bin/zsh","-lc","cat a.txt"],
 *   "status":"completed","aggregated_output":"…","exit_code":0,
 *   "duration":{"secs":0,"nanos":10250},"source":"unified_exec_startup",…}}}
 * ```
 *
 * Its id is the one the live item carried, so a reload that renders the record
 * through the live adapter and renderer ({@link rolloutCommandExecutionParts})
 * names the call as the live stream did. A reader's opened tool group and held
 * place are keyed by that id, and survive the first replay after live
 * streaming, which renames every row (`replayedRowId`).
 */
import { adaptAppServerItem } from "../app-server/item-adapter.js";
import { commandExecutionParts } from "../messages/normalization.js";
import type { NormalizedPart } from "../messages/types.js";
import { rolloutDurationMs } from "./code-mode-mcp-calls.js";

/** The rollout's spelling of a command item (`TurnItem::CommandExecution`). */
export const ROLLOUT_COMMAND_EXECUTION_ITEM_TYPE = "CommandExecution";

/** A word the shell reads as itself, so app-server leaves it unquoted. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * The one-line command app-server reports for an argument vector, as a POSIX
 * shell would read it. Matches app-server's own join for ordinary arguments
 * (`/bin/zsh -lc 'cat a.txt'`); an argument holding a single quote is quoted
 * equivalently but may be spelled differently.
 */
export function joinCommandArguments(argv: readonly string[]): string {
  return argv
    .map((word) =>
      word === "" ? "''" : PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`,
    )
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The normalized part for a rollout `CommandExecution` item, as the live path
 * renders the matching app-server `commandExecution` item. Null for anything
 * else, or for a record without an id.
 */
export function rolloutCommandExecutionParts(item: unknown): NormalizedPart[] | null {
  if (!isRecord(item) || item.type !== ROLLOUT_COMMAND_EXECUTION_ITEM_TYPE) return null;
  if (typeof item.id !== "string" || item.id.length === 0) return null;
  const command = Array.isArray(item.command)
    ? item.command.every((word) => typeof word === "string")
      ? joinCommandArguments(item.command)
      : undefined
    : typeof item.command === "string"
      ? item.command
      : undefined;
  if (command === undefined) return null;
  const { item: adapted } = adaptAppServerItem({
    id: item.id,
    type: "commandExecution",
    command,
    aggregatedOutput: item.aggregated_output,
    status: item.status,
    exitCode: item.exit_code,
    durationMs: rolloutDurationMs(item.duration) ?? null,
  });
  return adapted?.type === "command_execution" ? commandExecutionParts(adapted) : null;
}

/** Turn-local command slots survive cell output so late outcomes replace the same call. */
export class ReplayCommandSettlement {
  private slots = new Map<string, { parts: NormalizedPart[]; index: number }>();
  private terminal = false;

  reset(): void {
    this.slots.clear();
    this.terminal = false;
  }

  settle(): void {
    this.terminal = true;
    for (const { parts, index } of this.slots.values()) this.settlePart(parts[index]!);
  }

  private settlePart(part: NormalizedPart): void {
    if (this.terminal && part.toolState === "pending") {
      delete part.toolState;
      part.toolLeftRunning = true;
    }
  }

  update(id: string, incoming: NormalizedPart[]): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    slot.parts[slot.index] = incoming[0]!;
    this.settlePart(slot.parts[slot.index]!);
    return true;
  }

  append(id: string, target: NormalizedPart[], incoming: NormalizedPart[]): void {
    const index = target.length;
    target.push(...incoming);
    this.slots.set(id, { parts: target, index });
    this.settlePart(target[index]!);
  }
}
