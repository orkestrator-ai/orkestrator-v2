/**
 * The native composer's command surface: the `/` menu, the draft's selected
 * command identity, catalogue freshness, and intent classification.
 *
 * Kept out of the tab controller so the controller only asks two questions —
 * "is this key the menu's?" and "what is this submission?" — and the rules for
 * selection identity live next to the menu that creates it.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { withCommandIdentities } from "@orkestrator/protocol/agent-command-catalogue";
import {
  parseCommandToken,
  resolveCommandInvocation,
} from "@orkestrator/protocol/agent-slash-commands";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentCommandCatalogueErrorCode,
  NativeAgentCommandCatalogueState,
  NativeAgentCommandRefreshOutcome,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import {
  SlashCommandMenu,
  type SlashCommandLiteralEscape,
  type SlashCommandMenuStatus,
} from "@/components/chat/SlashCommandMenu";
import { useSlashCommandMenu } from "@/hooks/useSlashCommandMenu";
import type { NativeComposeDraft } from "@/stores/nativeComposeStore";
import {
  classifyNativeCommandSubmission,
  literalEscapeAvailable,
  literalEscapeRefusal,
  type NativeCommandSubmission,
  type NativeCommandSubmissionInput,
} from "./native-command-submission";

const EMPTY_COMMANDS: NativeAgentSlashCommand[] = [];
const DETAIL_MAX_LENGTH = 160;

const ERROR_EXPLANATIONS: Record<NativeAgentCommandCatalogueErrorCode, string> = {
  timeout: "The agent took too long to answer.",
  unreachable: "The agent couldn't be reached.",
  rejected: "The agent refused the request.",
  malformed: "The agent sent a list that couldn't be read.",
  "too-large": "The agent's command list was too large.",
  "provider-error": "The agent reported an error.",
};

const REFRESH_EXPLANATIONS: Record<NativeAgentCommandRefreshOutcome, string> = {
  reloaded: "Commands reloaded.",
  reread: "Command list checked again.",
  deferred: "Commands will reload when the agent is idle.",
  unsupported: "This agent can't reload its commands.",
  failed: "Refresh failed.",
};

function bounded(text: string): string {
  return text.length > DETAIL_MAX_LENGTH ? `${text.slice(0, DETAIL_MAX_LENGTH - 1)}…` : text;
}

function catalogueDetail(
  catalogue: NativeAgentCommandCatalogueState,
  showRefresh: boolean,
  localError: string | null,
): string | undefined {
  if (localError) return localError;
  const parts: string[] = [];
  if (catalogue.status === "unavailable" || catalogue.status === "stale") {
    if (catalogue.error) parts.push(ERROR_EXPLANATIONS[catalogue.error.code]);
  }
  if (
    catalogue.lastRefresh &&
    (showRefresh || catalogue.status === "stale" || catalogue.status === "unavailable")
  ) {
    parts.push(REFRESH_EXPLANATIONS[catalogue.lastRefresh.outcome]);
    if (catalogue.lastRefresh.outcome === "failed" && catalogue.lastRefresh.message) {
      parts.push(catalogue.lastRefresh.message);
    }
  }
  if (catalogue.truncated) parts.push("Only part of the list is shown.");
  return parts.length > 0 ? bounded(parts.join(" ")) : undefined;
}

export interface CommandRefreshResult {
  outcome: NativeAgentCommandRefreshOutcome;
  message?: string;
}

interface UseNativeCommandComposerOptions {
  platform: AgentPlatform;
  agentLabel: string;
  sessionKey: string;
  /** Provider session the composer is attached to, when known. */
  sessionId: string | undefined;
  slashCommands: NativeAgentSlashCommand[] | undefined;
  /** Absent from a backend that predates the command contract. */
  catalogue: NativeAgentCommandCatalogueState | undefined;
  draft: NativeComposeDraft;
  updateDraft: (sessionKey: string, update: Partial<NativeComposeDraft>) => void;
  inputRef: RefObject<MentionableInputRef | null>;
  refreshCommands: () => Promise<CommandRefreshResult>;
  /** Submit the current draft as an ordinary message (literal intent). */
  onSendAsText: () => void;
}

export type NativeCommandClassificationInput = Pick<
  NativeCommandSubmissionInput,
  "text" | "literal" | "attachments" | "annotationCount" | "pendingHandoff" | "busy"
>;

