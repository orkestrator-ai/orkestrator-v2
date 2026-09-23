/**
 * Decide what a prompt submission executes, before anything is journaled.
 *
 * The composer, the queue worker, a recovery retry and a direct API call all
 * reach the provider through the same dispatch path, so they all resolve
 * command intent here, against the backend's authoritative catalogue, and get
 * the same answer. A plan is one of:
 *
 * - an ordinary prompt, literal or interpretable by the provider;
 * - a prompt carrying an explicit command the provider must revalidate;
 * - an Orkestrator session action (`/compact`);
 * - a rejection with a user-facing reason — the draft is kept, and nothing is
 *   ever downgraded from "run this command" to "send this text".
 */
import {
  isLegacyCommandId,
  literalCommandSuppression,
  type NativeAgentBridgeCommandInvocation,
} from "@orkestrator/protocol/agent-command-catalogue";
import {
  parseCommandToken,
  resolveCommandInvocation,
} from "@orkestrator/protocol/agent-slash-commands";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentCommandCatalogueState,
  NativeAgentCommandIntent,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";

export type CommandDispatchPlan =
  | {
      kind: "prompt";
      allowProviderCommands: boolean;
      command?: NativeAgentBridgeCommandInvocation;
      /**
       * The intent a retry must reuse. A typed command that resolved is
       * recorded as a selection so a retry can never re-resolve the same text
       * to a different command, or to plain text.
       */
      persistedIntent: NativeAgentCommandIntent;
      /** The resolved command's display name, for bounded diagnostics only. */
      commandName?: string;
    }
  | { kind: "session-action"; action: "compact"; commandName: string }
  | {
      kind: "rejected";
      message: string;
      /** A selection that was not found may be retried once after a forced re-read. */
      staleSelection?: boolean;
    };

export interface CommandDispatchInput {
  platform: AgentPlatform;
  agentLabel: string;
  prompt: string;
  intent: NativeAgentCommandIntent;
  /** Provider rows merged with session actions. */
  commands: readonly NativeAgentSlashCommand[];
  catalogue: NativeAgentCommandCatalogueState;
  structuredOutput: boolean;
  attachments: readonly { type: "image" | "file" }[];
  /** Current provider activity at the authoritative dispatch boundary. */
  busy?: boolean;
}

/** Whether resolving this submission needs the catalogue at all. */
export function commandDispatchNeedsCatalogue(
  platform: AgentPlatform,
  prompt: string,
  intent: NativeAgentCommandIntent,
): boolean {
  if (intent.kind === "selected") return true;
  if (!parseCommandToken(prompt, ["/", "$"])) return false;
  return intent.kind === "typed" || !literalCommandSuppression(platform);
}

function checkAttachments(
  command: NativeAgentSlashCommand,
  attachments: CommandDispatchInput["attachments"],
): string | undefined {
  if (attachments.length === 0) return undefined;
  const policy = command.inputPolicy?.attachments;
  if (policy === "none") {
    return `${command.name} does not accept attachments. Remove them and retry.`;
  }
  if (policy === "images" && attachments.some((attachment) => attachment.type !== "image")) {
    return `${command.name} accepts image attachments only. Remove the other files and retry.`;
  }
  return undefined;
}

export function planCommandDispatch(input: CommandDispatchInput): CommandDispatchPlan {
  if (input.intent.kind === "literal") {
    if (!literalCommandSuppression(input.platform)) {
      // The provider interprets prompt text itself and offers no way to say
      // "this is not a command". Refuse rather than run a command the caller
      // explicitly asked to send as text.
      const resolution = resolveCommandInvocation({
        text: input.prompt,
        intent: { kind: "typed" },
        commands: input.commands.filter((command) => command.executionKind !== "session-action"),
      });
      if (resolution.kind !== "literal") {
        return {
          kind: "rejected",
          message: `${input.agentLabel} would run this as a command and cannot send it as plain text. Rephrase so the message does not start with the command name.`,
        };
      }
    }
    return { kind: "prompt", allowProviderCommands: false, persistedIntent: { kind: "literal" } };
  }
  if (input.structuredOutput) {
    if (input.intent.kind === "selected") {
      return { kind: "rejected", message: "Commands cannot be combined with structured output." };
    }
    return { kind: "prompt", allowProviderCommands: false, persistedIntent: { kind: "literal" } };
  }
  const resolution = resolveCommandInvocation({
    text: input.prompt,
    intent: input.intent,
    commands: input.commands,
  });
  switch (resolution.kind) {
    case "literal":
      // Unknown slash text and paths stay ordinary prompts that the provider
      // may still interpret, exactly as before this contract existed.
      return { kind: "prompt", allowProviderCommands: true, persistedIntent: { kind: "typed" } };
    case "stale-selection":
      return {
        kind: "rejected",
        message:
          input.catalogue.status === "ready" || input.catalogue.status === "stale"
            ? resolution.message
            : `${input.agentLabel}'s command list is unavailable, so the selected command could not be verified. Nothing was sent.`,
        staleSelection: true,
      };
    case "unavailable":
    case "ambiguous":
    case "invalid-arguments":
      return { kind: "rejected", message: resolution.message };
    case "command":
      break;
  }
  const { command, token } = resolution;
  if (
    command.executionKind !== "session-action" &&
    command.inputPolicy?.busy === "idle" &&
    input.busy
  ) {
    return {
      kind: "rejected",
      message: `${command.name} runs when ${input.agentLabel} is idle. Try again after this turn.`,
    };
  }
  const attachmentError = checkAttachments(command, input.attachments);
  if (attachmentError) return { kind: "rejected", message: attachmentError };
  if (command.executionKind === "session-action") {
    if (command.id === "orkestrator:compact") {
      return { kind: "session-action", action: "compact", commandName: command.name };
    }
    // `/steer` reaching the prompt path means no turn was running when the
    // composer looked. Providers answer it locally with usage text rather
    // than starting a turn, so it keeps its legacy path.
    return {
      kind: "prompt",
      allowProviderCommands: true,
      persistedIntent: { kind: "typed" },
      commandName: command.name,
    };
  }
  const persistedIntent: NativeAgentCommandIntent = {
    kind: "selected",
    commandId: command.id!,
    ...(command.bindingRevision ? { bindingRevision: command.bindingRevision } : {}),
  };
  if (!input.catalogue.enhanced || isLegacyCommandId(command.id!)) {
    // A legacy bridge understands only prompt text; its rows have always run
    // that way. It is never handed a selection it would silently ignore.
    return {
      kind: "prompt",
      allowProviderCommands: true,
      persistedIntent,
      commandName: command.name,
    };
  }
  return {
    kind: "prompt",
    allowProviderCommands: true,
    command: {
      id: command.id!,
      name: command.name,
      executionKind: command.executionKind ?? "provider-prompt",
      ...(command.bindingRevision ? { bindingRevision: command.bindingRevision } : {}),
      arguments: token.arguments,
    },
    persistedIntent,
    commandName: command.name,
  };
}
