/**
 * `terminals` commands (plan item 7002): container and local PTY sessions
 * (create, start, input, resize, output recovery, close), backend-owned
 * terminal jobs, and the composer's `!` user commands with the prompts they
 * wait on.
 *
 * Argument schemas declare every key the handler reads and decode tolerantly
 * (§11.4). A key the handler required with `asString` is `Schema.String`
 * (same "Expected sessionId to be a string" text); a key it reads leniently
 * (`asTerminalDimension`, `asOptionalString`, `asBoolean` with a fallback) or
 * checks with its own message stays `optionalKey(Unknown)`, so nothing an
 * older client sends is refused. Fields are listed in the order the handler
 * checks them, because a decode reports the first failure.
 *
 * `hotPath` marks terminal input, resize and output reads: a renderer's
 * domain client skips decoding their results in production
 * (`validateHotPathResults`), and the backend validates results only in
 * development and tests, so the keystroke path gains no per-call result
 * validation. The terminal WebSocket protocol (subprotocol list and `ready`
 * features) is separate and unchanged.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { terminalsDomain } from "./domain.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A PTY session created (or found) for a stable terminal key. */
export const TerminalSessionCreateResultSchema = Schema.Struct({
  sessionId: Schema.String,
  created: Schema.Boolean,
  // Absent from a backend one release older (the web reads it as `false`).
  bootstrapped: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "TerminalSessionCreateResult" });

/**
 * A PTY input or resize answer. `delivered: false` is the in-band refusal for
 * a session whose PTY is gone; older backends answered nothing.
 */
export const TerminalDeliveryResultSchema = Schema.UndefinedOr(
  Schema.NullOr(Schema.Struct({ delivered: Schema.Boolean })),
).annotate({ identifier: "TerminalDeliveryResult" });

/**
 * A resize answer. `delivered` keeps the input answer's meaning (the PTY is
 * there); `applied` says whether the dimensions were set, which they are not
 * when another client owns the terminal's size, and `owned` whether the caller
 * owns it now. Older backends answered `delivered` alone, or nothing.
 */
export const TerminalResizeResultSchema = Schema.UndefinedOr(
  Schema.NullOr(
    Schema.Struct({
      delivered: Schema.Boolean,
      applied: Schema.optionalKey(Schema.Boolean),
      owned: Schema.optionalKey(Schema.Boolean),
    }),
  ),
).annotate({ identifier: "TerminalResizeResult" });

export const TerminalOutputDeltaSchema = Schema.Struct({
  revision: Schema.Finite,
  text: Schema.String,
});

/** The retained output of a session, whole or since a known revision. */
export const TerminalOutputSnapshotSchema = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["full", "delta"])),
  reason: Schema.optionalKey(Schema.Literals(["expired", "generation-changed"])),
  output: Schema.String,
  // The delta's revision boundaries (the WebSocket gateway replays them).
  deltas: Schema.optionalKey(Schema.Array(TerminalOutputDeltaSchema)),
  revision: NonNegativeInt,
  generation: NonNegativeInt,
  // Absent from older desktop backends (read as `false`).
  truncated: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "TerminalOutputSnapshot" });

/** `TerminalStateSnapshot` (`@orkestrator/protocol/terminal-history`). */
export const TerminalStateSnapshotSchema = Schema.Struct({
  formatVersion: Schema.Literal(1),
  mode: Schema.Literal("state"),
  output: Schema.String,
  pendingOutput: Schema.String,
  generation: NonNegativeInt,
  revision: NonNegativeInt,
  historyId: Schema.String,
  incarnation: Schema.String,
  cols: Schema.Int,
  rows: Schema.Int,
  earliestSequence: NonNegativeInt,
  latestSequence: NonNegativeInt,
  historyTruncated: Schema.Boolean,
  historyGap: Schema.Boolean,
  completed: Schema.Boolean,
}).annotate({ identifier: "TerminalStateSnapshot" });

/** `TerminalHistoryPage` (`@orkestrator/protocol/terminal-history`). */
export const TerminalHistoryPageSchema = Schema.Struct({
  formatVersion: Schema.Literal(1),
  historyId: Schema.String,
  rows: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  previousCursor: Schema.NullOr(Schema.String),
  earliestAvailable: Schema.Boolean,
  historyTruncated: Schema.Boolean,
  historyGap: Schema.Boolean,
}).annotate({ identifier: "TerminalHistoryPage" });

/** `HumanPrompt` (`@orkestrator/protocol/human-prompts`). */
export const HumanPromptSchema = Schema.Struct({
  kind: Schema.Literals(["sign-in", "device-code", "press-enter", "secret", "host-key"]),
  url: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  wantsEnter: Schema.Boolean,
  text: Schema.String,
  key: Schema.String,
}).annotate({ identifier: "HumanPrompt" });

