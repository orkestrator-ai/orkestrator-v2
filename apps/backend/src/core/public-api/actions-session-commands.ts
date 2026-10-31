import { commandIsAvailable } from "@orkestrator/protocol/agent-command-catalogue";
import {
  commandSpellings,
  withSessionActionSlashCommands,
} from "@orkestrator/protocol/agent-slash-commands";
import {
  nativeAgentCapabilities,
  type NativeAgentSessionProjection,
  type NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import type {
  PublicSessionCommand,
  PublicSessionCommandList,
} from "@orkestrator/protocol/public-api-resources";
import {
  assertSessionAcceptsPrompt,
  dispatchOutcome,
  sessionPromptMode,
} from "./actions-sessions.js";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  onlyActionKeys,
  optionalBoolean,
  optionalString,
  requiredString,
  sessionTarget,
} from "./input.js";
import { enqueuePrompt, parseEnqueue } from "./prompt-delivery.js";
import { resolveSession, sessionActivity, type ResolvedSession } from "./sessions.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Selected slash commands through the public API.
 *
 * `session.commands` lists the session's catalogue as the backend already
 * holds it; `session.command` submits one descriptor as a *selection*
 * (`{ kind: "selected", commandId, bindingRevision }`) through the same
 * dispatch path the composer uses. A selection is binding: a command that is
 * missing, ambiguous, unavailable, changed since it was listed, or given the
 * wrong arguments is refused before admission with a stable code, and one
 * that changes between admission and dispatch fails the run. It is never sent
 * as ordinary prompt text instead.
 */

/** `/steer` exists only relative to a live turn; `session steer` is its public form. */
const EXCLUDED_COMMAND_IDS = new Set(["orkestrator:steer"]);

const DESCRIPTION_MAX_CHARS = 500;

function bounded(value: string | undefined, max = DESCRIPTION_MAX_CHARS): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sessionCommands(
  session: ResolvedSession,
  projection: NativeAgentSessionProjection | null,
): NativeAgentSlashCommand[] {
  if (!projection) return [];
  return withSessionActionSlashCommands(
    projection.slashCommands ?? [],
    nativeAgentCapabilities(session.agent),
  ).filter((command) => command.id && !EXCLUDED_COMMAND_IDS.has(command.id));
}

/** The public row: identity, availability and policy; never the private binding. */
function publicCommand(command: NativeAgentSlashCommand): PublicSessionCommand {
  return {
    id: command.id!,
    name: command.name,
    aliases: command.aliases ?? [],
    description: bounded(command.description),
    argumentHint: bounded(command.argumentHint, 200),
    source: command.source,
    bindingRevision: command.bindingRevision ?? null,
    available: commandIsAvailable(command),
    unavailableReason: commandIsAvailable(command)
      ? null
      : bounded(command.availability?.message ?? command.availability?.reason ?? "unavailable"),
    arguments: command.inputPolicy?.arguments ?? "optional",
    busy: command.inputPolicy?.busy ?? null,
  };
}

/** What listing and resolving a session's commands needs; a coordinator command supplies it too. */
export type SessionCommandContext = Pick<PublicActionContext, "command" | "invoke">;

function cachedProjection(
  context: Pick<PublicActionContext, "command">,
  session: ResolvedSession,
): NativeAgentSessionProjection | null {
  return (
    context.command.nativeAgents?.cachedProjectionSnapshot(
      session.environment.id,
      session.agent,
      session.logicalSessionKey,
    ) ?? null
  );
}

async function refreshedProjection(
  context: SessionCommandContext,
  session: ResolvedSession,
): Promise<{
  projection: NativeAgentSessionProjection | null;
  outcome: string;
  message?: string;
}> {
  if (!context.command.nativeAgents) {
    throw new PublicActionError("capability-unavailable", "Native agents are unavailable");
  }
  return context.invoke("refresh_native_agent_commands", {
    environmentId: session.environment.id,
    agent: session.agent,
    logicalSessionKey: session.logicalSessionKey,
  });
}

const sessionCommandsList: ReadActionHandler<{
  sessionId: string;
  environmentId: string;
  tabId: string;
  refresh: boolean;
}> = {
  kind: "read",
  action: "session.commands",
  parse(input) {
    onlyActionKeys(input, "session.commands");
    return { ...sessionTarget(input), refresh: optionalBoolean(input, "refresh") === true };
  },
  async run(input, context) {
    const session = await resolveSession(context, input);
    return { result: await listSessionCommands(context, session, input.refresh) };
  },
};

