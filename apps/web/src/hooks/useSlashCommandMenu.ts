import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SlashCommandOption } from "@/components/chat/SlashCommandMenu";
import { rankSlashCommands } from "@/lib/chat/slash-command-search";

interface UseSlashCommandMenuOptions<TCommand extends SlashCommandOption> {
  /** Every command available for this session, unfiltered. */
  commands: TCommand[];
  /** Current composer text — the menu opens off a leading sigil. */
  text: string;
  /**
   * Replace the composer text with the chosen command, ready for arguments.
   * The command is passed so a caller can record the selection's identity.
   */
  setText: (text: string, command: TCommand) => void;
  /**
   * Return focus to the input after a selection, caret after the trailing
   * space. Composers restore the caret offset the user had while typing the
   * prefix, which lands mid-word once the name is completed.
   */
  focusInputAtEnd?: (expectedValue: string) => void;
  /**
   * Open on a leading sigil even when there are no rows, so the menu can say
   * why (loading, unavailable, no provider commands) instead of vanishing.
   */
  openWhenEmpty?: boolean;
}

export interface UseSlashCommandMenuResult<TCommand extends SlashCommandOption> {
  isOpen: boolean;
  /** Text typed after the sigil, exactly as typed. */
  query: string;
  selectedIndex: number;
  filteredCommands: TCommand[];
  selectCommand: (command: TCommand) => void;
  closeMenu: () => void;
  /**
   * Handle a key press while the menu is open. Returns true when the key was
   * consumed, so the caller can stop before its own Enter/Tab handling.
   */
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
  /** DOM id of the listbox, for the input's `aria-controls`. */
  listboxId: string;
  /** Stable DOM id of a row; derived from its identity, never its position. */
  optionId: (command: TCommand) => string;
  /** DOM id of the highlighted row, for `aria-activedescendant`. */
  activeOptionId?: string;
  /** Why the highlighted row could not be chosen, after an attempt. */
  blockedMessage: string | null;
}

/** Identity used to track a row across refreshes. */
export function slashCommandKey(command: SlashCommandOption): string {
  return command.id ?? `legacy:${command.name}`;
}

export function slashCommandUnavailableMessage(command: SlashCommandOption): string | null {
  if (command.availability?.state !== "unavailable") return null;
  return command.availability.message ?? `${command.name} is not available in this session.`;
}

function commandSpellings(command: SlashCommandOption): string[] {
  return [command.insertText ?? command.name, command.name, ...(command.aliases ?? [])];
}

