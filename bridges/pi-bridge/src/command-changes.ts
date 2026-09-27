/**
 * Measured line changes for shell tool calls: the "+N −M" a `bash` card shows
 * beside the one an `edit` card already has.
 *
 * A shell command's input cannot say what it will write, so the change is
 * measured by snapshotting the worktree around it (`WorkspaceChangeProbe`).
 * Pi holds every tool call on its awaited `tool_call` hook and runs the
 * `tool_result` hook after execution but before `tool_execution_end`, so both
 * snapshots are taken while the command is held rather than raced: the
 * "before" is fresh, and the "after" is in before the next sequential call.
 *
 * The result is stamped on the card, persisted with the transcript, and
 * journaled per Pi session so a resume or fork — which rebuilds the transcript
 * from Pi's session file — can put the badge back.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CommandChangeJournal,
  hasMeasuredChanges,
} from "@orkestrator/protocol/command-change-journal";
import { isFileEditToolName, type MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { WorkspaceChangeProbe } from "@orkestrator/protocol/workspace-change-probe";
import { commandChangeJournalPath, workingDirectory } from "./config.js";
import { schedulePersist } from "./persistence.js";
import type { SessionState } from "./state.js";
import { applyCommandChanges } from "./translate.js";
import { chargeTranscript } from "./transcript.js";

/** Pi's built-in shell tools. Neither has a background mode to skip. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

export function isShellToolName(toolName: string | undefined): boolean {
  return toolName !== undefined && SHELL_TOOLS.has(toolName);
}

/** The probe surface this module uses, so tests can substitute one. */
export type CommandChangeProbe = Pick<WorkspaceChangeProbe, "begin" | "note" | "end" | "discard">;

/** One per process: overlap detection only works if every call shares it. */
let probe: CommandChangeProbe = new WorkspaceChangeProbe();

export function setCommandChangeProbeForTests(replacement?: CommandChangeProbe): void {
  probe = replacement ?? new WorkspaceChangeProbe();
}

/**
 * The probe is process-wide and Pi's tool call ids are only unique within a
 * conversation (some providers number them), so windows are scoped to the
 * bridge session that opened them.
 */
function windowId(state: SessionState, toolCallId: string): string {
  return `${state.id}:${toolCallId}`;
}

/**
 * Open a window for a call Pi is about to run: measured for a shell tool,
 * noted for a file edit so a shell call overlapping it is marked approximate.
 */
export async function beginToolCall(
  state: SessionState,
  toolCallId: string,
  toolName: string,
): Promise<void> {
  if (!toolCallId) return;
  if (isShellToolName(toolName)) {
    await probe.begin(workingDirectory, windowId(state, toolCallId)).catch(() => undefined);
  } else if (isFileEditToolName(toolName)) {
    await probe.note(workingDirectory, windowId(state, toolCallId)).catch(() => undefined);
  }
}

/** Close a call's window and record what it changed, if anything. */
export async function endToolCall(state: SessionState, toolCallId: string): Promise<void> {
  if (!toolCallId) return;
  const change = await probe.end(windowId(state, toolCallId)).catch(() => undefined);
  if (!change || !hasMeasuredChanges(change)) return;
  applyCommandChanges(state, toolCallId, change);
  schedulePersist();
  const journal = journalFor(state.piSessionId);
  if (journal) void journal.append(toolCallId, change);
}

/**
 * Drop a window whose call never reached the post-tool hook — a later
 * `tool_call` handler blocked it, or the turn aborted before it ran. A no-op
 * for a call already ended, which is every call that executed.
 */
export function discardToolCall(state: SessionState, toolCallId: string): void {
  if (toolCallId) probe.discard(windowId(state, toolCallId));
}

/**
 * The measuring hooks, as a Pi extension.
 *
 * Registered after the approval gate, and handlers run in registration order
 * until one blocks: a call the gate refuses never opens a window, and the
 * "before" snapshot is taken after any human decision rather than before it.
 */
export function commandChangeExtension(state: SessionState): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      await beginToolCall(state, event.toolCallId, event.toolName);
      return undefined;
    });
    // Awaited so the "after" snapshot is taken before Pi moves on; returning
    // nothing leaves the result untouched.
    pi.on("tool_result", async (event) => {
      await endToolCall(state, event.toolCallId);
      return undefined;
    });
  };
}

/** One journal instance per file, so its appends stay serialized. */
const MAX_OPEN_JOURNALS = 256;
const journals = new Map<string, CommandChangeJournal>();

function journalFor(piSessionId: string | undefined): CommandChangeJournal | undefined {
  const path = commandChangeJournalPath(piSessionId);
  if (!path) return undefined;
  let journal = journals.get(path);
  if (journal) {
    // Most recently used last, so eviction drops a session nobody is using.
    journals.delete(path);
  } else {
    journal = new CommandChangeJournal(path);
    if (journals.size >= MAX_OPEN_JOURNALS) {
      const oldest = journals.keys().next();
      if (!oldest.done) journals.delete(oldest.value);
    }
  }
  journals.set(path, journal);
  return journal;
}

/**
 * Put journaled measurements back on a transcript rebuilt from Pi's session
 * file (resume, fork, history navigation), which carries none of them.
 *
 * `inheritFrom` names the Pi session a fork was cut from: the fork's file
 * repeats the parent's tool call ids under a new session id whose journal is
 * empty, so the parent's records are overlaid and copied into the fork's own
 * journal, where a later resume of the fork will look. Never rejects.
 */
export async function overlayCommandChanges(
  state: SessionState,
  options: { inheritFrom?: string } = {},
): Promise<void> {
  try {
    const own = journalFor(state.piSessionId);
    const changes = own ? await own.read() : new Map<string, MeasuredWorkspaceChange>();
    const inherited =
      options.inheritFrom && options.inheritFrom !== state.piSessionId
        ? await journalFor(options.inheritFrom)?.read()
        : undefined;
    for (const [id, change] of inherited ?? []) {
      if (changes.has(id)) continue;
      changes.set(id, change);
    }
    if (changes.size === 0) return;

    let applied = 0;
    const copies: Promise<void>[] = [];
    for (const message of state.messages) {
      for (const part of message.parts) {
        if (part.type !== "tool-invocation") continue;
        const change = changes.get(part.toolUseId);
        if (!change) continue;
        part.commandChanges = change;
        chargeTranscript(state, Buffer.byteLength(JSON.stringify(change)));
        if (own && inherited?.get(part.toolUseId) === change) {
          copies.push(own.append(part.toolUseId, change));
        }
        applied += 1;
      }
    }
    if (applied > 0) state.revision += 1;
    await Promise.all(copies);
  } catch {
    // A lost overlay costs badges, never the resume.
  }
}