/** `session.commands` for one resolved session: its catalogue as the backend holds it. */
export async function listSessionCommands(
  context: SessionCommandContext,
  session: ResolvedSession,
  refresh: boolean,
): Promise<PublicSessionCommandList> {
  let projection = cachedProjection(context, session);
  let refreshed: PublicSessionCommandList["refresh"];
  if (refresh) {
    const read = await refreshedProjection(context, session);
    projection = read.projection ?? projection;
    refreshed = {
      outcome: read.outcome,
      ...(read.message ? { message: bounded(read.message)! } : {}),
    };
  }
  const catalogue = projection?.slashCommandCatalogue;
  return {
    sessionId: session.sessionId,
    agent: session.agent,
    catalogue: {
      status: catalogue?.status ?? (projection ? "unavailable" : "unknown"),
      revision: catalogue?.revision ?? null,
      fetchedAt: catalogue?.fetchedAt ?? null,
      error: bounded(catalogue?.error?.message ?? catalogue?.error?.code),
    },
    commands: sessionCommands(session, projection).map(publicCommand),
    ...(refreshed ? { refresh: refreshed } : {}),
  };
}

interface CommandInput {
  sessionId: string;
  environmentId: string;
  tabId: string;
  command: string;
  arguments?: string;
  expectedBindingRevision?: string;
  enqueue?: true;
}

/** Exact ID first; otherwise exactly one name or alias, with or without its sigil. */
export function selectCommand(
  commands: readonly NativeAgentSlashCommand[],
  wanted: string,
): NativeAgentSlashCommand {
  const byId = commands.find((command) => command.id === wanted);
  if (byId) return byId;
  const spellings = /^[/$]/.test(wanted) ? [wanted] : [`/${wanted}`, `$${wanted}`];
  const matches = commands.filter((command) =>
    commandSpellings(command).some((spelling) =>
      spellings.some((candidate) =>
        command.caseSensitive === true
          ? spelling === candidate
          : spelling.toLowerCase() === candidate.toLowerCase(),
      ),
    ),
  );
  // A shadowed row sharing a spelling with the one executable row is not a
  // competing candidate, matching the composer's own resolution.
  const available = matches.filter(commandIsAvailable);
  const candidates = matches.length > 1 && available.length === 1 ? available : matches;
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new PublicActionError(
      "not-found",
      "The session has no such command; `session commands` lists them",
    );
  }
  throw new PublicActionError("ambiguous-target", "That name matches more than one command", {
    details: { commandIds: candidates.slice(0, 16).map((command) => command.id) },
  });
}

/** Argument text is kept byte-for-byte; only an all-blank value means "none". */
export function commandArguments(raw: unknown): string | undefined {
  if (raw !== undefined && typeof raw !== "string") throw invalid("arguments must be a string");
  if (raw !== undefined && Buffer.byteLength(raw) > PUBLIC_API_LIMITS.commandArgumentsMaxBytes) {
    throw new PublicActionError("input-too-large", "arguments is too large");
  }
  return raw !== undefined && raw.trim().length > 0 ? raw : undefined;
}

export interface ResolvedSessionCommand {
  command: NativeAgentSlashCommand;
  commandId: string;
  bindingRevision: string | undefined;
  /** What the composer would send: the insert text, then the arguments verbatim. */
  text: string;
  intent: { kind: "selected"; commandId: string; bindingRevision?: string };
}

/**
 * Every check `session.command` makes before admission, shared with the
 * coordinator's `run_worker_command`: the session takes a prompt now (or a
 * queued one), the command exists exactly once, is available, has not changed
 * since it was listed, and gets the arguments it takes.
 */
