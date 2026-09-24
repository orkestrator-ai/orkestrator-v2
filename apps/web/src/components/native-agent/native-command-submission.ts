/**
 * Decide what a composer submission is, before any prompt shaping.
 *
 * Mention serialization, handoff history, annotations and attachment
 * references all rewrite prompt text. A command's arguments must reach its
 * executor byte-for-byte, so the composer classifies the raw draft first and
 * only shapes text that is an ordinary prompt. The backend resolves the same
 * submission again, authoritatively; this is the convenience copy that lets
 * the composer refuse early with the draft intact.
 */
import {
  literalCommandSuppression,
  withCommandIdentities,
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
import type { NativeCommandSelection } from "@/stores/nativeComposeStore";

export const COMPACT_COMMAND_ID = "orkestrator:compact";
const STEER_COMMAND_ID = "orkestrator:steer";

export type SelectedCommandIntent = Extract<NativeAgentCommandIntent, { kind: "selected" }>;

export type NativeCommandSubmission =
  /** Ordinary prompt: shaped as before. `literal` only when the user chose it. */
  | { kind: "prompt"; intent?: { kind: "literal" } }
  /**
   * A command: send the raw draft text with this intent. `command` is absent
   * when the composer could not see the selected row (a list that is still
   * loading or unavailable); the backend decides.
   */
  | {
      kind: "command";
      intent: SelectedCommandIntent;
      command?: NativeAgentSlashCommand;
    }
  /** Orkestrator's compact action; never a prompt, never queued. */
  | { kind: "compact"; command: NativeAgentSlashCommand }
  /** Refused before sending; the draft is kept. */
  | { kind: "rejected"; message: string; literalEscape?: boolean };

export interface NativeCommandSubmissionInput {
  text: string;
  platform: AgentPlatform;
  agentLabel: string;
  commands: readonly NativeAgentSlashCommand[] | undefined;
  /** Absent from a backend that predates the command contract. */
  catalogue: NativeAgentCommandCatalogueState | undefined;
  selection: NativeCommandSelection | undefined;
  /** The user explicitly asked to send the text as an ordinary message. */
  literal?: boolean;
  attachments: readonly { type: "image" | "file" }[];
  annotationCount: number;
  pendingHandoff: boolean;
  /** A turn is running, so a prompt would be queued behind it. */
  busy: boolean;
}

export const HANDOFF_COMMAND_MESSAGE =
  "Send a normal message first to complete the agent handoff; slash commands cannot carry transferred history.";

function selectedIntent(command: NativeAgentSlashCommand): SelectedCommandIntent {
  return {
    kind: "selected",
    commandId: command.id!,
    ...(command.bindingRevision ? { bindingRevision: command.bindingRevision } : {}),
  };
}

/** Whether "send as text" can honestly be offered for this draft. */
export function literalEscapeAvailable(input: {
  text: string;
  platform: AgentPlatform;
  commands: readonly NativeAgentSlashCommand[] | undefined;
}): boolean {
  if (literalCommandSuppression(input.platform)) return true;
  // The provider reads prompt text itself: plain text is only plain when it
  // does not start with a command the provider knows.
  const providerCommands = (input.commands ?? []).filter(
    (command) => command.executionKind !== "session-action",
  );
  return (
    resolveCommandInvocation({
      text: input.text,
      intent: { kind: "typed" },
      commands: providerCommands,
    }).kind === "literal"
  );
}

export function literalEscapeRefusal(agentLabel: string): string {
  return `${agentLabel} reads messages that start with a command name as that command, so this can't be sent as plain text. Rephrase so it doesn't start with the command.`;
}

function attachmentRefusal(
  command: NativeAgentSlashCommand,
  attachments: NativeCommandSubmissionInput["attachments"],
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

export function classifyNativeCommandSubmission(
  input: NativeCommandSubmissionInput,
): NativeCommandSubmission {
  if (input.literal) {
    return literalEscapeAvailable(input)
      ? { kind: "prompt", intent: { kind: "literal" } }
      : { kind: "rejected", message: literalEscapeRefusal(input.agentLabel) };
  }
  // A backend without the contract keeps today's behaviour exactly.
  if (!input.catalogue) return { kind: "prompt" };
  const commands = withCommandIdentities(input.commands ?? []);
  const selection =
    input.selection && parseCommandToken(input.text, ["/", "$"])?.token === input.selection.token
      ? input.selection
      : undefined;
  const intent: NativeAgentCommandIntent = selection
    ? {
        kind: "selected",
        commandId: selection.commandId,
        ...(selection.bindingRevision ? { bindingRevision: selection.bindingRevision } : {}),
      }
    : { kind: "typed" };
  const resolution = resolveCommandInvocation({ text: input.text, intent, commands });
  const escape = literalCommandSuppression(input.platform);
  switch (resolution.kind) {
    case "literal":
      return { kind: "prompt" };
    case "stale-selection":
      // Only a list the backend calls authoritative can prove the selection
      // gone. Otherwise the backend revalidates it; nothing becomes text.
      if (input.catalogue.status === "ready") {
        return { kind: "rejected", message: resolution.message };
      }
      return { kind: "command", intent: intent as SelectedCommandIntent };
    case "unavailable":
    case "ambiguous":
      return { kind: "rejected", message: resolution.message, literalEscape: escape };
    case "invalid-arguments":
      return { kind: "rejected", message: resolution.message };
    case "command":
      break;
  }
  const { command } = resolution;
  // `/steer` with no running turn keeps its legacy path: the provider
  // answers it locally with usage text.
  if (command.id === STEER_COMMAND_ID) return { kind: "prompt" };
  if (input.annotationCount > 0) {
    return {
      kind: "rejected",
      message: `${command.name} can't include transcript annotations. Remove them and retry.`,
    };
  }
  const attachmentError = attachmentRefusal(command, input.attachments);
  if (attachmentError) return { kind: "rejected", message: attachmentError };
  if (command.id === COMPACT_COMMAND_ID) {
    if (input.busy) {
      return {
        kind: "rejected",
        message: `${command.name} runs only while ${input.agentLabel} is idle. Wait for the current turn to finish, then retry.`,
      };
    }
    return { kind: "compact", command };
  }
  if (input.pendingHandoff && command.executionKind !== "session-action") {
    return { kind: "rejected", message: HANDOFF_COMMAND_MESSAGE };
  }
  if (command.inputPolicy?.busy === "running" && !input.busy) {
    return {
      kind: "rejected",
      message: `${command.name} only works while ${input.agentLabel} is running a turn.`,
    };
  }
  return { kind: "command", intent: selectedIntent(command), command };
}

/** The intent a submission carries to the backend, if any. */
export function commandSubmissionIntent(
  submission: NativeCommandSubmission,
): NativeAgentCommandIntent | undefined {
  return submission.kind === "command" || submission.kind === "prompt"
    ? submission.intent
    : undefined;
}

/** How a command in the draft relates to a running turn, for the send button. */
export function draftCommandBusyTitle(
  command: NativeAgentSlashCommand | undefined,
  state: { running: boolean; canQueue: boolean; agentLabel: string },
): string | undefined {
  if (!command || !state.running) return undefined;
  if (command.id === COMPACT_COMMAND_ID) {
    return `${command.name} runs only while ${state.agentLabel} is idle`;
  }
  return command.inputPolicy?.busy === "idle" && state.canQueue
    ? `Queue ${command.name} — it runs when ${state.agentLabel} is idle`
    : undefined;
}
