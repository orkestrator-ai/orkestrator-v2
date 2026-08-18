import type { NativeAgentCapabilities, NativeAgentSlashCommand } from "./native-agent.js";

/**
 * One parsing rule for every provider.
 *
 * A composer submission that starts with `/name` may mean three different
 * things: a provider command the agent executes itself, a session action the
 * runtime performs out-of-band (Codex `/steer`), or ordinary prompt text that
 * merely happens to start with a slash. Each provider used to decide this in
 * its own tab with its own regular expression, which is why `/steer` worked
 * only in Codex and OpenCode's commands only ran from the OpenCode tab.
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
export type SessionActionCommandKind = "steer";

interface SessionActionCommandDefinition {
  kind: SessionActionCommandKind;
  capability: keyof NonNullable<NativeAgentCapabilities["actions"]>;
  /** Refused with this message when the command carries no instructions. */
  requiresArguments?: string;
  description: string;
  argumentHint?: string;
}

/**
 * Commands the *runtime* performs rather than the model.
 *
 * Gated on the neutral capability rather than on the platform, so a provider
 * that gains an action gets the composer command with it, and a provider that
 * has never advertised one never has its own same-named command shadowed.
 */
export const SESSION_ACTION_SLASH_COMMANDS: Readonly<
  Record<string, SessionActionCommandDefinition>
> = {
  "/steer": {
    kind: "steer",
    capability: "steer",
    requiresArguments: "Add instructions after /steer.",
    description: "Send instructions to the turn that is already running",
    argumentHint: "<instructions>",
  },
};

export interface ResolvedSessionActionCommand {
  kind: SessionActionCommandKind;
  /** Instructions for the action; empty only when the command allows it. */
  text: string;
  /** Set when the command was recognized but cannot run as submitted. */
  error?: string;
}

/**
 * Resolve a composer submission to a session action, or `null` to send it as an
 * ordinary prompt.
 *
 * `runningTurn` matters because these actions only exist relative to a live
 * turn: `/steer` typed while the agent is idle is a normal prompt, not an
 * error, which is what the Codex composer did before consolidation.
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
  if (!definition) return null;
  if (capabilities?.actions?.[definition.capability] !== true) return null;
  const argumentText = parsed.arguments?.trim() ?? "";
  if (!argumentText && definition.requiresArguments) {
    return { kind: definition.kind, text: "", error: definition.requiresArguments };
  }
  return { kind: definition.kind, text: argumentText };
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
  const parsed = parseLeadingSlashCommand(text);
  if (!parsed) return false;
  const sessionAction = SESSION_ACTION_SLASH_COMMANDS[parsed.name];
  if (sessionAction && capabilities?.actions?.[sessionAction.capability] === true) {
    return false;
  }
  return commands.some((command) => command.name.toLowerCase() === parsed.name);
}

/**
 * Merge the runtime's own commands into a provider's discovered list so the
 * menu advertises exactly what the composer can execute.
 */
export function withSessionActionSlashCommands(
  commands: readonly NativeAgentSlashCommand[],
  capabilities: NativeAgentCapabilities | undefined,
): NativeAgentSlashCommand[] {
  const merged = new Map<string, NativeAgentSlashCommand>(
    commands.map((command) => [command.name.toLowerCase(), command]),
  );
  for (const [name, definition] of Object.entries(SESSION_ACTION_SLASH_COMMANDS)) {
    if (capabilities?.actions?.[definition.capability] !== true) {
      // Never advertise an action this provider cannot perform: the old menu
      // listed `/steer` for Codex only because Codex owned the menu.
      merged.delete(name);
      continue;
    }
    merged.set(name, {
      name,
      description: definition.description,
      ...(definition.argumentHint ? { argumentHint: definition.argumentHint } : {}),
    });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
