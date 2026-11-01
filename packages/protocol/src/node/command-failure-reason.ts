import type { CommandFailureReason } from "../log-vocabulary/command-failure-reasons.js";

/**
 * Turns a failed command into a fixed-list reason for a log entry. The output is
 * read here and goes no further: what comes back is a label from the vocabulary
 * plus the exit code and signal. docs/architecture/logging.md is the guide.
 *
 * Text matching is locale- and version-dependent, so a reason is a diagnostic
 * hint. Never branch on one; `CommandFailedError`'s structured fields are what
 * control flow reads.
 */

export type CommandFailureTool = "git" | "gh" | "docker" | "tmux";

export interface CommandFailureOptions {
  /**
   * Which tools produced the output, read in this order. A `docker exec` of a git
   * command is `["docker", "git"]`, because git's output and exit code come through
   * the exec. Omitted means every text rule and no tool's exit codes, since those
   * mean different things per tool.
   */
  readonly tools?: readonly CommandFailureTool[];
  /** What an exit code means for this one command, such as `gh pr checks` exiting 8. */
  readonly exitCodes?: Readonly<Record<number, CommandFailureReason>>;
}

export interface CommandFailureFields {
  readonly reason: CommandFailureReason;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

type Rule = readonly [reason: CommandFailureReason, pattern: RegExp];

/** Enough for the head and tail of any real diagnostic, whatever a child wrote. */
const MAX_MATCHED_CHARS = 16 * 1024;
const SIGNAL_PATTERN = /^SIG[A-Z0-9]{1,16}$/;

// Each list is ordered most specific first; the first match wins.
const TOOL_RULES: Readonly<Record<CommandFailureTool, readonly Rule[]>> = {
  git: [
    ["branch-exists", /a branch named .* already exists/i],
    ["ref-conflict", /exists; cannot create|cannot lock ref .* is at .* but expected/i],
    ["lock-held", /could not lock config file [^\n]*: File exists/i],
    ["lock-held", /unable to create '.*\.lock'|cannot lock ref|another git process/i],
    ["worktree-conflict", /already (?:checked out|used by worktree)|used by worktree at/i],
    ["invalid-ref", /not a valid (?:branch name|object name)|bad (?:revision|object)/i],
    ["invalid-ref", /unknown revision|ambiguous argument|invalid reference/i],
    ["branch-not-found", /no branch named|refname .* not found|branch '.*' not found/i],
    ["branch-not-found", /did not match any file\(s\) known to git/i],
    ["dubious-ownership", /detected dubious ownership/i],
    ["no-remote", /does not appear to be a git repository|no such remote/i],
    ["no-remote", /repository (?:.* )?not found/i],
    ["not-a-repository", /not a git repository/i],
    ["remote-ref-missing", /could(?:n't| not) find remote ref|not our ref/i],
    ["merge-conflict", /\bCONFLICT \(|merge conflict|could not apply|unmerged files/i],
    ["dirty-worktree", /local changes .* would be overwritten|commit your changes or stash/i],
    ["nothing-to-commit", /nothing to commit|no changes added to commit/i],
    ["push-rejected", /\[(?:remote )?rejected\]|non-fast-forward/i],
    ["identity-unknown", /please tell me who you are|unable to auto-detect email/i],
  ],
  gh: [
    ["pull-request-exists", /a pull request for branch .* already exists/i],
    ["no-pull-request", /no (?:pull requests? (?:found|match)|open pull requests?\b)/i],
    ["rate-limited", /rate limit|http 429/i],
    ["forbidden", /http 403|resource not accessible/i],
    ["resource-not-found", /http 404|could not resolve to a/i],
    ["server-error", /http 5\d\d/i],
  ],
  docker: [
    ["daemon-unavailable", /cannot connect to the docker daemon|error during connect/i],
    [
      "daemon-unavailable",
      /is the docker daemon running|docker desktop is (?:not running|unable)/i,
    ],
    ["container-not-found", /no such container/i],
    ["container-not-running", /container .* is (?:not running|paused|restarting)/i],
    ["container-name-conflict", /name .* is already in use/i],
    ["image-not-found", /no such image|pull access denied|manifest .* not found/i],
    ["image-not-found", /manifest unknown|repository does not exist/i],
  ],
  tmux: [
    ["session-exists", /duplicate session/i],
    [
      "server-not-running",
      /no server running|failed to connect to server|no sessions|server exited|lost server/i,
    ],
    [
      "server-not-running",
      /error connecting to \/[^\n]* \((?:No such file or directory|Connection refused)\)/i,
    ],
    ["session-not-found", /can't find (?:session|window|pane)|session not found/i],
  ],
};

const ALL_TOOLS = Object.keys(TOOL_RULES) as CommandFailureTool[];

const SHARED_RULES: readonly Rule[] = [
  ["disk-full", /no space left|enospc|disk quota exceeded/i],
  ["auth-failed", /authentication (?:failed|required)|could not read (?:username|password)/i],
  ["auth-failed", /terminal prompts disabled|invalid username or password|bad credentials/i],
  ["auth-failed", /permission denied \(|permission to \S+ denied|host key verification failed/i],
  ["auth-failed", /gh auth login|not logged in|unauthorized|http 401|returned error: 40[13]/i],
  ["network-failed", /could not resolve host|connection (?:timed out|refused|reset)/i],
  ["network-failed", /network is unreachable|no route to host|temporary failure in name/i],
  ["network-failed", /early eof|failed to connect|remote end hung up|unable to access/i],
  ["network-failed", /tls handshake|i\/o timeout/i],
  [
    "network-failed",
    /error connecting to (?:https?:\/\/)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?(?:[\s/:]|$)/i,
  ],
  ["port-in-use", /port is already allocated|address already in use/i],
  ["permission-denied", /permission denied|operation not permitted|read-only file system/i],
  ["command-not-found", /command not found/i],
  ["path-not-found", /no such file or directory/i],
  ["invalid-usage", /^usage: |unknown (?:option|flag|command|shorthand flag)|invalid option/im],
];

const TOOL_EXIT_CODES: Readonly<
  Record<CommandFailureTool, Readonly<Record<number, CommandFailureReason>>>
> = {
  git: { 129: "invalid-usage" },
  gh: { 2: "aborted", 4: "auth-failed" },
  docker: { 125: "daemon-error" },
  tmux: {},
};

/** Meant the same whichever program a shell or `timeout(1)` was wrapping. */
const SHARED_EXIT_CODES: Readonly<Record<number, CommandFailureReason>> = {
  124: "timed-out",
  126: "not-executable",
  127: "command-not-found",
  137: "killed",
  143: "killed",
};

function read(target: object, key: string): unknown {
  return (target as Record<string, unknown>)[key];
}

function boundedForMatching(text: string): string {
  if (text.length <= MAX_MATCHED_CHARS) return text;
  // The cause is usually at the end, and the start names what was being done.
  const half = MAX_MATCHED_CHARS / 2;
  return `${text.slice(0, half)}\n${text.slice(-half)}`;
}

/**
 * The text to match. `CommandFailedError`'s message is already stderr, or stdout
 * when stderr was empty. A first line of "Command failed: <argv>" is dropped,
 * because a branch or file named after an error must not read as that error.
 */
function failureText(error: object): string {
  const stderr = read(error, "stderr");
  if (Buffer.isBuffer(stderr) && stderr.length > 0) {
    return boundedForMatching(stderr.subarray(-MAX_MATCHED_CHARS).toString());
  }
  if (typeof stderr === "string" && stderr.length > 0) return boundedForMatching(stderr);
  const message = read(error, "message");
  if (typeof message !== "string") return "";
  return boundedForMatching(
    message.startsWith("Command failed") ? message.split("\n").slice(1).join("\n") : message,
  );
}

/** An `fs` ENOENT passed here is a missing file, not a program that never started. */
function isRawSpawnEnoent(error: object): boolean {
  const syscall = read(error, "syscall");
  return (
    read(error, "code") === "ENOENT" && typeof syscall === "string" && syscall.startsWith("spawn")
  );
}

function classifiedReason(
  error: object,
  exitCode: number | null,
  signal: string | null,
  options: CommandFailureOptions,
): CommandFailureReason {
  if (read(error, "aborted") === true) return "aborted";
  if (read(error, "outputLimitExceeded") === true) return "output-too-large";
  if (read(error, "timedOut") === true) return "timed-out";
  if (read(error, "executableMissing") === true || isRawSpawnEnoent(error)) {
    return "executable-missing";
  }
  const named = exitCode === null ? undefined : options.exitCodes?.[exitCode];
  if (named) return named;
  // A process a signal ended never explained itself; its last output is not why.
  if (signal) return "killed";

  const text = failureText(error);
  for (const tool of options.tools ?? ALL_TOOLS) {
    for (const [reason, pattern] of TOOL_RULES[tool]) {
      if (pattern.test(text)) return reason;
    }
  }
  for (const [reason, pattern] of SHARED_RULES) {
    if (pattern.test(text)) return reason;
  }

  if (exitCode !== null) {
    for (const tool of options.tools ?? []) {
      const reason = TOOL_EXIT_CODES[tool][exitCode];
      if (reason) return reason;
    }
    const reason = SHARED_EXIT_CODES[exitCode];
    if (reason) return reason;
  }
  return "unclassified";
}

function numericExitCode(error: object): number | null {
  for (const key of ["exitCode", "code"]) {
    const value = read(error, key);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Spread the result into a log entry's fields, inside the fields function so a
 * level that is off matches nothing. Never throws, and never returns output.
 */
export function classifyCommandFailure(
  error: unknown,
  options: CommandFailureOptions = {},
): CommandFailureFields {
  if (typeof error !== "object" || error === null) {
    return { reason: "unclassified", exitCode: null, signal: null };
  }
  try {
    const exitCode = numericExitCode(error);
    const rawSignal = read(error, "signal");
    const signal =
      typeof rawSignal === "string" && SIGNAL_PATTERN.test(rawSignal) ? rawSignal : null;
    return { reason: classifiedReason(error, exitCode, signal, options), exitCode, signal };
  } catch {
    return { reason: "unclassified", exitCode: null, signal: null };
  }
}
