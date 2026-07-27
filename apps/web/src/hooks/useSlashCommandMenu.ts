import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SlashCommandOption } from "@/components/chat/SlashCommandMenu";

interface UseSlashCommandMenuOptions<TCommand extends SlashCommandOption> {
  /** Every command available for this session, unfiltered. */
  commands: TCommand[];
  /** Current composer text — the menu opens off a leading "/". */
  text: string;
  /** Replace the composer text with the chosen command, ready for arguments. */
  setText: (text: string) => void;
  /** Return focus to the input after a selection. */
  focusInput?: () => void;
}

interface UseSlashCommandMenuResult<TCommand extends SlashCommandOption> {
  isOpen: boolean;
  selectedIndex: number;
  filteredCommands: TCommand[];
  selectCommand: (command: TCommand) => void;
  closeMenu: () => void;
  /**
   * Handle a key press while the menu is open. Returns true when the key was
   * consumed, so the caller can stop before its own Enter/Tab handling.
   */
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
}

/**
 * Owns slash-command menu state and key bindings for a compose bar.
 *
 * All three agents previously kept their own copy of this. The detection effect
 * was identical, but the key handling had drifted: Codex wrapped around the
 * ends of the list and did not accept a command on Tab, while Claude and
 * OpenCode clamped and did. The clamping, Tab-accepting behaviour is the one
 * standardised here — wrapping makes it easy to shoot past the command you
 * wanted on a long list, and Tab-to-accept matches the @mention menu.
 */
export function useSlashCommandMenu<TCommand extends SlashCommandOption>({
  commands,
  text,
  setText,
  focusInput,
}: UseSlashCommandMenuOptions<TCommand>): UseSlashCommandMenuResult<TCommand> {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (text.startsWith("/") && commands.length > 0) {
      // Only offer completions until the command name is terminated by a
      // space; past that the user is typing arguments.
      const spaceIndex = text.indexOf(" ");
      if (spaceIndex === -1) {
        setFilter(text.slice(1));
        setIsOpen(true);
        setSelectedIndex(0);
      } else {
        setIsOpen(false);
      }
    } else {
      setIsOpen(false);
      setFilter("");
    }
  }, [text, commands.length]);

  const filteredCommands = useMemo(
    () =>
      commands.filter((command) =>
        command.name.toLowerCase().includes(filter.toLowerCase()),
      ),
    [commands, filter],
  );

  const closeMenu = useCallback(() => {
    setIsOpen(false);
  }, []);

  const selectCommand = useCallback(
    (command: TCommand) => {
      setText(`${command.name} `);
      setIsOpen(false);
      focusInput?.();
    },
    [setText, focusInput],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (!isOpen || filteredCommands.length === 0) return false;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((index) =>
            index < filteredCommands.length - 1 ? index + 1 : index,
          );
          return true;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((index) => (index > 0 ? index - 1 : index));
          return true;
        case "Tab":
        case "Enter": {
          // Shift+Enter is a newline and Shift+Tab is Codex's Plan/Build mode
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
          setIsOpen(false);
          return true;
        default:
          return false;
      }
    },
    [isOpen, filteredCommands, selectedIndex, selectCommand],
  );

  return {
    isOpen,
    selectedIndex,
    filteredCommands,
    selectCommand,
    closeMenu,
    handleKeyDown,
  };
}
