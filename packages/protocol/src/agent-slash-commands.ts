import type {
  NativeAgentCapabilities,
  NativeAgentCommandIntent,
  NativeAgentSlashCommand,
  NativeAgentSlashCommandSource,
} from "./native-agent.js";
import { commandIsAvailable, withCommandIdentities } from "./agent-command-catalogue.js";

/** Stable picker grouping: provider fundamentals first, extensions last. */
export const NATIVE_AGENT_SLASH_COMMAND_SOURCE_ORDER: readonly NativeAgentSlashCommandSource[] = [
  "builtin",
  "orkestrator",
  "project",
  "user",
  "plugin",
  "skill",
  "template",
  "extension",
  "unknown",
];

export function compareNativeAgentSlashCommands(
  left: NativeAgentSlashCommand,
  right: NativeAgentSlashCommand,
): number {
  const sourceOrder =
    NATIVE_AGENT_SLASH_COMMAND_SOURCE_ORDER.indexOf(left.source) -
    NATIVE_AGENT_SLASH_COMMAND_SOURCE_ORDER.indexOf(right.source);
  return (
    sourceOrder ||
    left.name.localeCompare(right.name) ||
    (left.id ?? "").localeCompare(right.id ?? "")
  );
}

/**
 * Lexical form of a leading command token.
 *
 * Nothing here decides whether the token *is* a command — that needs the
 * authoritative catalogue. It only finds the token and the argument suffix
 * without changing a byte of either, so the text the user typed is exactly the
 * text an executor receives.
 *
 * Separator rule: the token ends at the first whitespace character. The
 * separator is the run of spaces/tabs that follows plus at most one line
 * break; everything after it is the argument suffix, verbatim — internal
 * newlines, tabs, quotes and trailing spaces included.
 */
export interface CommandToken {
  /** The token exactly as typed, including its sigil. */
  token: string;
  sigil: "/" | "$";
  /** Offset of the token in the original text (after leading whitespace). */
  start: number;
  /** Offset where the argument suffix begins. */
  argumentsStart: number;
  /** Verbatim argument suffix; empty when there is none. */
  arguments: string;
}

const LEADING_TOKEN = /^(\s*)([/$][^\s]+)([ \t]*(?:\r?\n)?)/;

export function parseCommandToken(
  text: string,
  sigils: readonly ("/" | "$")[] = ["/"],
): CommandToken | null {
  const match = LEADING_TOKEN.exec(text);
  if (!match) return null;
  const token = match[2]!;
  const sigil = token[0] as "/" | "$";
  if (!sigils.includes(sigil) || token.length < 2) return null;
  const start = match[1]!.length;
  const argumentsStart = start + token.length + match[3]!.length;
  return { token, sigil, start, argumentsStart, arguments: text.slice(argumentsStart) };
}

/**
 * Legacy parse shape, kept for callers that only need a lookup key.
 *
 * The name is lower-cased: use it for matching, never as outgoing provider
 * text. {@link parseCommandToken} preserves the spelling.
 */
export interface ParsedSlashCommand {
  /** Always normalized to a leading slash, lower-cased for lookups. */
  name: string;
  /**
   * Everything after the command name, with leading blanks trimmed and
   * *internal* whitespace preserved. Rebuilding this from split tokens
   * collapsed newlines, so a command invoked with a pasted diff or a
   * multi-line spec reached the provider as one flattened line.
   */
  arguments?: string;
}

