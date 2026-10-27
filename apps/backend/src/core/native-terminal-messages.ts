import { createHash } from "node:crypto";
import type { NativeAgentNotice } from "@orkestrator/protocol/native-agent";
import { NATIVE_TERMINAL_MESSAGE_ID_PREFIX } from "@orkestrator/protocol/native-terminal-rows";

export interface NativeTerminalMessage {
  id: string;
  role: "system";
  content: string;
  parts: [{ type: "text"; content: string }];
  createdAt: string;
}

/**
 * The system rows for a provider's terminal state: its `error`/`stopped`
 * notices, its session error when no error notice says the same, and a stop
 * result the backend kept (`recordStopNotice`). One row per distinct message,
 * in that order. See `@orkestrator/protocol/native-terminal-rows`.
 */
export function nativeTerminalMessages(input: {
  notices?: readonly NativeAgentNotice[];
  error?: string;
  stopNotice?: string;
  turnStartedAt?: number;
}): NativeTerminalMessage[] {
  const notices = input.notices ?? [];
  const terminal: Array<{ kind: "error" | "stopped"; message: string }> = [
    ...notices.flatMap((notice) =>
      notice.kind === "error" || notice.kind === "stopped"
        ? [{ kind: notice.kind, message: notice.message }]
        : [],
    ),
    ...(input.error &&
    !notices.some((notice) => notice.kind === "error" && notice.message === input.error)
      ? [{ kind: "error" as const, message: input.error }]
      : []),
    ...(input.stopNotice ? [{ kind: "stopped" as const, message: input.stopNotice }] : []),
  ];
  const seen = new Set<string>();
  return terminal.flatMap((notice) => {
    const id = `${NATIVE_TERMINAL_MESSAGE_ID_PREFIX}${notice.kind}:${createHash("sha256")
      .update(notice.message)
      .digest("hex")
      .slice(0, 16)}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        role: "system" as const,
        content: notice.message,
        parts: [{ type: "text" as const, content: notice.message }],
        // Use a stable real time when available so auth cards can reject a
        // sign-in completed before this failure. The sentinel is only a fallback.
        createdAt:
          input.turnStartedAt && Number.isFinite(input.turnStartedAt)
            ? new Date(input.turnStartedAt).toISOString()
            : "1970-01-01T00:00:00.000Z",
      },
    ];
  });
}
