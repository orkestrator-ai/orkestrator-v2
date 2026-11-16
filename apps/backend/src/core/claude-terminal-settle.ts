import { runCommand } from "./shell.js";

/**
 * Settling a container terminal Claude turn that no hook will ever end
 * (to-do 8092).
 *
 * Terminal Claude reports its state only through the hooks the image installs
 * (`UserPromptSubmit` writes `working`, `Stop` and `StopFailure` end the turn).
 * Two ends have no hook:
 *
 * - After a refused login the CLI considers itself signed out and answers the
 *   next prompt "Not logged in · Please run /login" locally, with no model
 *   request and no `Stop` or `StopFailure`.
 * - The tab running Claude is closed mid-turn: the shell and Claude are ended,
 *   and nothing writes the state file again.
 *
 * Either way `/tmp/.claude-state` keeps `working`. The poll settles it by
 * rewriting the snapshot itself, compare-and-set against the exact `working`
 * snapshot it observed, so a prompt submitted meanwhile is never overwritten.
 * The rewrite bumps the revision like a hook, which keeps the result durable
 * across tab closes and backend restarts, and the ordinary read then persists
 * it and rings (or deliberately does not ring) the bell.
 */

/**
 * The notices the pinned CLI prints, as an API-error row, for a prompt it
 * refuses locally because it has no usable credential. Fixed CLI text: a
 * wording change silently disables the check, so the canary test in
 * `claude-terminal-settle.test.ts` reads them out of the pinned CLI binary.
 */
export const CLAUDE_SIGN_IN_NOTICES = [
  "Not logged in · Please run /login",
  "Authentication required · Sign in again to continue",
] as const;

/**
 * How long a terminal must print nothing after the notice before its turn is
 * settled. Only prompt-box punctuation and the fixed CLI footer may follow the notice: a static
 * permission dialog or other visible content invalidates the candidate.
 * Quoted notice text alone is still ambiguous; this remains a narrow heuristic.
 */
export const CLAUDE_SIGN_IN_NOTICE_QUIET_MS = 3_000;
/** Cadence of the in-memory output check while a turn reads `working`. */
export const CLAUDE_SIGN_IN_NOTICE_CHECK_MS = 1_000;
export const CLAUDE_STATE_SETTLE_TIMEOUT_MS = 5_000;

/** Normalized text carried between checks, so a notice split across chunks still matches. */
const NOTICE_TAIL_CHARS = 128;

/**
 * Terminal output reduced to its visible letters: escape sequences, control
 * characters and whitespace removed, lower-cased. The CLI's renderer may move
 * the cursor instead of printing spaces and wrap a line anywhere, so the
 * notice is matched without either.
 */
export function normalizeTerminalText(text: string): string {
  return (
    text
      // OSC (title, hyperlinks), terminated by BEL or ST.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
      // CSI, including private and intermediate bytes.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // Remaining two- and three-byte escapes (charset selection, save/restore cursor).
      .replace(/\x1b[ -/]*[0-~]/g, "")
      .replace(/[\s\x00-\x1f\x7f]/g, "")
      .toLowerCase()
  );
}

const NORMALIZED_NOTICES = CLAUDE_SIGN_IN_NOTICES.map(normalizeTerminalText);

export function containsSignInNotice(normalized: string): boolean {
  return NORMALIZED_NOTICES.some((notice) => normalized.includes(notice));
}

/** What the watch needs from the backend's container terminals (`TerminalRuntime`). */
export interface ClaudeTerminalScreens {
  /** Live terminals whose shell runs in this container. */
  containerSessionIds(containerId: string): string[];
  /** The session's output revision; 0 or undefined before any output. */
  outputRevision(sessionId: string): number | undefined;
  /** Retained output chunks, oldest first, each with its revision. */
  retainedOutputDeltas(sessionId: string): readonly { revision: number; text: string }[];
}

/** The output revision of every live terminal in the container, now. */
export function terminalOutputMarks(
  screens: ClaudeTerminalScreens,
  containerId: string,
): Map<string, number> {
  const marks = new Map<string, number>();
  for (const id of screens.containerSessionIds(containerId)) {
    marks.set(id, screens.outputRevision(id) ?? 0);
  }
  return marks;
}

/** Prompt chrome and the CLI's completed-turn duration line, after normalization. */
function stripPromptGlyphs(text: string): string {
  return text.replace(/[❯>─━│┃┌┐└┘╭╮╰╯⏵▶▸»]/g, "");
}

function onlyPromptRedraw(text: string): boolean {
  return (
    stripPromptGlyphs(text)
      .replaceAll("bypasspermissionson(shift+tabtocycle)", "")
      .replaceAll("notloggedin·run/login", "")
      .replace(/[✻*][a-z]+for(?:[0-9]+[hms])+·done[0-9]{1,2}:[0-9]{2}(?:am|pm)/g, "") === ""
  );
}

type SessionCursor = { revision: number; tail: string; changedAt: number; notice: boolean };

/**
 * Watches one `working` snapshot for the CLI's sign-in notice in any of the
 * container's terminals, printed after `marks` (the output each terminal had
 * when the poll last read a state that was not `working`). Content-free: it
 * keeps only a short normalized tail per terminal and answers a boolean.
 */
export class SignInNoticeWatch {
  private readonly cursors = new Map<string, SessionCursor>();

  constructor(
    readonly revision: number,
    readonly completions: number,
    marks: ReadonlyMap<string, number>,
    nowMs: number,
  ) {
    for (const [id, revision] of marks) {
      this.cursors.set(id, { revision, tail: "", changedAt: nowMs, notice: false });
    }
  }