export function parseLeadingSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^(\/[^\s]+)([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  const rest = match[2]?.replace(/^[^\S\r\n]+/, "") ?? "";
  return {
    name: match[1]!.toLowerCase(),
    ...(rest.trim() ? { arguments: rest } : {}),
  };
}

/** Session actions a composer command can invoke, keyed by command name. */
export type SessionActionCommandKind = "steer" | "compact";

interface SessionActionCommandDefinition {
  kind: SessionActionCommandKind;
  id: string;
  capability: keyof NonNullable<NativeAgentCapabilities["actions"]>;
  /** Refused with this message when the command carries no instructions. */
  requiresArguments?: string;
  /** Refused with this message when the command carries any arguments. */
  rejectsArguments?: string;
  description: string;
  argumentHint?: string;
  busy: "idle" | "running";
  /**
   * Collision policy with a provider command of the same name.
   * `reserve`: Orkestrator's action replaces it whenever the action is
   * available. `defer`: the provider's own command wins, and the action is
   * offered only when the provider has none.
   */
  collision: "reserve" | "defer";
}

/**
 * Commands the *runtime* performs rather than the model.
 *
 * Gated on the neutral capability rather than on the platform, so a provider
 * that gains an action gets the composer command with it, and a provider that
 * has never advertised one never has its own same-named command shadowed.
 *
 * `/steer` is reserved while steering is qualified: it acts on the live turn
 * and must never start a new one. `/compact` defers: a provider that ships
 * its own `/compact` (Claude's SDK does) keeps it, with its own events and
 * results; the action fills the gap for providers that only expose compact as
 * a runtime operation.
 */
export const SESSION_ACTION_SLASH_COMMANDS: Readonly<
  Record<string, SessionActionCommandDefinition>
> = {
  "/steer": {
    kind: "steer",
    id: "orkestrator:steer",
    capability: "steer",
    requiresArguments: "Add instructions after /steer.",
    description: "Send instructions to the turn that is already running",
    argumentHint: "<instructions>",
    busy: "running",
    collision: "reserve",
  },
  "/compact": {
    kind: "compact",
    id: "orkestrator:compact",
    capability: "compact",
    rejectsArguments: "/compact takes no arguments here. Remove the text after it and retry.",
    description: "Compact the conversation to free context",
    busy: "idle",
    collision: "defer",
  },
};

export function sessionActionDefinitionForId(
  id: string,
): (SessionActionCommandDefinition & { name: string }) | undefined {
  for (const [name, definition] of Object.entries(SESSION_ACTION_SLASH_COMMANDS)) {
    if (definition.id === id) return { ...definition, name };
  }
  return undefined;
}

export interface ResolvedSessionActionCommand {
  kind: SessionActionCommandKind;
  /** Instructions for the action; empty only when the command allows it. */
  text: string;
  /** Set when the command was recognized but cannot run as submitted. */
  error?: string;
}

/**
 * Resolve a composer submission to a live-turn session action, or `null` to
 * send it as an ordinary prompt.
 *
 * `runningTurn` matters because `/steer` only exists relative to a live turn:
 * typed while the agent is idle it is a normal prompt, not an error, which is
 * what the Codex composer did before consolidation. `/compact` is resolved
 * through the catalogue instead (see {@link resolveCommandInvocation}).
 */
export function resolveSessionActionCommand(
  text: string,
  capabilities: NativeAgentCapabilities | undefined,
  runningTurn: boolean,
): ResolvedSessionActionCommand | null {
  if (!runningTurn) return null;
  const parsed = parseLeadingSlashCommand(text);
  if (!parsed) return null;
  const definition = SESSION_ACTION_SLASH_COMMANDS[parsed.name];
  if (!definition || definition.busy !== "running") return null;
  if (capabilities?.actions?.[definition.capability] !== true) return null;
  const argumentText = parsed.arguments?.trim() ?? "";
  if (!argumentText && definition.requiresArguments) {
    return { kind: definition.kind, text: "", error: definition.requiresArguments };
  }
  return { kind: definition.kind, text: argumentText };
}

/**
 * Local reply when `/steer` is submitted as an ordinary prompt while idle.
 *
 * The composer only routes `/steer` to the session action during a live turn.
 * An idle or stale client can still POST it as a prompt; answering locally
 * keeps the raw command from starting a model turn, matching Codex.
 */
export function idleSteerPromptReply(prompt: string, agentLabel: string): string | null {
  const parsed = parseLeadingSlashCommand(prompt);
  if (parsed?.name !== "/steer") return null;
  return parsed.arguments?.trim()
    ? `There is no active ${agentLabel} turn to steer. Start a turn, then use /steer while it is running.`
    : `Usage: /steer <instructions>. Run it while a ${agentLabel} turn is active.`;
}

/** Spellings that invoke a descriptor: its insert text, name and aliases. */
export function commandSpellings(command: NativeAgentSlashCommand): string[] {
  const spellings = [command.insertText ?? command.name, command.name, ...(command.aliases ?? [])];
  return [...new Set(spellings)];
}

export type CommandResolution =
  | {
      kind: "literal";
      reason: "no-token" | "literal-intent" | "unknown-command";
    }
  | {
      kind: "command";
      command: NativeAgentSlashCommand;
      matchedBy: "selection" | "name" | "alias";
      token: CommandToken;
    }
  | { kind: "unavailable"; command: NativeAgentSlashCommand; message: string }
  | { kind: "stale-selection"; message: string }
  | { kind: "ambiguous"; candidates: NativeAgentSlashCommand[]; message: string }
  | { kind: "invalid-arguments"; command: NativeAgentSlashCommand; message: string };

function tokenSigils(commands: readonly NativeAgentSlashCommand[]): ("/" | "$")[] {
  return commands.some((command) =>
    commandSpellings(command).some((spelling) => spelling.startsWith("$")),
  )
    ? ["/", "$"]
    : ["/"];
}

function matchSpelling(
  commands: readonly NativeAgentSlashCommand[],
  token: string,
  field: "name" | "alias",
): NativeAgentSlashCommand[] {
  const spellingsOf = (command: NativeAgentSlashCommand) =>
    field === "name" ? [command.insertText ?? command.name, command.name] : (command.aliases ?? []);
  const exact = commands.filter((command) => spellingsOf(command).includes(token));
  if (exact.length > 0) return exact;
  const folded = token.toLowerCase();
  return commands.filter(
    (command) =>
      command.caseSensitive !== true &&
      spellingsOf(command).some((spelling) => spelling.toLowerCase() === folded),
  );
}

function checkArguments(
  command: NativeAgentSlashCommand,
  token: CommandToken,
): CommandResolution | null {
  const hasArguments = token.arguments.trim().length > 0;
  if (command.inputPolicy?.arguments === "required" && !hasArguments) {
    return {
      kind: "invalid-arguments",
      command,
      message: `Add ${command.argumentHint ?? "arguments"} after ${command.name}.`,
    };
  }
  if (command.inputPolicy?.arguments === "none" && hasArguments) {
    return {
      kind: "invalid-arguments",
      command,
      message: `${command.name} takes no arguments. Remove the text after it and retry.`,
    };
  }
  return null;
}

function unavailableMessage(command: NativeAgentSlashCommand): string {
  return command.availability?.message ?? `${command.name} is not available in this session.`;
}

/**
 * Resolve a submission against an authoritative command list.
 *
 * - Literal intent never matches.
 * - A selection resolves by identity and must still agree with the typed
 *   token and binding revision; anything else is a stale selection, never a
 *   silent substitution or a plain prompt.
 * - Typed text prefers an exact canonical spelling, then a case-folded one
 *   (unless the descriptor is case-sensitive), then an alias. More than one
 *   executable candidate at a level is ambiguous: nothing chooses by sort
 *   order. Unavailable rows (a shadowed template) never compete with the one
 *   executable row of the same spelling.
 * - A token that matches nothing is ordinary text, so paths and prose that
 *   merely start with `/` keep working.
 */
export function resolveCommandInvocation(input: {
  text: string;
  intent: NativeAgentCommandIntent;
  commands: readonly NativeAgentSlashCommand[];
}): CommandResolution {
  if (input.intent.kind === "literal") return { kind: "literal", reason: "literal-intent" };
  const commands = withCommandIdentities(input.commands);
  const token = parseCommandToken(input.text, tokenSigils(commands));
  if (input.intent.kind === "selected") {
    const { commandId, bindingRevision } = input.intent;
    const command = commands.find((candidate) => candidate.id === commandId);
    if (!command) {
      return {
        kind: "stale-selection",
        message: "The selected command is no longer available. Choose it again from the menu.",
      };
    }
    if (
      bindingRevision !== undefined &&
      command.bindingRevision !== undefined &&
      command.bindingRevision !== bindingRevision
    ) {
      return {
        kind: "stale-selection",
        message: `${command.name} changed since it was selected. Choose it again from the menu.`,
      };
    }
    const folded = token?.token.toLowerCase();
    if (
      !token ||
      !commandSpellings(command).some(
        (spelling) =>
          spelling === token.token ||
          (command.caseSensitive !== true && spelling.toLowerCase() === folded),
      )
    ) {
      return {
        kind: "stale-selection",
        message: "The command text no longer matches the selected command. Choose it again.",
      };
    }
    if (!commandIsAvailable(command)) {
      return { kind: "unavailable", command, message: unavailableMessage(command) };
    }
    return (
      checkArguments(command, token) ?? { kind: "command", command, matchedBy: "selection", token }
    );
  }
  if (!token) return { kind: "literal", reason: "no-token" };
  for (const field of ["name", "alias"] as const) {
    let matches = matchSpelling(commands, token.token, field);
    if (matches.length === 0) continue;
    // A shadowed or otherwise unavailable row sharing a spelling with the one
    // executable row is information, not a competing candidate.
    const available = matches.filter(commandIsAvailable);
    if (matches.length > 1 && available.length === 1) matches = available;
    if (matches.length > 1) {
      return {
        kind: "ambiguous",
        candidates: matches,
        message: `${token.token} matches more than one command. Choose one from the menu.`,
      };
    }
    const command = matches[0]!;
    if (!commandIsAvailable(command)) {
      return { kind: "unavailable", command, message: unavailableMessage(command) };
    }
    return checkArguments(command, token) ?? { kind: "command", command, matchedBy: field, token };
  }
  return { kind: "literal", reason: "unknown-command" };
}

/**
 * Whether a submission invokes a command owned by the provider itself.
 *
 * Runtime session actions are deliberately excluded: they do not consume a
 * prompt or transferred handoff history. Unknown slash-prefixed text and
 * absolute paths are ordinary prompts, matching provider behavior before the
 * shared composer was introduced.
 */
export function isProviderSlashCommand(
  text: string,
  commands: readonly NativeAgentSlashCommand[],
  capabilities?: NativeAgentCapabilities,
): boolean {
  const resolution = resolveCommandInvocation({ text, intent: { kind: "typed" }, commands });
  if (resolution.kind === "literal" || resolution.kind === "stale-selection") return false;
  if (resolution.kind === "ambiguous") return true;
  const command = resolution.command;
  if (command.executionKind === "session-action") return false;
  const parsed = parseLeadingSlashCommand(text);
  const sessionAction = parsed ? SESSION_ACTION_SLASH_COMMANDS[parsed.name] : undefined;
  return !(
    sessionAction &&
    sessionAction.collision === "reserve" &&
    capabilities?.actions?.[sessionAction.capability] === true
  );
}

function sessionActionDescriptor(
  name: string,
  definition: SessionActionCommandDefinition,
): NativeAgentSlashCommand {
  return {
    name,
    source: "orkestrator",
    description: definition.description,
    ...(definition.argumentHint ? { argumentHint: definition.argumentHint } : {}),
    id: definition.id,
    executionKind: "session-action",
    origin: "orkestrator",
    bindingRevision: definition.id,
    inputPolicy: {
      arguments: definition.requiresArguments
        ? "required"
        : definition.rejectsArguments
          ? "none"
          : "optional",
      attachments: "none",
      busy: definition.busy,
    },
  };
}

/**
 * Merge the runtime's own commands into a provider's discovered list so the
 * menu advertises exactly what the composer can execute.
 *
 * Collision policy is explicit per action (see
 * {@link SESSION_ACTION_SLASH_COMMANDS}). An action whose capability is absent
 * never touches a provider command of the same name: the old merge deleted a
 * provider's own `/steer` whenever steering was unqualified. Deduplication is
 * by identity, never by lower-cased display name alone.
 */
export function withSessionActionSlashCommands(
  commands: readonly NativeAgentSlashCommand[],
  capabilities: NativeAgentCapabilities | undefined,
): NativeAgentSlashCommand[] {
  let merged = withCommandIdentities(commands).filter(
    (command) => command.executionKind !== "session-action",
  );
  for (const [name, definition] of Object.entries(SESSION_ACTION_SLASH_COMMANDS)) {
    if (capabilities?.actions?.[definition.capability] !== true) continue;
    const collides = (command: NativeAgentSlashCommand) =>
      commandSpellings(command).some((spelling) => spelling.toLowerCase() === name);
    if (definition.collision === "defer" && merged.some(collides)) continue;
    if (definition.collision === "reserve") merged = merged.filter((command) => !collides(command));
    merged.push(sessionActionDescriptor(name, definition));
  }
  const seen = new Set<string>();
  return merged
    .filter((command) => {
      if (seen.has(command.id!)) return false;
      seen.add(command.id!);
      return true;
    })
    .sort(compareNativeAgentSlashCommands);
}
