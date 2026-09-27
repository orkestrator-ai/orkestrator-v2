/**
 * Measured "+N −M" badges for shell tool calls.
 *
 * An ACP `execute` call says nothing reliable about what it writes, so the
 * bridge measures the worktree around it with the shared
 * `WorkspaceChangeProbe` and stamps the result on the part as
 * `commandChanges`. The renderer shows it beside the command the way it shows
 * an edit row's counts.
 *
 * ACP only tells the client about a call once the agent has started it: Grok
 * runs with `--always-approve`, so there is no permission round-trip to hold
 * the command behind. Every window therefore opens in baseline mode — `prime`
 * snapshots the worktree as a turn is dispatched, and each command's "before"
 * is the latest snapshot rather than one taken after the command may already
 * have written. Edit-kind calls are noted, not measured, so a command running
 * alongside one is marked approximate and the baseline moves past the edit.
 *
 * The measurement exists only in this process, so it is appended to a
 * per-session journal next to `state.json` and laid back over the transcript
 * when `session/load` rebuilds it from the vendor's replay.
 *
 * Nothing here runs on the JSON-RPC read loop beyond bookkeeping: every probe
 * call is fired and forgotten with a rejection handler, and a measurement lands
 * through the same commit path as any other tool update.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  CommandChangeJournal,
  hasMeasuredChanges,
  parseMeasuredWorkspaceChange,
} from "@orkestrator/protocol/command-change-journal";
import { isFileEditToolName, type MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { WorkspaceChangeProbe } from "@orkestrator/protocol/workspace-change-probe";
import {
  MAX_RESUMABLE_SESSIONS,
  acpToolSourceStates,
  sessions,
  stateDirectory,
  workingDirectory,
  type AcpToolSourceState,
  type BridgeToolPart,
  type SessionState,
} from "./acp-context.js";
import {
  commitToolPartMutation,
  ensureAcpToolSource,
  findToolPart,
  renderAcpToolSource,
} from "./acp-tools.js";

/** The slice of the probe this bridge drives; a test substitutes its own. */
export type CommandChangeProbe = Pick<
  WorkspaceChangeProbe,
  "begin" | "note" | "end" | "discard" | "prime"
>;

/**
 * - `eligible`: started in front of this process, not yet classifiable (Grok
 *   can name the tool only in a later `tool_call_update`);
 * - `measure` / `note`: a probe window is open;
 * - `skip`: turned out to be a background launch; never measured.
 */
type WindowRole = "eligible" | "measure" | "note" | "skip";

/**
 * Tool names that run a shell command, for agents that do not set the
 * standard `execute` kind. Grok's is `run_terminal_cmd` (`run_terminal_command`
 * in its docs); the rest are the names other ACP agents use.
 */
const SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "terminal",
  "run_terminal_cmd",
  "run_terminal_command",
  "run_command",
  "execute_command",
]);
/** ACP tool kinds that change files by some means other than a command. */
const FILE_CHANGE_KINDS = new Set(["edit", "delete", "move"]);
/** Grok's own file tools, which the shared edit-name list does not know. */
const FILE_CHANGE_TOOL_NAMES = new Set(["search_replace", "write_file", "delete_file"]);
/**
 * Open windows per session. A call whose end never arrives (a lost frame, a
 * killed child) would otherwise sit here for the life of the session.
 */
const MAX_WINDOWS_PER_SESSION = 256;
/** Journals cached at once; one per ACP session id this process has touched. */
const MAX_CACHED_JOURNALS = MAX_RESUMABLE_SESSIONS;

/** `undefined` until first use; `null` when measurement is switched off. */
let probe: CommandChangeProbe | null | undefined;
let journalDirectory: string | null = stateDirectory
  ? resolve(stateDirectory, "command-changes")
  : null;
const journals = new Map<string, CommandChangeJournal>();
const windowsBySession = new WeakMap<SessionState, Map<string, WindowRole>>();

/**
 * Replace the probe or the journal directory. The bridge's own defaults come
 * from the environment; in-process tests inject a fake probe and a scratch
 * directory here instead of mutating the environment other suites share.
 */
export function configureCommandChanges(options: {
  probe?: CommandChangeProbe | null;
  journalDirectory?: string | null;
}): void {
  if ("probe" in options) probe = options.probe ?? null;
  if ("journalDirectory" in options) {
    journalDirectory = options.journalDirectory ?? null;
    journals.clear();
  }
}

