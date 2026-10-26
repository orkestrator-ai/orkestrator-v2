/**
 * User `!` commands: shell commands a person runs from an agent composer.
 *
 * Typing `!npm login` in a native agent tab or a coordinator conversation runs
 * the command as the user, not as an agent tool call. The backend owns the
 * process (output, stdin, cancel); the transcript shows it as a card; and the
 * agent is told what was run, and what it printed, at the start of its next
 * turn. See `docs/architecture/user-commands.md`.
 *
 * Browser-safe: types, bounds and pure helpers only.
 */

import { COORDINATOR_CONTEXT_CLOSE_TAG, COORDINATOR_CONTEXT_OPEN_TAG } from "./coordinator.js";
import type { HumanPrompt } from "./human-prompts.js";

/** The composer prefix that makes a message a user command. */
export const USER_COMMAND_PREFIX = "!";

/** Resource-change kind; the id is the conversation key (`env-<environment>:<tab>`). */
export const USER_COMMAND_RESOURCE = "user-command" as const;

export const USER_COMMAND_MAX_COMMAND_CHARS = 8 * 1024;
/** Output kept per command for display; older output is dropped from the front. */
export const USER_COMMAND_OUTPUT_TAIL_CHARS = 64 * 1024;
/** Commands kept per tab, running or finished. */
export const USER_COMMAND_MAX_PER_TAB = 20;
export const USER_COMMAND_MAX_RUNNING_PER_TAB = 4;
/** What the agent is given per command, and in total, on its next turn. */
export const USER_COMMAND_CONTEXT_OUTPUT_CHARS = 8 * 1024;
export const USER_COMMAND_CONTEXT_TOTAL_CHARS = 24 * 1024;
export const USER_COMMAND_MAX_INPUT_CHARS = 4 * 1024;

export type UserCommandStatus = "running" | "exited" | "cancelled" | "failed";
/** Where it ran: an environment's worktree, its container, or a coordinator's project checkout. */
export type UserCommandTarget = "worktree" | "container" | "project-checkout";

export interface UserCommandRecord {
  id: string;
  environmentId: string;
  tabId: string;
  command: string;
  target: UserCommandTarget;
  /** Working directory as the command saw it. */
  cwd: string;
  status: UserCommandStatus;
  exitCode?: number;
  /** Why it could not start or was lost (status `failed`). */
  error?: string;
  startedAt: string;
  endedAt?: string;
  /** Terminal output with escapes removed, bounded to its last `USER_COMMAND_OUTPUT_TAIL_CHARS`. */
  output: string;
  outputTruncated: boolean;
  /** What the running command is waiting on the user for, if anything. */
  prompt?: HumanPrompt;
  /** Whether the agent has been given this command yet, and by which prompt. */
  context: { state: "pending" } | { state: "delivered"; requestId: string; at: string };
  revision: number;
}

export interface UserCommandList {
  environmentId: string;
  tabId: string;
  commands: UserCommandRecord[];
}

/** The command a composer message asks to run, or `null` for an ordinary message. */
export function parseUserCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(USER_COMMAND_PREFIX)) return null;
  const command = trimmed.slice(USER_COMMAND_PREFIX.length).trim();
  return command ? command : null;
}

export const USER_COMMAND_CONTEXT_OPEN_TAG = "<orkestrator-user-commands>" as const;
export const USER_COMMAND_CONTEXT_CLOSE_TAG = "</orkestrator-user-commands>" as const;

function contextOutput(output: string, limit: number): string {
  const trimmed = output.replace(/\s+$/, "");
  if (trimmed.length <= limit) return trimmed;
  return `[… ${trimmed.length - limit} earlier characters omitted]\n${trimmed.slice(-limit)}`;
}

/**
 * The block the agent's next prompt starts with: what the user ran, where,
 * how it ended, and its output (bounded). Finished commands only; a command
 * still running is described as running with its output so far.
 */
export function renderUserCommandContext(commands: readonly UserCommandRecord[]): string {
  if (commands.length === 0) return "";
  const perCommand = Math.max(
    1_024,
    Math.min(
      USER_COMMAND_CONTEXT_OUTPUT_CHARS,
      Math.floor(USER_COMMAND_CONTEXT_TOTAL_CHARS / commands.length),
    ),
  );
  const parts = commands.map((record) => {
    const outcome =
      record.status === "running"
        ? "still running"
        : record.status === "cancelled"
          ? "cancelled by the user"
          : record.status === "failed"
            ? `failed to run${record.error ? `: ${record.error}` : ""}`
            : `exit code ${record.exitCode ?? "unknown"}`;
    const output = contextOutput(record.output, perCommand);
    const fence = output.includes("```") ? "````" : "```";
    return (
      `$ ${record.command}\n(in ${record.cwd}; ${outcome})\n` +
      (output ? `${fence}\n${output}\n${fence}` : "(no output)")
    );
  });
  return (
    `${USER_COMMAND_CONTEXT_OPEN_TAG}\n` +
    "The user ran these shell commands themselves with Orkestrator's `!` prefix since your last turn. " +
    "They are not your tool calls and need no reply of their own; use them as context for the message below.\n\n" +
    `${parts.join("\n\n")}\n${USER_COMMAND_CONTEXT_CLOSE_TAG}\n\n`
  );
}

/**
 * Removes the server-authored user-command block from a prompt for display.
 *
 * Like `stripCoordinatorContext`, only one closed block at the very start is
 * removed, so text the user typed is never hidden.
 */
export function stripUserCommandContext(text: string): string {
  if (!text.startsWith(USER_COMMAND_CONTEXT_OPEN_TAG)) return text;
  const end = text.indexOf(USER_COMMAND_CONTEXT_CLOSE_TAG);
  if (end === -1) return text;
  return text.slice(end + USER_COMMAND_CONTEXT_CLOSE_TAG.length).replace(/^\s+/, "");
}

/**
 * Start a prompt with the user-command block. A coordinator prompt keeps its
 * coordinator block first, because display strips exactly one leading block
 * of each kind, in that order.
 */
export function insertUserCommandContext(prompt: string, block: string): string {
  if (!block) return prompt;
  if (prompt.startsWith(COORDINATOR_CONTEXT_OPEN_TAG)) {
    const end = prompt.indexOf(COORDINATOR_CONTEXT_CLOSE_TAG);
    if (end !== -1) {
      const head = prompt.slice(0, end + COORDINATOR_CONTEXT_CLOSE_TAG.length);
      const rest = prompt.slice(end + COORDINATOR_CONTEXT_CLOSE_TAG.length).replace(/^\s+/, "");
      return `${head}\n\n${block}${rest}`;
    }
  }
  return `${block}${prompt}`;
}
