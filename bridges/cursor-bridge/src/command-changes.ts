/**
 * Measured line-change badges for Cursor shell calls.
 *
 * An edit card already says "+N −M" because the SDK reports it. A shell card
 * cannot: `sed -i`, a codemod or `git mv` say nothing about what they wrote,
 * so the worktree is measured around the command instead (see
 * `@orkestrator/protocol/workspace-change-probe`).
 *
 * Cursor has no pre-execution hook — the bridge learns of a command from the
 * interaction stream once it is already running — so windows open in the
 * probe's baseline mode: the "before" is the snapshot {@link
 * CommandChangeTracker} primes at turn start, or the "after" of the previous
 * measured or noted call. Edit tools are noted rather than measured, so an
 * edit between two commands refreshes that baseline instead of being charged
 * to the next command.
 *
 * Durability is the bridge's own persisted transcript: the badge is a field on
 * the part, and `persistence.ts` saves and restores parts verbatim. There is
 * deliberately no id-keyed journal. The only other way a transcript is built
 * is from the SDK's stored conversation (`hydrateHistory`), whose tool-call
 * steps carry no call id — `RunInteractionAccumulator.onTool` keeps only the
 * tool call itself — so a journal keyed by call id would have nothing to match.
 */
import { resolve } from "node:path";
import { hasMeasuredChanges } from "@orkestrator/protocol/command-change-journal";
import { isFileEditToolName } from "@orkestrator/protocol/tool-diff";
import { WorkspaceChangeProbe } from "@orkestrator/protocol/workspace-change-probe";
import { workingDirectory } from "./config.js";
import { schedulePersist } from "./persistence.js";
import { isObject, nonBlank, type JsonObject, type SessionState } from "./state.js";
import { applyCommandChanges } from "./translate.js";

/** The slice of the probe this bridge uses, so a test can stand in for git. */
export type CommandChangeProbe = Pick<
  WorkspaceChangeProbe,
  "prime" | "begin" | "note" | "end" | "discard"
>;

/**
 * Cursor tool kinds that change files by means of their own. `edit` and
 * `write` are in the shared list already; `delete` removes a file outright,
 * which the next command's baseline must not be charged with either.
 */
const CURSOR_FILE_EDIT_TOOLS = new Set(["delete"]);

/**
 * One probe per bridge process, created on first use.
 *
 * Absent under `bun test`, the same way the fatal-rejection guard is inert
 * there: the suites drive real turns through `dispatchPrompt` from inside this
 * repository, and a real probe would snapshot the whole monorepo on every one
 * of them. Tests that exercise this module install a probe of their own.
 */
let probe: CommandChangeProbe | null | undefined =
  process.env.NODE_ENV === "test" ? null : undefined;

function currentProbe(): CommandChangeProbe | undefined {
  if (probe === undefined) probe = new WorkspaceChangeProbe();
  return probe ?? undefined;
}

export function useCommandChangeProbeForTests(next: CommandChangeProbe | null): () => void {
  const previous = probe;
  probe = next;
  return () => {
    probe = previous;
  };
}

export interface CommandChangeTracker {
  /** Baseline must finish before the SDK can execute this turn. */
  ready: Promise<void>;
  /** Feed one interaction update. Synchronous; the measuring runs detached. */
  observe(update: unknown): void;
  /**
   * Drop every window this turn opened and never closed. Cursor can lose a
   * `tool-call-completed`, and a window left open would mark every later
   * command in the repository approximate.
   */
  close(): void;
}

const inertTracker: CommandChangeTracker = {
  ready: Promise.resolve(),
  observe: () => {},
  close: () => {},
};

/**
 * Follow one turn's tool calls and attach what each shell call changed to its
 * card.
 *
 * Only live turns are tracked. A run re-adopted after a restart
 * (`recoverActiveRun`) replays events for commands that ran long before this
 * process could snapshot anything, so measuring them would report whatever the
 * tree did since, not what the command did.
 */
export function trackCommandChanges(state: SessionState): CommandChangeTracker {
  const probe = currentProbe();
  if (!probe) return inertTracker;
  const open = new Set<string>();
  /** A settled call re-reported must not open a second window of nothing. */
  const settled = new Set<string>();
  const safely = (work: Promise<unknown>) => void work.catch(() => undefined);
  const ready = probe.prime(workingDirectory).catch(() => undefined);

  const attach = (callId: string) =>
    safely(
      probe.end(callId).then((change) => {
        if (!change || !hasMeasuredChanges(change) || state.closed) return;
        if (applyCommandChanges(state, callId, change)) schedulePersist();
      }),
    );

  const observe = (update: unknown): void => {
    if (!isObject(update) || !nonBlank(update.type)) return;
    if (update.type === "tool-call-delta") {
      // A sub-agent's calls run in the same worktree as the parent's.
      observe(update.taskUpdate);
      return;
    }
    // `partial-tool-call` is skipped on purpose: its arguments may still be
    // streaming, so its working directory cannot be trusted yet, and in
    // baseline mode opening earlier moves nothing — "before" is the latest
    // snapshot either way.
    if (update.type !== "tool-call-started" && update.type !== "tool-call-completed") return;
    const callId = nonBlank(update.callId) ? update.callId : undefined;
    if (!callId || settled.has(callId)) return;
    const kind = classify(update.toolCall);
    if (!kind) return;

    if (!open.has(callId)) {
      // A completion with no start still measures: the baseline is the tree as
      // it stood after the last call this turn saw, which is what "before"
      // means here anyway. It only loses overlap detection.
      open.add(callId);
      if (kind.measure) safely(probe.begin(kind.cwd, callId, { baseline: true }));
      else safely(probe.note(kind.cwd, callId));
    }
    if (update.type !== "tool-call-completed") return;
    open.delete(callId);
    settled.add(callId);
    if (kind.measure) attach(callId);
    else safely(probe.end(callId));
  };

  return {
    ready,
    observe,
    close: () => {
      for (const callId of open) probe.discard(callId);
      open.clear();
      settled.clear();
    },
  };
}

/** Whether a tool call is measured, noted, or neither — and where it runs. */
function classify(toolCall: unknown): { measure: boolean; cwd: string } | undefined {
  if (!isObject(toolCall) || !nonBlank(toolCall.type)) return undefined;
  const args: JsonObject = isObject(toolCall.args) ? toolCall.args : {};
  if (toolCall.type === "shell") {
    // The typed SDK has no background shell, but the wire payload is an open
    // record. A command that returns while its process keeps running would be
    // measured over a window that has nothing to do with what it writes.
    if (args.isBackground === true || args.runInBackground === true) return undefined;
    const cwd = nonBlank(args.workingDirectory)
      ? resolve(workingDirectory, args.workingDirectory.trim())
      : workingDirectory;
    return { measure: true, cwd };
  }
  if (isFileEditToolName(toolCall.type) || CURSOR_FILE_EDIT_TOOLS.has(toolCall.type)) {
    return { measure: false, cwd: workingDirectory };
  }
  return undefined;
}
