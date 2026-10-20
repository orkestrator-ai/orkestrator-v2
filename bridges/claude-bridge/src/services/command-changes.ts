/**
 * Measured line changes for Bash calls.
 *
 * An Edit call's input *is* its diff; a Bash call's says nothing reliable
 * about what it will write. So the bridge measures instead: a PreToolUse hook
 * holds the command until the worktree has been snapshotted, and a
 * PostToolUse hook snapshots it again and diffs the two (see
 * `@orkestrator/protocol/node/workspace-change-probe`). Edit-family calls open an
 * unmeasured window so a Bash call running alongside one is reported as
 * approximate rather than charged with the edit.
 *
 * The result lives on the part as `commandChanges`. Claude's JSONL never
 * carries it, so each measurement is also appended to a per-session journal
 * and laid back over the transcript whenever it is rebuilt from disk.
 *
 * The same window is also reported to the backend as a change-evidence
 * observation (`change-evidence.ts`), with its boundary and overlap kept
 * apart rather than folded into `approximate`.
 */

import type { HookCallback, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import {
  CommandChangeJournal,
  hasMeasuredChanges,
} from "@orkestrator/protocol/node/command-change-journal";
import { isFileEditToolName, type MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { WorkspaceChangeProbe } from "@orkestrator/protocol/node/workspace-change-probe";
import { join } from "node:path";
import type { NormalizedMessage } from "../types/index.js";
import {
  legacyCommandChange,
  recordClaudeObservation,
  recordClaudeToolExecuted,
} from "./change-evidence.js";
import { claudeCommandChangesDir } from "./claude-home.js";

/** One per bridge process: snapshots are shared and serialized per repository. */
export const commandChangeProbe = new WorkspaceChangeProbe();

/**
 * Only the tools the hooks care about, so every other call skips the control
 * round trip entirely.
 */
const COMMAND_CHANGE_HOOK_MATCHER = "^(Bash|Edit|Write|MultiEdit|NotebookEdit)$";
/**
 * Seconds. Git's own calls time out well before this; the bound is for a hook
 * that somehow never returns, which would otherwise hold the command forever.
 */
const COMMAND_CHANGE_HOOK_TIMEOUT_SECONDS = 60;
const MAX_CACHED_JOURNALS = 64;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const journals = new Map<string, CommandChangeJournal>();

/** The journal for one SDK session; `undefined` for an id unfit for a filename. */
export function commandChangeJournal(sdkSessionId: string): CommandChangeJournal | undefined {
  if (!SESSION_ID_PATTERN.test(sdkSessionId)) return undefined;
  let journal = journals.get(sdkSessionId);
  if (journal) {
    // Re-insert so eviction drops the least recently used session.
    journals.delete(sdkSessionId);
  } else {
    journal = new CommandChangeJournal(join(claudeCommandChangesDir(), `${sdkSessionId}.jsonl`));
  }
  journals.set(sdkSessionId, journal);
  while (journals.size > MAX_CACHED_JOURNALS) {
    const oldest = journals.keys().next().value;
    if (oldest === undefined) break;
    journals.delete(oldest);
  }
  return journal;
}

export async function deleteCommandChangeJournal(sdkSessionId: string): Promise<void> {
  const journal = commandChangeJournal(sdkSessionId);
  journals.delete(sdkSessionId);
  await journal?.remove();
}

/**
 * A Bash call that returns as soon as its process is launched measures only
 * the launch; whatever the process writes afterwards lands in other windows.
 */
function isMeasuredCommand(toolName: string, toolInput: unknown): boolean {
  if (toolName !== "Bash") return false;
  const input =
    toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {};
  return input.run_in_background !== true;
}

/** The task id a PostToolUse response names when the call went to the background. */
function backgroundTaskIdOf(response: unknown): string | undefined {
  const id = (response as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Hooks for one query. `onMeasured` receives every non-empty measurement; the
 * journal write happens here so it is not tied to the turn that asked.
 * `conversationId` (the bridge session id) names the change-evidence binding
 * every observation is reported under.
 */
export function commandChangeHooks(
  onMeasured: (toolUseId: string, change: MeasuredWorkspaceChange) => void,
  conversationId?: string,
): {
  PreToolUse: HookCallbackMatcher;
  PostToolUse: HookCallbackMatcher;
  PostToolUseFailure: HookCallbackMatcher;
} {
  const before: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !input.tool_use_id) return {};
    if (isMeasuredCommand(input.tool_name, input.tool_input)) {
      await commandChangeProbe.begin(input.cwd, input.tool_use_id);
    } else if (isFileEditToolName(input.tool_name)) {
      await commandChangeProbe.note(input.cwd, input.tool_use_id);
    }
    return {};
  };
  const after: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") {
      return {};
    }
    if (!input.tool_use_id) return {};
    // A post-tool hook is the proof that the call ran, failed or not.
    recordClaudeToolExecuted(
      input.tool_use_id,
      input.hook_event_name === "PostToolUse" ? backgroundTaskIdOf(input.tool_response) : undefined,
    );
    // Awaited: the next call must not start writing before the "after"
    // snapshot has read the tree.
    const observation = await commandChangeProbe.endObservation(input.tool_use_id);
    const change = legacyCommandChange(observation);
    if (change && hasMeasuredChanges(change)) {
      void commandChangeJournal(input.session_id)?.append(input.tool_use_id, change);
      onMeasured(input.tool_use_id, change);
    }
    // A failed command that ran is still observed; a noted edit or a
    // background launch opened no measured window and reports nothing.
    if (observation && conversationId) {
      recordClaudeObservation(conversationId, input.tool_use_id, observation);
    }
    return {};
  };
  const matcher = (hook: HookCallback): HookCallbackMatcher => ({
    matcher: COMMAND_CHANGE_HOOK_MATCHER,
    hooks: [hook],
    timeout: COMMAND_CHANGE_HOOK_TIMEOUT_SECONDS,
  });
  return {
    PreToolUse: matcher(before),
    PostToolUse: matcher(after),
    PostToolUseFailure: matcher(after),
  };
}

/** Lay journaled measurements back over a transcript rebuilt from disk. */
export function overlayCommandChanges(
  messages: NormalizedMessage[],
  changes: ReadonlyMap<string, MeasuredWorkspaceChange>,
): void {
  if (changes.size === 0) return;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-invocation" || !part.toolUseId) continue;
      const change = changes.get(part.toolUseId);
      if (change) part.commandChanges = change;
    }
  }
}