/**
 * `ACP_MEASURE_COMMAND_CHANGES=0` switches measurement off. The test harness
 * sets it so fixture commands do not snapshot the repository the suite runs
 * in; it doubles as a kill switch should the probe ever misbehave in the field.
 */
function commandChangeProbe(): CommandChangeProbe | null {
  if (probe === undefined) {
    const setting = process.env.ACP_MEASURE_COMMAND_CHANGES?.trim().toLowerCase();
    probe =
      setting === "0" || setting === "false" || setting === "off"
        ? null
        : new WorkspaceChangeProbe();
  }
  return probe;
}

/**
 * Take the turn's baseline snapshot. Called as a turn is dispatched; never
 * awaited, because the prompt must not wait on `git`.
 */
export function primeCommandChanges(): void {
  const active = commandChangeProbe();
  if (active) void active.prime(workingDirectory).catch(() => undefined);
}

function probeCallId(state: SessionState, toolUseId: string): string {
  // Vendor tool ids are only unique within one ACP session, and the probe is
  // shared by every session in this process.
  return `${state.id}\u0000${toolUseId}`;
}

function toolNames(source: AcpToolSourceState): string[] {
  return [source.explicitName, source.inputName, source.metadataName].flatMap((name) => {
    const normalized = name?.trim().toLowerCase();
    return normalized ? [normalized] : [];
  });
}

/**
 * A command that returns as soon as it has started something that keeps
 * running. Its window would close long before the process stops writing, so a
 * count would be both partial and misleading.
 */
function isBackgroundLaunch(args: AcpToolSourceState["toolArgs"]): boolean {
  return (
    args?.background === true ||
    args?.run_in_background === true ||
    args?.is_background === true ||
    args?.isBackground === true
  );
}

/** Whether a call should be measured, noted, or left alone. */
export function commandChangeRole(source: AcpToolSourceState): "measure" | "note" | undefined {
  const kind = source.kind?.trim().toLowerCase();
  const names = toolNames(source);
  if (kind === "execute" || names.some((name) => SHELL_TOOL_NAMES.has(name))) {
    return isBackgroundLaunch(source.toolArgs) ? undefined : "measure";
  }
  if (
    (kind !== undefined && FILE_CHANGE_KINDS.has(kind)) ||
    names.some((name) => isFileEditToolName(name) || FILE_CHANGE_TOOL_NAMES.has(name)) ||
    source.contentDiffs.length > 0
  ) {
    return "note";
  }
  return undefined;
}

function windowsFor(state: SessionState): Map<string, WindowRole> {
  let windows = windowsBySession.get(state);
  if (!windows) {
    windows = new Map();
    windowsBySession.set(state, windows);
  }
  return windows;
}

function isSettled(part: BridgeToolPart): boolean {
  return part.toolState === "success" || part.toolState === "failure";
}

/**
 * Follow one live tool update. `isInitial` is true for a `tool_call` frame:
 * only a call that starts in front of this process gets a window, so a late
 * update for a call restored from disk cannot charge it with whatever changed
 * since the last snapshot.
 */
export function trackCommandChangeWindow(
  state: SessionState,
  part: BridgeToolPart,
  isInitial: boolean,
): void {
  if (state.historyReplay !== false) return;
  const active = commandChangeProbe();
  if (!active) return;
  const source = acpToolSourceStates.get(part);
  if (!source) return;

  const windows = windowsFor(state);
  const toolUseId = part.toolUseId;
  let role = windows.get(toolUseId);
  if (role === undefined) {
    if (!isInitial) return;
    role = "eligible";
    while (windows.size >= MAX_WINDOWS_PER_SESSION) {
      const oldest = windows.entries().next().value;
      if (!oldest) break;
      windows.delete(oldest[0]);
      if (oldest[1] === "measure" || oldest[1] === "note") {
        active.discard(probeCallId(state, oldest[0]));
      }
    }
    windows.set(toolUseId, role);
  }

  const key = probeCallId(state, toolUseId);
  const wanted = commandChangeRole(source);
  if (role === "eligible" && wanted) {
    role = wanted;
    windows.set(toolUseId, role);
    if (role === "measure") {
      void active.begin(workingDirectory, key, { baseline: true }).catch(() => undefined);
    } else {
      void active.note(workingDirectory, key).catch(() => undefined);
    }
  } else if (role === "measure" && wanted !== "measure") {
    // The arguments that mark a background launch can arrive after the call
    // was first seen as a plain command.
    active.discard(key);
    role = "skip";
    windows.set(toolUseId, role);
  }

  if (source.toolState === "success" || source.toolState === "failure") {
    windows.delete(toolUseId);
    closeWindow(active, state, toolUseId, role);
  }
}

