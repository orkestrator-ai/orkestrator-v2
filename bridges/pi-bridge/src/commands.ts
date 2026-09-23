/**
 * Pi's command inventory, and the registry that executes it.
 *
 * One builder serves every path that reads the list — attach, reattach, fork,
 * an explicit refresh and a configuration change that rebuilds the session —
 * so a refreshed list can never describe commands differently from the one an
 * attach produced.
 *
 * The inventory mirrors what `AgentSession.prompt` (0.85.1) will actually do
 * with the text, not what the resource loader happens to hold:
 *
 * 1. `_tryExecuteExtensionCommand` runs first, looking the text up with
 *    `extensionRunner.getCommand(name)` where `name` ends at the first space.
 * 2. `_expandSkillCommand` expands `/skill:<name>` from `resourceLoader`.
 * 3. `expandPromptTemplate` expands `/<name>` from `promptTemplates`, first
 *    match wins.
 *
 * So an extension command shadows a same-named skill or template outright,
 * and only the effective winner is listed. Listing the loser too — even as
 * unavailable — would put two rows under one name and turn every typed use of
 * it into an ambiguity, for a row nobody can run.
 *
 * Nothing private leaves this module: an id is `pi:<kind>:<invocation>`, and
 * the binding revision is a fingerprint of the source path, never the path.
 */