  /** Consumed positions, without carrying notice evidence to a new turn. */
  outputMarks(): Map<string, number> {
    return new Map(Array.from(this.cursors, ([id, cursor]) => [id, cursor.revision]));
  }

  /**
   * Whether a terminal printed the notice since the marks and has been quiet
   * for {@link CLAUDE_SIGN_IN_NOTICE_QUIET_MS} since its last output.
   */
  refused(screens: ClaudeTerminalScreens, containerId: string, nowMs: number): boolean {
    let refused = false;
    for (const id of screens.containerSessionIds(containerId)) {
      let cursor = this.cursors.get(id);
      if (!cursor) {
        // A terminal opened after the marks: everything it printed is new.
        cursor = { revision: 0, tail: "", changedAt: nowMs, notice: false };
        this.cursors.set(id, cursor);
      }
      const current = screens.outputRevision(id) ?? 0;
      if (current !== cursor.revision) {
        let text = "";
        for (const delta of screens.retainedOutputDeltas(id)) {
          if (delta.revision > cursor.revision) text = (text + delta.text).slice(-64 * 1024);
        }
        const normalized = cursor.tail + normalizeTerminalText(text);
        const noticeEnd = Math.max(
          ...NORMALIZED_NOTICES.map((notice) => {
            const at = normalized.lastIndexOf(notice);
            return at < 0 ? -1 : at + notice.length;
          }),
        );
        // Keep the whole bounded suffix, including partial redraws. Arbitrary
        // later text remains disqualifying; it must not disappear as tails roll.
        if (noticeEnd >= 0) {
          cursor.notice = true;
          cursor.tail = stripPromptGlyphs(normalized.slice(noticeEnd));
        } else {
          cursor.tail = cursor.notice ? stripPromptGlyphs(normalized) : normalized;
        }
        if (cursor.tail.length > NOTICE_TAIL_CHARS) {
          cursor.notice = false;
          cursor.tail = cursor.tail.slice(-NOTICE_TAIL_CHARS);
        }
        cursor.revision = current;
        cursor.changedAt = nowMs;
      }
      if (
        cursor.notice &&
        onlyPromptRedraw(cursor.tail) &&
        nowMs - cursor.changedAt >= CLAUDE_SIGN_IN_NOTICE_QUIET_MS
      ) {
        refused = true;
      }
    }
    return refused;
  }
}

/** The word a settle writes: `failed` for a refused prompt, `idle` for a closed tab. */
export type ClaudeStateSettleTarget = "failed" | "idle";

/** Rewrites a `working` snapshot the poll observed; true when it did. */
export type ClaudeStateSettler = (
  containerId: string,
  expected: { revision: number; completions: number },
  target: ClaudeStateSettleTarget,
) => Promise<boolean>;

/**
 * Compare-and-set over the snapshot `orkestrator-state-signal` writes, under
 * the same lock and in the same format, so a hook and a settle serialize. It
 * writes only when the snapshot is still exactly `working <revision>
 * <completions>`; it prints `settled` when it wrote and nothing otherwise,
 * and always exits 0 so a moved-on snapshot is not an error.
 * `ORKESTRATOR_STATE_FILE` overrides the path for tests, as in the hook script.
 */
export const CLAUDE_STATE_SETTLE_SCRIPT = `state_file="\${ORKESTRATOR_STATE_FILE:-/tmp/.claude-state}"
snapshot="\${state_file}-snapshot"
case "$3" in failed|idle) ;; *) exit 0 ;; esac
case "$1:$2" in *[!0-9:]*|:*|*:) exit 0 ;; esac
(
  flock -w 1 9 || exit 0
  [ -f "$snapshot" ] || exit 0
  read -r previous revision completions < "$snapshot" || exit 0
  [ "$previous $revision $completions" = "working $1 $2" ] || exit 0
  revision=$((revision + 1))
  tmp="$snapshot.settle.$$"
  trap 'rm -f "$tmp"' EXIT
  printf '%s %s %s\\n' "$3" "$revision" "$completions" > "$tmp" || exit 0
  mv -f "$tmp" "$snapshot" || exit 0
  printf 'idle\\n' > "$state_file"
  printf 'settled'
) 9>"\${snapshot}.lock"
exit 0`;

/** The `docker exec` that runs {@link CLAUDE_STATE_SETTLE_SCRIPT}; numbers only in argv. */
export function claudeStateSettleCommand(
  containerId: string,
  expected: { revision: number; completions: number },
  target: ClaudeStateSettleTarget,
): { command: string; args: string[]; options: { timeoutMs: number } } {
  for (const value of [expected.revision, expected.completions]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid state snapshot");
  }
  return {
    command: "docker",
    args: [
      "exec",
      containerId,
      "sh",
      "-c",
      CLAUDE_STATE_SETTLE_SCRIPT,
      "sh",
      String(expected.revision),
      String(expected.completions),
      target,
    ],
    options: { timeoutMs: CLAUDE_STATE_SETTLE_TIMEOUT_MS },
  };
}

/** Runs the settle in the container as the image's user, who owns the state files. */
export const dockerClaudeStateSettler: ClaudeStateSettler = async (
  containerId,
  expected,
  target,
) => {
  const { command, args, options } = claudeStateSettleCommand(containerId, expected, target);
  return (await runCommand(command, args, options)).stdout.trim() === "settled";
};

/**
 * The settler the backend builds its Claude state polls with (`index.ts`).
 * Docker-backed, so unit tests keep the polls read-only unless they inject one.
 */
export function backendClaudeStateSettler(): ClaudeStateSettler | undefined {
  return process.env.NODE_ENV === "test" ? undefined : dockerClaudeStateSettler;
}