/** `UserCommandRecord` (`@orkestrator/protocol/user-commands`). */
export const UserCommandRecordSchema = Schema.Struct({
  id: Schema.String,
  environmentId: Schema.String,
  tabId: Schema.String,
  command: Schema.String,
  target: Schema.Literals(["worktree", "container", "project-checkout"]),
  cwd: Schema.String,
  status: Schema.Literals(["running", "exited", "cancelled", "failed"]),
  exitCode: Schema.optionalKey(Schema.Finite),
  error: Schema.optionalKey(Schema.String),
  startedAt: Schema.String,
  endedAt: Schema.optionalKey(Schema.String),
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  prompt: Schema.optionalKey(HumanPromptSchema),
  context: Schema.Union([
    Schema.Struct({ state: Schema.Literal("pending") }),
    Schema.Struct({
      state: Schema.Literal("delivered"),
      requestId: Schema.String,
      at: Schema.String,
    }),
  ]),
  revision: Schema.Finite,
}).annotate({ identifier: "UserCommandRecord" });

/** `HumanPromptEntry` (`@orkestrator/protocol/human-prompts`). */
export const HumanPromptEntrySchema = Schema.Struct({
  id: Schema.String,
  environmentId: Schema.String,
  tabId: Schema.String,
  source: Schema.Literals(["user-command", "agent-tool", "agent-background-task"]),
  userCommandId: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  prompt: HumanPromptSchema,
  since: Schema.String,
}).annotate({ identifier: "HumanPromptEntry" });

const sessionArgs = Schema.Struct({ sessionId: Schema.String });
const writeArgs = Schema.Struct({ sessionId: Schema.String, data: Schema.String });
// Dimensions fall back to 80x24 (`asTerminalDimension`), so any value is accepted.
// `clientId` names the window for size ownership (`terminal-size-ownership.ts`):
// read leniently, so a malformed id reads as a client that sent none rather
// than refusing the resize. An older backend ignores it and applies every
// resize, as it always did.
const resizeArgs = Schema.Struct({
  sessionId: Schema.String,
  cols: optionalUnknown,
  rows: optionalUnknown,
  clientId: optionalUnknown,
});

// --- Terminal jobs ---

/** Opens (or finds) a backend-owned terminal job's tab and starts its session. */
export const launchTerminalJobCommand = defineCommand({
  domain: terminalsDomain,
  name: "launch_terminal_job",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    requestId: Schema.String,
    tabId: optionalUnknown,
    tabType: Schema.String,
    title: optionalUnknown,
    // Required for a new job of every tab type but `claude-tmux`, checked by the
    // handler. Omitted with a `tabId`, that tab gets a shell that runs
    // nothing (Reconnect after the backend that owned the old shell restarted);
    // the tab must still be open, or the launch is refused rather than reopening it.
    data: optionalUnknown,
    initialPrompt: optionalUnknown,
    model: optionalUnknown,
    reasoningEffort: optionalUnknown,
    fastMode: optionalUnknown,
    activateTab: optionalUnknown,
  }),
  result: Schema.Struct({
    jobId: Schema.String,
    environmentId: Schema.String,
    tabId: Schema.String,
    tabType: Schema.String,
    sessionId: Schema.optionalKey(Schema.String),
    status: Schema.Literal("started"),
  }),
  // requestId: the job's identity (its id and tab are derived from it); a
  // receiver ignoring it would start a second job for a retried request.
  critical: ["requestId"],
});

// --- Container terminals ---

export const createTerminalSessionCommand = defineCommand({
  domain: terminalsDomain,
  name: "create_terminal_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    containerId: Schema.String,
    environmentId: optionalUnknown,
    terminalKey: optionalUnknown,
    cols: optionalUnknown,
    rows: optionalUnknown,
    user: optionalUnknown,
    trackEnvironmentActivity: optionalUnknown,
  }),
  result: TerminalSessionCreateResultSchema,
  critical: [],
});

export const startTerminalSessionCommand = defineCommand({
  domain: terminalsDomain,
  name: "start_terminal_session",
  since: 1,
  access: "workspace",
  read: false,
  args: sessionArgs,
  result: Schema.Void,
  critical: [],
});

export const terminalWriteCommand = defineCommand({
  domain: terminalsDomain,
  name: "terminal_write",
  since: 1,
  access: "workspace",
  read: false,
  args: writeArgs,
  result: TerminalDeliveryResultSchema,
  critical: [],
  hotPath: true,
});

export const terminalResizeCommand = defineCommand({
  domain: terminalsDomain,
  name: "terminal_resize",
  since: 1,
  access: "workspace",
  read: false,
  args: resizeArgs,
  result: TerminalResizeResultSchema,
  critical: [],
  hotPath: true,
});