export function useNativeCommandComposer({
  platform,
  agentLabel,
  sessionKey,
  sessionId,
  slashCommands,
  catalogue,
  draft,
  updateDraft,
  inputRef,
  refreshCommands,
  onSendAsText,
}: UseNativeCommandComposerOptions) {
  const commands = useMemo(
    () => (slashCommands ? withCommandIdentities(slashCommands) : EMPTY_COMMANDS),
    [slashCommands],
  );
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedHere, setRefreshedHere] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  /** Draft text for which a refused send offered "send as text". */
  const [literalOfferText, setLiteralOfferText] = useState<string | null>(null);

  const selection = draft.commandSelection;
  // A selection belongs to one provider session. Another provider, or a
  // resumed/forked session, is a different authority: drop the identity and
  // leave the text for the user to re-select or send.
  useEffect(() => {
    if (!selection) return;
    const platformChanged = selection.platform !== undefined && selection.platform !== platform;
    const sessionChanged =
      selection.sessionId !== undefined &&
      sessionId !== undefined &&
      selection.sessionId !== sessionId;
    if (platformChanged || sessionChanged) {
      updateDraft(sessionKey, { commandSelection: undefined });
    }
  }, [platform, selection, sessionId, sessionKey, updateDraft]);

  const setTextFromMenu = useCallback(
    (text: string, command: NativeAgentSlashCommand) => {
      const token = parseCommandToken(text, ["/", "$"])?.token;
      updateDraft(sessionKey, {
        text,
        commandSelection:
          catalogue && command.id && token
            ? {
                commandId: command.id,
                ...(command.bindingRevision ? { bindingRevision: command.bindingRevision } : {}),
                token,
                platform,
                ...(sessionId ? { sessionId } : {}),
              }
            : undefined,
      });
    },
    [catalogue, platform, sessionId, sessionKey, updateDraft],
  );
  const focusInputAtEnd = useCallback(
    (expectedValue: string) => inputRef.current?.focusAtEnd(expectedValue),
    [inputRef],
  );
  const menu = useSlashCommandMenu({
    commands,
    text: draft.text,
    setText: setTextFromMenu,
    focusInputAtEnd,
    openWhenEmpty: Boolean(catalogue),
  });

  const refresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    void refreshCommands()
      .then((result) => {
        setRefreshedHere(true);
        if (result.outcome === "failed" && result.message) {
          setRefreshError(bounded(`${REFRESH_EXPLANATIONS.failed} ${result.message}`));
        }
      })
      .catch((error: unknown) => {
        setRefreshError(
          bounded(
            `Couldn't refresh commands: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      })
      .finally(() => setRefreshing(false));
  }, [refreshCommands, refreshing]);

  const status: SlashCommandMenuStatus | undefined = catalogue
    ? {
        state: catalogue.status,
        providerCommandCount: commands.filter(
          (command) => command.executionKind !== "session-action",
        ).length,
        detail: catalogueDetail(catalogue, refreshedHere, refreshError),
        onRefresh: refresh,
        refreshing,
      }
    : undefined;

  const menuLiteralEscape = useMemo((): SlashCommandLiteralEscape | null => {
    // A backend without the contract has no literal intent to honour.
    if (!catalogue || !menu.isOpen || menu.query.length === 0) return null;
    const exact =
      resolveCommandInvocation({ text: draft.text, intent: { kind: "typed" }, commands }).kind !==
      "literal";
    if (menu.filteredCommands.length > 0 && !exact) return null;
    return literalEscapeAvailable({ text: draft.text, platform, commands })
      ? { kind: "offer", onSendAsText }
      : { kind: "explain", message: literalEscapeRefusal(agentLabel) };
  }, [
    agentLabel,
    catalogue,
    commands,
    draft.text,
    menu.filteredCommands.length,
    menu.isOpen,
    menu.query.length,
    onSendAsText,
    platform,
  ]);

  const menuElement: ReactNode = menu.isOpen ? (
    <SlashCommandMenu
      commands={menu.filteredCommands}
      selectedIndex={menu.selectedIndex}
      onSelect={menu.selectCommand}
      onClose={menu.closeMenu}
      listboxId={menu.listboxId}
      optionId={menu.optionId}
      query={draft.text}
      status={status}
      blockedMessage={menu.blockedMessage}
      literalEscape={menuLiteralEscape}
    />
  ) : null;

  const classify = useCallback(
    (input: NativeCommandClassificationInput): NativeCommandSubmission => {
      const result = classifyNativeCommandSubmission({
        ...input,
        platform,
        agentLabel,
        commands,
        catalogue,
        selection,
      });
      setLiteralOfferText(result.kind === "rejected" && result.literalEscape ? input.text : null);
      return result;
    },
    [agentLabel, catalogue, commands, platform, selection],
  );

  /** The command the draft would run as typed, for send-button hints. */
  const draftCommand = useMemo(() => {
    if (!catalogue) return undefined;
    const resolution = resolveCommandInvocation({
      text: draft.text,
      intent: selection
        ? {
            kind: "selected",
            commandId: selection.commandId,
            ...(selection.bindingRevision ? { bindingRevision: selection.bindingRevision } : {}),
          }
        : { kind: "typed" },
      commands,
    });
    return resolution.kind === "command" ? resolution.command : undefined;
  }, [catalogue, commands, draft.text, selection]);

  const clearSelection = useCallback(() => {
    if (selection) updateDraft(sessionKey, { commandSelection: undefined });
  }, [selection, sessionKey, updateDraft]);

  return {
    menuOpen: menu.isOpen,
    menuElement,
    handleMenuKeyDown: menu.handleKeyDown,
    inputComboboxAria: {
      expanded: menu.isOpen,
      controls: menu.isOpen && menu.filteredCommands.length > 0 ? menu.listboxId : undefined,
      activeDescendant: menu.activeOptionId,
    },
    classify,
    draftCommand,
    clearSelection,
    /** Show "Send as text" beside a refusal only while the refused text is unchanged. */
    offerLiteralForDraft: literalOfferText !== null && literalOfferText === draft.text,
  };
}