export async function resolveSessionCommand(
  context: SessionCommandContext,
  session: ResolvedSession,
  input: Pick<CommandInput, "command" | "arguments" | "expectedBindingRevision" | "enqueue">,
): Promise<ResolvedSessionCommand> {
  assertSessionAcceptsPrompt(context, session, input.enqueue === true);
  const cached = cachedProjection(context, session);
  let commands = sessionCommands(session, cached);
  if (cached?.slashCommandCatalogue?.status !== "ready" || !cached.slashCommands?.length) {
    // Nothing read yet for this session (a fresh backend, a cold tab):
    // read the provider's list once rather than refusing a real command.
    commands = sessionCommands(session, (await refreshedProjection(context, session)).projection);
  }
  const command = selectCommand(commands, input.command);
  if (input.expectedBindingRevision && command.bindingRevision !== input.expectedBindingRevision) {
    throw new PublicActionError(
      "revision-conflict",
      `${command.name} changed since it was listed; list the commands again`,
      { details: { commandId: command.id, bindingRevision: command.bindingRevision ?? null } },
    );
  }
  if (!commandIsAvailable(command)) {
    throw new PublicActionError(
      "capability-unavailable",
      `${command.name} is unavailable: ${command.availability?.message ?? command.availability?.reason ?? "the provider reports it unavailable"}`.slice(
        0,
        500,
      ),
      { details: { commandId: command.id } },
    );
  }
  const policy = command.inputPolicy?.arguments;
  if (policy === "none" && input.arguments !== undefined) {
    throw invalid(`${command.name} takes no arguments`);
  }
  if (policy === "required" && input.arguments === undefined) {
    throw invalid(`${command.name} needs arguments`);
  }
  if (command.inputPolicy?.busy === "idle" && !input.enqueue) {
    const activity = sessionActivity(context, {
      environmentId: session.environment.id,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
    });
    if (activity !== "idle" && activity !== "unknown") {
      throw new PublicActionError("busy", `${command.name} runs when the agent is idle`, {
        details: { activity },
      });
    }
  }
  const commandId = command.id!;
  const bindingRevision = command.bindingRevision;
  return {
    command,
    commandId,
    bindingRevision,
    text: `${command.insertText ?? command.name}${input.arguments !== undefined ? ` ${input.arguments}` : ""}`,
    intent: { kind: "selected", commandId, ...(bindingRevision ? { bindingRevision } : {}) },
  };
}

const sessionCommand: MutationActionHandler<CommandInput> = {
  kind: "mutation",
  action: "session.command",
  parse(input) {
    onlyActionKeys(input, "session.command");
    const target = sessionTarget(input);
    const command = requiredString(input, "command", 500).trim();
    const args = commandArguments(input.arguments);
    const expectedBindingRevision = optionalString(input, "expectedBindingRevision", 200);
    const enqueue = parseEnqueue(input);
    const value: CommandInput = {
      ...target,
      command,
      ...(args !== undefined ? { arguments: args } : {}),
      ...(expectedBindingRevision ? { expectedBindingRevision } : {}),
      ...(enqueue ? { enqueue } : {}),
    };
    return {
      value,
      scope: `session:${target.sessionId}`,
      intent: {
        command,
        arguments: args ?? null,
        expectedBindingRevision: expectedBindingRevision ?? null,
        enqueue,
      },
    };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    const { commandId, bindingRevision, text, intent } = await resolveSessionCommand(
      context,
      session,
      input,
    );
    const mode = sessionPromptMode(context, session, undefined);
    return {
      resolved: {
        agent: session.agent,
        commandId: commandId.slice(0, 200),
        bindingRevision: bindingRevision?.slice(0, 200) ?? null,
        mode: mode ?? null,
        ...(input.enqueue ? { delivery: "queue" } : {}),
      },
      resources: {
        environmentId: session.environment.id,
        projectId: session.environment.projectId,
        sessionId: session.sessionId,
        tabId: session.tab.tabId,
      },
      async execute(operation) {
        const requestId = operation.operationId;
        const result = { runId: requestId, sessionId: session.sessionId, commandId };
        if (input.enqueue) {
          // The queue revalidates the selection at dequeue; a command that
          // changed while queued fails with its reason.
          return enqueuePrompt(
            context,
            operation,
            session,
            { text, ...(mode ? { mode } : {}), command: intent },
            result,
          );
        }
        await operation.update({
          stage: "dispatching",
          resources: { dispatchRequestId: requestId },
        });
        const outcome = await context.invoke<{ outcome: string; error?: string }>(
          "dispatch_native_agent_intent",
          {
            environmentId: session.environment.id,
            agent: session.agent,
            logicalSessionKey: session.logicalSessionKey,
            requestId,
            prompt: text,
            command: intent,
            ...(mode ? { mode } : {}),
          },
        );
        return dispatchOutcome(outcome.outcome, outcome.error, result);
      },
    };
  },
};

export const SESSION_COMMAND_HANDLERS: PublicActionHandler[] = [
  sessionCommandsList,
  sessionCommand,
];