/** Short, stable, attribute-safe token for a row identity. */
function domToken(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function isComposing(event: KeyboardEvent<HTMLElement>): boolean {
  const native = event.nativeEvent as globalThis.KeyboardEvent | undefined;
  return native?.isComposing === true || native?.keyCode === 229;
}

/**
 * Owns slash-command menu state and key bindings for a compose bar.
 *
 * Navigation clamps rather than wraps — wrapping makes it easy to shoot past
 * the command you wanted on a long list — and Tab accepts, matching the
 * @mention menu. The highlight follows a row's identity, not its index: a
 * catalogue refresh that reorders rows must not change what Enter chooses. It
 * falls back to the same position only when the highlighted row disappears.
 */
export function useSlashCommandMenu<TCommand extends SlashCommandOption>({
  commands,
  text,
  setText,
  focusInputAtEnd,
  openWhenEmpty = false,
}: UseSlashCommandMenuOptions<TCommand>): UseSlashCommandMenuResult<TCommand> {
  const listboxId = `slash-commands-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [dismissedText, setDismissedText] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ query: string; key: string } | null>(null);
  const [blocked, setBlocked] = useState<{ query: string; key: string; message: string } | null>(
    null,
  );
  const lastIndexRef = useRef(0);

  const acceptsDollar = useMemo(
    () =>
      commands.some((command) =>
        commandSpellings(command).some((spelling) => spelling.startsWith("$")),
      ),
    [commands],
  );
  /*
   * Only offer completions until the command token is terminated by
   * whitespace; past that the user is typing arguments.
   */
  const query = useMemo(() => {
    const sigil = text[0];
    if (sigil !== "/" && !(sigil === "$" && acceptsDollar)) return null;
    return /\s/.test(text) ? null : text.slice(1);
  }, [acceptsDollar, text]);
  const isOpen = query !== null && (commands.length > 0 || openWhenEmpty) && dismissedText !== text;

  const filteredCommands = useMemo(
    () => (query === null ? [] : rankSlashCommands(commands, query)),
    [commands, query],
  );
  const keys = useMemo(() => filteredCommands.map(slashCommandKey), [filteredCommands]);
  const activeKey = highlight && highlight.query === query ? highlight.key : null;
  let selectedIndex = -1;
  if (filteredCommands.length > 0) {
    const found = activeKey ? keys.indexOf(activeKey) : -1;
    selectedIndex =
      found >= 0
        ? found
        : activeKey
          ? Math.min(lastIndexRef.current, filteredCommands.length - 1)
          : 0;
  }
  const selectedKey = selectedIndex >= 0 ? keys[selectedIndex] : undefined;

  // Pin the highlight to the row under it, so a later refresh keeps that row.
  useEffect(() => {
    if (!isOpen || selectedKey === undefined || query === null) return;
    lastIndexRef.current = selectedIndex;
    if (highlight?.query !== query || highlight.key !== selectedKey) {
      setHighlight({ query, key: selectedKey });
    }
  }, [highlight, isOpen, query, selectedIndex, selectedKey]);

  const optionId = useCallback(
    (command: TCommand) => `${listboxId}-option-${domToken(slashCommandKey(command))}`,
    [listboxId],
  );

  const closeMenu = useCallback(() => {
    setDismissedText(text);
  }, [text]);

  const selectCommand = useCallback(
    (command: TCommand) => {
      const unavailable = slashCommandUnavailableMessage(command);
      if (unavailable) {
        // Listed so the user can see it exists, never inserted as if it could run.
        const key = slashCommandKey(command);
        setHighlight({ query: query ?? "", key });
        setBlocked({ query: query ?? "", key, message: unavailable });
        return;
      }
      const completedCommand = `${command.insertText ?? command.name} `;
      setBlocked(null);
      setText(completedCommand, command);
      focusInputAtEnd?.(completedCommand);
    },
    [focusInputAtEnd, query, setText],
  );

  const moveHighlight = useCallback(
    (delta: 1 | -1) => {
      if (query === null || selectedIndex < 0) return;
      const next = Math.max(0, Math.min(filteredCommands.length - 1, selectedIndex + delta));
      setHighlight({ query, key: keys[next]! });
    },
    [filteredCommands.length, keys, query, selectedIndex],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (!isOpen) return false;
      // An IME is still composing: every key belongs to the candidate window.
      if (isComposing(event)) return false;

      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp":
          if (filteredCommands.length === 0) return false;
          event.preventDefault();
          moveHighlight(event.key === "ArrowDown" ? 1 : -1);
          return true;
        case "Tab":
        case "Enter": {
          // Shift+Enter is a newline and Shift+Tab is the Plan/Build mode
          // toggle — neither is ever a selection.
          if (event.shiftKey) return false;
          const command = filteredCommands[selectedIndex];
          if (!command) return false;
          event.preventDefault();
          selectCommand(command);
          return true;
        }
        case "Escape":
          event.preventDefault();
          setDismissedText(text);
          return true;
        default:
          return false;
      }
    },
    [filteredCommands, isOpen, moveHighlight, selectCommand, selectedIndex, text],
  );

  const selectedCommand = selectedIndex >= 0 ? filteredCommands[selectedIndex] : undefined;
  return {
    isOpen,
    query: query ?? "",
    selectedIndex,
    filteredCommands,
    selectCommand,
    closeMenu,
    handleKeyDown,
    listboxId,
    optionId,
    activeOptionId: isOpen && selectedCommand ? optionId(selectedCommand) : undefined,
    blockedMessage:
      blocked && blocked.query === query && blocked.key === selectedKey ? blocked.message : null,
  };
}