/**
 * Takes a shared terminal's size for `clientId` and applies its dimensions:
 * the claim half of size ownership (`terminal-size-ownership.ts`), sent on
 * deliberate interaction such as focusing or typing. It is deliberately not a
 * resize lifecycle command, so it is not queued behind (or ahead of) the
 * terminal's input: a claim sent while typing must not stall keystrokes. It
 * serves container and local sessions alike. An older backend answers
 * `unknown-command`; callers then send an ordinary resize.
 */
export const claimTerminalSizeCommand = defineCommand({
  domain: terminalsDomain,
  name: "claim_terminal_size",
  since: 2,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    sessionId: Schema.String,
    clientId: Schema.String,
    cols: optionalUnknown,
    rows: optionalUnknown,
  }),
  result: TerminalResizeResultSchema,
  critical: [],
  hotPath: true,
});

/**
 * Gives up the size ownership `clientId` holds, on one session or on all of
 * them: a terminal view closing, or a window going away. `disconnected` keeps
 * a short grace period instead, for a connection that may come straight back.
 * An older backend answers `unknown-command`, which callers ignore.
 */
export const releaseTerminalSizeCommand = defineCommand({
  domain: terminalsDomain,
  name: "release_terminal_size",
  since: 2,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    clientId: Schema.String,
    sessionId: optionalUnknown,
    disconnected: optionalUnknown,
  }),
  result: Schema.Struct({ released: NonNegativeInt }),
  critical: [],
});

export const detachTerminalCommand = defineCommand({
  domain: terminalsDomain,
  name: "detach_terminal",
  since: 1,
  access: "workspace",
  read: false,
  args: sessionArgs,
  result: Schema.Void,
  critical: [],
});

// --- Local terminals ---

export const createLocalTerminalSessionCommand = defineCommand({
  domain: terminalsDomain,
  name: "create_local_terminal_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    terminalKey: optionalUnknown,
    cols: optionalUnknown,
    rows: optionalUnknown,
    trackEnvironmentActivity: optionalUnknown,
  }),
  result: TerminalSessionCreateResultSchema,
  critical: [],
});

export const startLocalTerminalSessionCommand = defineCommand({
  domain: terminalsDomain,
  name: "start_local_terminal_session",
  since: 1,
  access: "workspace",
  read: false,
  args: sessionArgs,
  result: Schema.Void,
  critical: [],
});

export const localTerminalWriteCommand = defineCommand({
  domain: terminalsDomain,
  name: "local_terminal_write",
  since: 1,
  access: "workspace",
  read: false,
  args: writeArgs,
  result: TerminalDeliveryResultSchema,
  critical: [],
  hotPath: true,
});

export const localTerminalResizeCommand = defineCommand({
  domain: terminalsDomain,
  name: "local_terminal_resize",
  since: 1,
  access: "workspace",
  read: false,
  args: resizeArgs,
  result: TerminalResizeResultSchema,
  critical: [],
  hotPath: true,
});

export const closeLocalTerminalSessionCommand = defineCommand({
  domain: terminalsDomain,
  name: "close_local_terminal_session",
  since: 1,
  access: "workspace",
  read: false,
  args: sessionArgs,
  result: Schema.Void,
  critical: [],
});

// --- Session state and output recovery ---

export const listTerminalSessionsCommand = defineCommand({
  domain: terminalsDomain,
  name: "list_terminal_sessions",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: Schema.Array(Schema.String),
  critical: [],
});

export const getTerminalSessionCommand = defineCommand({
  domain: terminalsDomain,
  name: "get_terminal_session",
  since: 1,
  access: "workspace",
  read: true,
  args: sessionArgs,
  result: Schema.Struct({
    id: Schema.String,
    running: Schema.Boolean,
    bootstrapped: Schema.optionalKey(Schema.Boolean),
  }),
  critical: [],
});

/** Writes a session's first input exactly once per session. */
export const bootstrapTerminalSessionCommand = defineCommand({
  domain: terminalsDomain,
  name: "bootstrap_terminal_session",
  since: 1,
  access: "workspace",
  read: false,
  args: writeArgs,
  result: Schema.Struct({
    bootstrapped: Schema.Boolean,
    delivered: Schema.Boolean,
    duplicate: Schema.Boolean,
    // On a duplicate: whether the first bootstrap sent the same data.
    matchesExisting: Schema.optionalKey(Schema.Boolean),
  }),
  critical: [],
});

export const getTerminalOutputBufferCommand = defineCommand({
  domain: terminalsDomain,
  name: "get_terminal_output_buffer",
  since: 1,
  access: "workspace",
  read: true,
  args: sessionArgs,
  result: Schema.String,
  critical: [],
  hotPath: true,
});