import { randomBytes } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  COMMAND_CATALOGUE_LIMITS,
  NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
  commandBindingRevision,
  normalizeCommandCataloguePayload,
  truncateUtf8,
  utf8ByteLength,
  type BridgeCommandCatalogueResponse,
  type NativeAgentBridgeCommandInvocation,
} from "@orkestrator/protocol/agent-command-catalogue";
import { parseCommandToken } from "@orkestrator/protocol/agent-slash-commands";
import type {
  NativeAgentCommandOrigin,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import { bridgeGeneration } from "./config.js";
import { chargeTranscript } from "./transcript.js";
import type { BridgeMessage, BridgeMessagePart, PiCommandRun, SessionState } from "./state.js";

export type PiCommandKind = "template" | "skill" | "extension";

/** `AgentSession.prompt`'s own dispatch order; lower runs first. */
const PRECEDENCE: Readonly<Record<PiCommandKind, number>> = {
  extension: 0,
  skill: 1,
  template: 2,
};

/** Room for the response envelope around the rows. */
const ENVELOPE_BYTES = 1_024;
/** Display output an extension command may leave in the transcript. */
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
const MAX_COMMAND_OUTPUT_MESSAGES = 16;
const MAX_COMMAND_ERROR_BYTES = 1_024;

interface SourceInfoLike {
  path?: string;
  scope?: string;
  origin?: string;
}

interface Candidate {
  kind: PiCommandKind;
  /** Canonical invocation without the slash: `review`, `skill:lint`, `deploy:2`. */
  invocation: string;
  description?: string;
  argumentHint?: string;
  sourceInfo?: SourceInfoLike;
  /** What the binding executes; hashed into the revision, never published. */
  identity: string;
}

export interface BuiltCommandCatalogue {
  commands: NativeAgentSlashCommand[];
  truncated: boolean;
}

/**
 * Whether Pi's own settings offer skills as commands.
 *
 * `enableSkillCommands` is what hides `/skill:` rows from Pi's terminal
 * autocomplete, so the picker here follows it too. Absent means Pi's default.
 */
function skillCommandsEnabled(session: AgentSession): boolean {
  try {
    return session.settingsManager?.getEnableSkillCommands?.() !== false;
  } catch {
    return true;
  }
}

function readCandidates(session: AgentSession): Candidate[] {
  const candidates: Candidate[] = [];
  for (const template of session.promptTemplates ?? []) {
    candidates.push({
      kind: "template",
      invocation: template.name,
      description: template.description,
      argumentHint: template.argumentHint,
      sourceInfo: template.sourceInfo,
      identity: template.filePath ?? template.sourceInfo?.path ?? template.name,
    });
  }
  if (skillCommandsEnabled(session)) {
    for (const skill of session.resourceLoader?.getSkills?.().skills ?? []) {
      candidates.push({
        kind: "skill",
        invocation: `skill:${skill.name}`,
        description: skill.description,
        sourceInfo: skill.sourceInfo,
        identity: skill.filePath ?? skill.sourceInfo?.path ?? skill.name,
      });
    }
  }
  for (const command of session.extensionRunner?.getRegisteredCommands?.() ?? []) {
    // `invocationName` is Pi's own disambiguation (`name:2` for a second
    // extension registering `name`) and the only spelling `getCommand` finds.
    const invocation = command.invocationName || command.name;
    candidates.push({
      kind: "extension",
      invocation,
      description: command.description,
      sourceInfo: command.sourceInfo,
      identity: `${command.sourceInfo?.path ?? "extension"}#${command.name}`,
    });
  }
  return candidates;
}

/** Verified ownership from Pi's `SourceInfo`; never inferred from a name. */
function originOf(info: SourceInfoLike | undefined): NativeAgentCommandOrigin | undefined {
  if (!info) return undefined;
  if (info.origin === "package") return "plugin";
  if (info.scope === "project") return "project";
  if (info.scope === "user") return "user";
  // `temporary` is a resource an extension contributed at runtime, or one of
  // this bridge's inline extensions: Pi does not say whose it is.
  return undefined;
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? truncateUtf8(trimmed, maxBytes) : undefined;
}

/**
 * An invocation Pi can actually be handed back.
 *
 * Pi splits the extension name at the first space and the template name at
 * the first whitespace, so a name containing either could never be invoked.
 */
function validInvocation(invocation: string): boolean {
  return invocation.length > 0 && !/\s/.test(invocation);
}

export function commandId(kind: PiCommandKind, invocation: string): string {
  return `pi:${kind}:${invocation}`;
}

function toDescriptor(candidate: Candidate): NativeAgentSlashCommand | undefined {
  if (!validInvocation(candidate.invocation)) return undefined;
  const name = `/${candidate.invocation}`;
  const id = commandId(candidate.kind, candidate.invocation);
  // Identity is rejected over budget, never truncated into another command.
  if (
    utf8ByteLength(name) > COMMAND_CATALOGUE_LIMITS.maxNameBytes ||
    utf8ByteLength(id) > COMMAND_CATALOGUE_LIMITS.maxIdBytes
  ) {
    return undefined;
  }
  const description = boundedText(
    candidate.description,
    COMMAND_CATALOGUE_LIMITS.maxDescriptionBytes,
  );
  const argumentHint = boundedText(
    candidate.argumentHint,
    COMMAND_CATALOGUE_LIMITS.maxArgumentHintBytes,
  );
  const origin = originOf(candidate.sourceInfo);
  return {
    name,
    id,
    executionKind: "provider-prompt",
    source: candidate.kind,
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    scope: candidate.sourceInfo?.scope === "project" ? "session" : "global",
    ...(origin ? { origin } : {}),
    // Templates and skills expand into an ordinary prompt, so they queue
    // behind a running turn exactly as a prompt does. An extension command is
    // arbitrary code: Pi refuses to queue one (`followUp` throws on it), and
    // running one mid-turn is not qualified, so it waits for idle. It takes an
    // argument string only; Pi drops images on that path.
    inputPolicy:
      candidate.kind === "extension" ? { busy: "idle", attachments: "none" } : { busy: "queue" },
    bindingRevision: commandBindingRevision([
      "pi",
      candidate.kind,
      candidate.invocation,
      candidate.identity,
    ]),
    // Every Pi lookup is an exact string comparison.
    caseSensitive: true,
  };
}

/**
 * Read the commands an attached session offers, bounded by the wire contract.
 *
 * Throws only if the SDK itself throws; callers keep the previous list then.
 */
export function buildCommandCatalogue(session: AgentSession): BuiltCommandCatalogue {
  const candidates = readCandidates(session);
  const winners = new Map<string, PiCommandKind>();
  for (const candidate of candidates) {
    const current = winners.get(candidate.invocation);
    if (!current || PRECEDENCE[candidate.kind] < PRECEDENCE[current]) {
      winners.set(candidate.invocation, candidate.kind);
    }
  }
  const commands: NativeAgentSlashCommand[] = [];
  const ids = new Set<string>();
  let truncated = false;
  let bytes = ENVELOPE_BYTES;
  for (const candidate of candidates) {
    // Shadowed: Pi reaches the winner first, so this binding cannot run.
    if (winners.get(candidate.invocation) !== candidate.kind) continue;
    const row = toDescriptor(candidate);
    if (!row) {
      truncated = true;
      continue;
    }
    // Same kind and invocation: Pi's lookup takes the first, so does this.
    if (ids.has(row.id!)) continue;
    if (commands.length >= COMMAND_CATALOGUE_LIMITS.maxCommands) {
      truncated = true;
      break;
    }
    const size = utf8ByteLength(JSON.stringify(row)) + 1;
    if (bytes + size > COMMAND_CATALOGUE_LIMITS.maxWireBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    ids.add(row.id!);
    commands.push(row);
  }
  return { commands, truncated };
}

/** Adopt a freshly built list; advances the catalogue revision only on change. */
export function publishCommandCatalogue(state: SessionState, built: BuiltCommandCatalogue): void {
  const current = state.commandCatalogue;
  const changed =
    current.status !== "ready" ||
    (current.truncated === true) !== built.truncated ||
    JSON.stringify(state.slashCommands) !== JSON.stringify(built.commands);
  state.slashCommands = built.commands;
  if (!changed) return;
  state.commandCatalogue = {
    status: "ready",
    revision: current.revision + 1,
    ...(built.truncated ? { truncated: true } : {}),
  };
  state.revision += 1;
}

/** Keep the list, but stop calling it authoritative. */
export function markCommandCatalogueStale(state: SessionState): void {
  if (state.commandCatalogue.status === "stale") return;
  state.commandCatalogue = {
    ...state.commandCatalogue,
    status: "stale",
    revision: state.commandCatalogue.revision + 1,
  };
  state.revision += 1;
}

/**
 * Read and publish the attached session's commands.
 *
 * A read that throws keeps the previous rows as `stale` rather than replacing
 * them with an empty list that would claim the session has no commands.
 */
export function readSessionCommandCatalogue(state: SessionState, session: AgentSession): boolean {
  let built: BuiltCommandCatalogue;
  try {
    built = buildCommandCatalogue(session);
  } catch (error) {
    markCommandCatalogueStale(state);
    state.health.recordNotice({
      message: "Pi's command list could not be read; the previous list is kept",
      method: "session/commands",
      severity: "warning",
      source: "provider",
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  publishCommandCatalogue(state, built);
  return true;
}

/** The enhanced response for `GET /session/:id/commands`. */
export function commandCatalogueResponse(state: SessionState): BridgeCommandCatalogueResponse {
  return {
    catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
    status: state.commandCatalogue.status,
    revision: state.commandCatalogue.revision,
    generation: bridgeGeneration,
    // Pi pushes no inventory changes; the list is as fresh as its last read.
    freshness: "ttl",
    ...(state.commandCatalogue.truncated ? { truncated: true } : {}),
    commands: state.slashCommands,
  };
}

/** An unknown session, answered in band so it is never read as an old bridge. */
export function missingCommandCatalogueResponse(): BridgeCommandCatalogueResponse {
  return {
    catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
    status: "missing",
    generation: bridgeGeneration,
    freshness: "ttl",
    commands: [],
  };
}

export function parsePiCommandId(
  id: string,
): { kind: PiCommandKind; invocation: string } | undefined {
  const match = /^pi:(template|skill|extension):(\S+)$/.exec(id);
  return match ? { kind: match[1] as PiCommandKind, invocation: match[2]! } : undefined;
}

/**
 * Rows restored from the state file.
 *
 * Re-run through the shared normalizer so a hand-edited or corrupt file cannot
 * restore an unbounded or malformed row, and kept only when the row's own id
 * still names the Pi binding its name claims.
 */
export function restoreCommandCatalogue(value: unknown): NativeAgentSlashCommand[] {
  if (!Array.isArray(value)) return [];
  const normalized = normalizeCommandCataloguePayload({
    catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
    commands: value,
  });
  return normalized.commands.filter((command) => {
    const binding = command.id ? parsePiCommandId(command.id) : undefined;
    return binding !== undefined && command.name === `/${binding.invocation}`;
  });
}

/** The text Pi receives: canonical invocation, one space, arguments verbatim. */
export function invocationText(invocation: string, args: string): string {
  return args.length > 0 ? `/${invocation} ${args}` : `/${invocation}`;
}

export type CommandSelection =
  | {
      ok: true;
      kind: PiCommandKind;
      invocation: string;
      /** Canonical text for `session.prompt`. */
      text: string;
    }
  | { ok: false; message: string };

/**
 * Resolve a backend's command selection against this session's registry.
 *
 * The registry is the published list itself. A selection must name a row that
 * still exists, under the same name and execution kind, at the same binding
 * revision, and that is available — anything else is refused, never sent on
 * as prompt text.
 */
export function resolveCommandSelection(
  state: SessionState,
  selection: NativeAgentBridgeCommandInvocation,
): CommandSelection {
  const row = state.slashCommands.find((command) => command.id === selection.id);
  const binding = row?.id ? parsePiCommandId(row.id) : undefined;
  if (!row || !binding) {
    return {
      ok: false,
      message: `${selection.name} is no longer available in this Pi session. Refresh the command list and choose it again.`,
    };
  }
  if (row.name !== selection.name || row.executionKind !== selection.executionKind) {
    return {
      ok: false,
      message: `${selection.name} no longer matches this Pi session's command. Choose it again.`,
    };
  }
  if (
    selection.bindingRevision !== undefined &&
    selection.bindingRevision !== row.bindingRevision
  ) {
    return {
      ok: false,
      message: `${row.name} changed since it was selected. Choose it again from the menu.`,
    };
  }
  if (row.availability?.state === "unavailable") {
    return {
      ok: false,
      message: row.availability.message ?? `${row.name} is not available in this Pi session.`,
    };
  }
  return {
    ok: true,
    kind: binding.kind,
    invocation: binding.invocation,
    text: invocationText(binding.invocation, selection.arguments),
  };
}

/**
 * Which of Pi's command paths `prompt()` takes for this text, if any.
 *
 * A faithful copy of the SDK's own parsing, asked of the live session rather
 * than of the published list: this is the check that holds a selection to
 * what Pi will really run, and the one that tells an extension command (whose
 * handler runs inside `prompt()`) from text that becomes a model turn.
 */
export function effectiveCommandKind(
  session: AgentSession,
  text: string,
): { kind: PiCommandKind; invocation: string } | undefined {
  if (!text.startsWith("/")) return undefined;
  const space = text.indexOf(" ");
  const extensionName = space === -1 ? text.slice(1) : text.slice(1, space);
  if (extensionName && session.extensionRunner?.getCommand?.(extensionName)) {
    return { kind: "extension", invocation: extensionName };
  }
  if (text.startsWith("/skill:")) {
    const skillName = space === -1 ? text.slice(7) : text.slice(7, space);
    const skills = session.resourceLoader?.getSkills?.().skills ?? [];
    if (skills.some((skill) => skill.name === skillName)) {
      return { kind: "skill", invocation: `skill:${skillName}` };
    }
  }
  const templateName = /^\/([^\s]+)(?:\s+[\s\S]*)?$/.exec(text)?.[1];
  if (templateName && (session.promptTemplates ?? []).some((t) => t.name === templateName)) {
    return { kind: "template", invocation: templateName };
  }
  return undefined;
}

/**
 * The reply to a raw `/compact` a legacy client typed as a prompt.
 *
 * Pi's `/compact` is an interactive-terminal builtin that `session.prompt`
 * does not implement; sent on, it would reach the model as prose. Compaction
 * is the `/session/:id/compact` action. A template or extension the session
 * really offers under that name is a provider command and is left alone.
 */
export function legacyCompactReply(
  prompt: string,
  commands: readonly NativeAgentSlashCommand[],
): string | undefined {
  if (parseCommandToken(prompt)?.token !== "/compact") return undefined;
  if (commands.some((command) => command.name === "/compact")) return undefined;
  return "Pi's /compact is a terminal command, so it was not sent to the model. Use Compact from the command menu to compact this conversation.";
}

/** Start tracking an extension command the next `prompt()` will run. */
export function beginCommandRun(state: SessionState, invocation: string): PiCommandRun {
  const run: PiCommandRun = { invocation, output: [] };
  state.commandRun = run;
  return run;
}

/**
 * Route an extension error to the command it belongs to.
 *
 * Pi catches a throwing command handler itself and reports it only here, as
 * `{ extensionPath: "command:<name>", event: "command" }`, then resolves
 * `prompt()` as if it had succeeded. Work the handler started through
 * `pi.sendMessage`/`pi.sendUserMessage` fails the same way.
 */
export function noteCommandError(
  state: SessionState,
  error: { extensionPath: string; event: string; error: string },
): void {
  const run = state.commandRun;
  if (!run || run.error) return;
  const own = error.event === "command" && error.extensionPath === `command:${run.invocation}`;
  const started = error.event === "send_user_message" || error.event === "send_message";
  if (!own && !started) return;
  run.error = truncateUtf8(error.error?.trim() || "The command failed", MAX_COMMAND_ERROR_BYTES);
}

/** Record display text an extension emitted while its command ran. */
export function noteCommandOutput(state: SessionState, text: string): void {
  const run = state.commandRun;
  if (!run || run.output.length >= MAX_COMMAND_OUTPUT_MESSAGES) return;
  const trimmed = text.trim();
  if (trimmed) run.output.push(truncateUtf8(trimmed, MAX_COMMAND_OUTPUT_BYTES));
}

/**
 * Close an extension command's turn with an outcome the transcript keeps.
 *
 * The user row went in before the command ran. Without this, a command that
 * finished without a model turn left it answered by nothing, and one whose
 * handler threw looked exactly like one that worked. Returns the failure, if
 * any, so the caller settles the turn as failed.
 */
export function settleCommandRun(
  state: SessionState,
  run: PiCommandRun,
  requestId: string | undefined,
): string | undefined {
  if (state.commandRun === run) state.commandRun = undefined;
  const name = `/${run.invocation}`;
  if (run.error) {
    appendCommandOutcome(state, requestId, {
      type: "status",
      severity: "error",
      content: `Pi extension command ${name} failed: ${run.error}`,
    });
    return run.error;
  }
  if (run.cancelled) {
    appendCommandOutcome(state, requestId, {
      type: "status",
      severity: "info",
      content: `${name} was cancelled. Pi cannot stop an extension command's handler, so it may still finish in the background.`,
    });
    return undefined;
  }
  // The command started a model turn and it answered; that reply is the outcome.
  if (state.currentAssistantMessageId !== undefined) return undefined;
  const output = truncateUtf8(run.output.join("\n\n"), MAX_COMMAND_OUTPUT_BYTES);
  appendCommandOutcome(
    state,
    requestId,
    output
      ? { type: "text", content: output }
      : {
          type: "status",
          severity: "info",
          content: `${name} finished without output. Pi extensions run here without a terminal UI, so a command that needs a dialog could not show one.`,
        },
  );
  return undefined;
}

function appendCommandOutcome(
  state: SessionState,
  requestId: string | undefined,
  part:
    | { type: "text"; content: string }
    | { type: "status"; content: string; severity: "info" | "error" },
): void {
  const messageId = requestId
    ? `command-outcome:${requestId}`
    : `command-outcome:${randomBytes(12).toString("hex")}`;
  if (state.messages.some((message) => message.id === messageId)) return;
  const message: BridgeMessage = {
    id: messageId,
    role: "assistant",
    content: part.content,
    parts: [
      { ...part, sourcePartId: `${messageId}:0`, sourceMessageId: messageId } as BridgeMessagePart,
    ],
    createdAt: new Date().toISOString(),
  };
  state.messages.push(message);
  chargeTranscript(state, Buffer.byteLength(JSON.stringify(message)));
  state.revision += 1;
}
