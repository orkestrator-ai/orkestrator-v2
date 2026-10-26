import type { UserCommandRecord } from "@orkestrator/protocol/user-commands";

import type { NativeMessage } from "./native-message-types";

const USER_COMMAND_ROW_PREFIX = "user-command:";

function userCommandRow(command: UserCommandRecord): NativeMessage {
  return {
    id: `${USER_COMMAND_ROW_PREFIX}${command.id}`,
    role: "assistant",
    content: "",
    createdAt: command.startedAt,
    parts: [{ type: "user-command", content: command.command, userCommand: command }],
  };
}

/**
 * The transcript with a card for each user `!` command, each placed after the
 * last row that started before it, so a command sits where the user ran it
 * and later agent rows follow it. Rows without a usable clock keep their
 * order; commands newer than every row go at the end.
 */
export function withUserCommandRows(
  messages: readonly NativeMessage[],
  commands: readonly UserCommandRecord[],
): NativeMessage[] {
  if (commands.length === 0) return [...messages];
  const sorted = [...commands].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const result: NativeMessage[] = [];
  let next = 0;
  for (const message of messages) {
    const at = Date.parse(message.createdAt);
    while (
      next < sorted.length &&
      Number.isFinite(at) &&
      Date.parse(sorted[next]!.startedAt) < at
    ) {
      result.push(userCommandRow(sorted[next]!));
      next += 1;
    }
    result.push(message);
  }
  for (; next < sorted.length; next += 1) result.push(userCommandRow(sorted[next]!));
  return result;
}