export const getTerminalOutputSnapshotCommand = defineCommand({
  domain: terminalsDomain,
  name: "get_terminal_output_snapshot",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    sessionId: Schema.String,
    // Both or neither, finite numbers (the handler's own check and text).
    sinceRevision: optionalUnknown,
    sinceGeneration: optionalUnknown,
  }),
  result: TerminalOutputSnapshotSchema,
  critical: [],
  hotPath: true,
});

export const getTerminalStateSnapshotCommand = defineCommand({
  domain: terminalsDomain,
  name: "get_terminal_state_snapshot",
  since: 1,
  access: "workspace",
  read: true,
  args: sessionArgs,
  result: Schema.NullOr(TerminalStateSnapshotSchema),
  critical: [],
  hotPath: true,
});

export const getTerminalHistoryPageCommand = defineCommand({
  domain: terminalsDomain,
  name: "get_terminal_history_page",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ sessionId: Schema.String, cursor: Schema.optionalKey(Schema.String) }),
  result: Schema.NullOr(TerminalHistoryPageSchema),
  critical: [],
  hotPath: true,
});

const snapshotAcknowledged = Schema.Struct({ acknowledged: Schema.Literal(true) });

/**
 * The renderer applied a recovery snapshot. Browser gateways answer it
 * locally to release buffered frames; the backend only acknowledges.
 */
export const terminalSnapshotAppliedCommand = defineCommand({
  domain: terminalsDomain,
  name: "terminal_snapshot_applied",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    sessionId: optionalUnknown,
    generation: optionalUnknown,
    revision: optionalUnknown,
  }),
  result: snapshotAcknowledged,
  critical: [],
});

export const terminalSnapshotFailedCommand = defineCommand({
  domain: terminalsDomain,
  name: "terminal_snapshot_failed",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ sessionId: optionalUnknown }),
  result: snapshotAcknowledged,
  critical: [],
});

// --- User commands (`!` in the composer) and the prompts they wait on ---

const tabArgs = { environmentId: Schema.String, tabId: Schema.String };

export const runUserCommandCommand = defineCommand({
  domain: terminalsDomain,
  name: "run_user_command",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...tabArgs, command: Schema.String }),
  result: UserCommandRecordSchema,
  critical: [],
});

export const listUserCommandsCommand = defineCommand({
  domain: terminalsDomain,
  name: "list_user_commands",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct(tabArgs),
  result: Schema.Struct({
    environmentId: Schema.String,
    tabId: Schema.String,
    commands: Schema.Array(UserCommandRecordSchema),
  }),
  critical: [],
});

export const writeUserCommandInputCommand = defineCommand({
  domain: terminalsDomain,
  name: "write_user_command_input",
  since: 1,
  access: "workspace",
  read: false,
  // `text` defaults to "" and `enter` to true for any other value.
  args: Schema.Struct({ id: Schema.String, text: optionalUnknown, enter: optionalUnknown }),
  result: UserCommandRecordSchema,
  critical: [],
});

export const cancelUserCommandCommand = defineCommand({
  domain: terminalsDomain,
  name: "cancel_user_command",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ id: Schema.String }),
  result: UserCommandRecordSchema,
  critical: [],
});

export const listHumanPromptsCommand = defineCommand({
  domain: terminalsDomain,
  name: "list_human_prompts",
  since: 1,
  access: "workspace",
  read: true,
  // Filters; a value of another type is ignored rather than refused.
  args: Schema.Struct({ environmentIds: optionalUnknown, tabId: optionalUnknown }),
  result: Schema.Struct({ prompts: Schema.Array(HumanPromptEntrySchema) }),
  critical: [],
});

/** Every `terminals` command definition. */
export const TERMINALS_COMMANDS = [
  launchTerminalJobCommand,
  createTerminalSessionCommand,
  startTerminalSessionCommand,
  terminalWriteCommand,
  terminalResizeCommand,
  claimTerminalSizeCommand,
  releaseTerminalSizeCommand,
  detachTerminalCommand,
  createLocalTerminalSessionCommand,
  startLocalTerminalSessionCommand,
  localTerminalWriteCommand,
  localTerminalResizeCommand,
  closeLocalTerminalSessionCommand,
  listTerminalSessionsCommand,
  getTerminalSessionCommand,
  bootstrapTerminalSessionCommand,
  getTerminalOutputBufferCommand,
  getTerminalOutputSnapshotCommand,
  getTerminalStateSnapshotCommand,
  getTerminalHistoryPageCommand,
  terminalSnapshotAppliedCommand,
  terminalSnapshotFailedCommand,
  runUserCommandCommand,
  listUserCommandsCommand,
  writeUserCommandInputCommand,
  cancelUserCommandCommand,
  listHumanPromptsCommand,
] as const;
