import { createHash } from "node:crypto";
import type {
  NativeAgentNotice,
  NativeAgentRateLimitWindow,
} from "@orkestrator/protocol/native-agent";
import { NATIVE_TERMINAL_MESSAGE_ID_PREFIX } from "@orkestrator/protocol/native-terminal-rows";
import { exhaustedUsageWindows } from "@orkestrator/protocol/agent-usage-limits";
import type {
  ProviderFailureDescriptor,
  ProviderFailureReason,
} from "@orkestrator/protocol/provider-failures";

export interface NativeTerminalMessage {
  id: string;
  role: "system";
  content: string;
  parts: [{ type: "text"; content: string }];
  createdAt: string;
  /**
   * What the provider said about the failure, beside the session error's own
   * row only: its structured reason and, for a usage limit, the reset time of
   * the window it reported exhausted. The renderer classifies the text itself
   * (`@orkestrator/protocol/provider-failures`) when this is absent.
   */
  failure?: ProviderFailureDescriptor;
}

/** A reset can be inferred only when a single reported window is exhausted. */
function exhaustedWindowReset(
  windows: readonly NativeAgentRateLimitWindow[] | undefined,
  now: number,
): string | undefined {
  if (!windows?.length) return undefined;
  const resets = exhaustedUsageWindows(
    windows.map((window) => ({ ...window, window: window.label })),
    now,
  );
  return resets.length === 1 ? resets[0]?.resetsAt : undefined;
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
  /** The bridge's structured reason for `error`. */
  failureReason?: ProviderFailureReason;
  failedTurn?: { id: string; occurredAt: string; resetsAt?: string };
  failureRequestId?: string;
  /** Provider-reported quota windows, for a usage limit's reset time. */
  rateLimits?: readonly NativeAgentRateLimitWindow[];
  stopNotice?: string;
  turnStartedAt?: number;
  now?: number;
}): NativeTerminalMessage[] {
  const notices = input.notices ?? [];
  const resetsAt =
    input.error && input.failureReason === "usage-limit"
      ? (input.failedTurn?.resetsAt ??
        exhaustedWindowReset(input.rateLimits, input.now ?? Date.now()))
      : undefined;
  const sessionFailure: ProviderFailureDescriptor | undefined =
    input.failureReason || resetsAt
      ? {
          ...(input.failureReason ? { reason: input.failureReason } : {}),
          ...(resetsAt ? { resetsAt } : {}),
        }
      : undefined;
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
    const failedTurn =
      notice.kind === "error" && notice.message === input.error ? input.failedTurn : undefined;
    const occurrenceId =
      failedTurn?.id ?? (notice.kind === "error" ? input.failureRequestId : undefined);
    const id = `${NATIVE_TERMINAL_MESSAGE_ID_PREFIX}${notice.kind}:${createHash("sha256")
      .update(occurrenceId ? JSON.stringify([occurrenceId, notice.message]) : notice.message)
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
          failedTurn?.occurredAt ??
          (input.turnStartedAt && Number.isFinite(input.turnStartedAt)
            ? new Date(input.turnStartedAt).toISOString()
            : "1970-01-01T00:00:00.000Z"),
        ...(sessionFailure && notice.kind === "error" && notice.message === input.error
          ? { failure: sessionFailure }
          : {}),
      },
    ];
  });
}