/**
 * Close the windows of calls the turn's end settled without a terminal frame
 * (`reconcileStaleToolParts`), or whose parts are gone. A call still running —
 * a background sub-agent's child, say — keeps its window.
 */
export function settleCommandChangeWindows(state: SessionState): void {
  const windows = windowsBySession.get(state);
  const active = probe;
  if (!windows || !active) return;
  for (const [toolUseId, role] of Array.from(windows)) {
    const found = findToolPart(state, toolUseId);
    if (found && !isSettled(found.part)) continue;
    windows.delete(toolUseId);
    closeWindow(active, state, toolUseId, role);
  }
}

function closeWindow(
  active: CommandChangeProbe,
  state: SessionState,
  toolUseId: string,
  role: WindowRole,
): void {
  const key = probeCallId(state, toolUseId);
  if (role === "note") {
    // Ending a noted window refreshes the baseline past the edit.
    void active.end(key).catch(() => undefined);
    return;
  }
  if (role !== "measure") return;
  void active
    .end(key)
    .then((change) => recordCommandChange(state, toolUseId, change))
    .catch((error: unknown) => {
      console.warn(
        `[acp-bridge] Failed to record a measured command change: ${
          error instanceof Error ? error.name : "unknown error"
        }`,
      );
    });
}

/**
 * Journal a measurement and stamp it on the call's part. The part is found
 * again by id rather than held from the start: a trim or a close may have
 * removed it meanwhile, and the journal still lets a later reload show it.
 */
export function recordCommandChange(
  state: SessionState,
  toolUseId: string,
  change: MeasuredWorkspaceChange | undefined,
): void {
  if (!change || !hasMeasuredChanges(change)) return;
  // The part gets the journal's bounds too, so the badge a live tab shows is
  // the one a restart or a reload restores.
  const bounded = parseMeasuredWorkspaceChange(change);
  if (!bounded) return;
  void journalFor(state.acpSessionId)?.append(toolUseId, bounded);
  if (sessions.get(state.id) !== state) return;
  const found = findToolPart(state, toolUseId);
  if (!found) return;
  const source = ensureAcpToolSource(found.part);
  source.commandChanges = bounded;
  renderAcpToolSource(found.part, source);
  // Bumps the revision the clients poll and schedules the state-file write.
  commitToolPartMutation(state, found.part, source);
}

/**
 * Lay journaled measurements back over a transcript `session/load` rebuilt
 * from the vendor's replay, which knows nothing of them. Parts are matched by
 * the vendor's tool call id, nested sub-agent calls included (ACP keeps them
 * flat, tagged with `parentTaskUseId`). Returns whether any part changed.
 */
export async function applyJournaledCommandChanges(state: SessionState): Promise<boolean> {
  const journal = journalFor(state.acpSessionId);
  if (!journal) return false;
  const changes = await journal.read().catch(() => new Map<string, MeasuredWorkspaceChange>());
  if (changes.size === 0) return false;
  let applied = false;
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-invocation" || part.commandChanges) continue;
      const change = changes.get(part.toolUseId);
      if (!change) continue;
      const source = ensureAcpToolSource(part);
      source.commandChanges = change;
      renderAcpToolSource(part, source);
      if (!commitToolPartMutation(state, part, source)) return applied;
      applied = true;
    }
  }
  return applied;
}

/**
 * One journal per ACP session id, the id `session/load` resumes by, so a
 * journal outlives the bridge session that wrote it. Closing or deleting a tab
 * keeps the vendor conversation (see the `DELETE` route), so the journal is
 * kept too; it is bounded by `CommandChangeJournal` itself.
 */
function journalFor(acpSessionId: string): CommandChangeJournal | undefined {
  if (!journalDirectory || !acpSessionId) return undefined;
  // Vendor ids are not ours to trust as file names.
  const name = createHash("sha256").update(acpSessionId).digest("hex").slice(0, 40);
  const path = resolve(journalDirectory, `${name}.jsonl`);
  let journal = journals.get(path);
  if (journal) {
    journals.delete(path);
  } else {
    journal = new CommandChangeJournal(path);
    // Least recently used first. An evicted instance finishes its queued
    // writes; only a write racing a fresh instance for the same file could
    // interleave, and a lost record costs one badge.
    while (journals.size >= MAX_CACHED_JOURNALS) {
      const oldest = journals.keys().next().value;
      if (oldest === undefined) break;
      journals.delete(oldest);
    }
  }
  journals.set(path, journal);
  return journal;
}
