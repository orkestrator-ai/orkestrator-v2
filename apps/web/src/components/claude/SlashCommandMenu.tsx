import { useEffect, useRef } from "react";
import { Command } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SlashCommand {
  name: string;
  description?: string;
}

interface SlashCommandMenuProps {
  /** Already-filtered commands to display */
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

/**
 * SlashCommandMenu displays a list of slash commands
 * that appears when the user types "/" in the compose bar.
 *
 * Note: Commands should be pre-filtered by the parent component.
 * Keyboard navigation (arrows, enter, escape) is handled by the parent.
 */
export function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  onClose,
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Note: Escape key handling is done by the parent component's handleKeyDown

  if (commands.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className={cn(
        "absolute z-50 max-h-64 w-full max-w-[36rem] overflow-y-auto",
        "rounded-xl border border-zinc-700/70 bg-zinc-900/95 shadow-[0_18px_48px_rgba(0,0,0,0.42)] backdrop-blur-sm",
        "animate-in fade-in-0 zoom-in-95"
      )}
      style={{ bottom: "100%", left: 0, marginBottom: "4px" }}
    >
      <div className="p-1">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          Slash Commands
        </div>
        {commands.map((command, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={command.name}
              ref={isSelected ? selectedRef : undefined}
              onClick={() => onSelect(command)}
              title={command.description || command.name}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                "transition-colors",
                isSelected
                  ? "bg-zinc-800/80 text-foreground"
                  : "hover:bg-zinc-800/70 hover:text-foreground"
              )}
            >
              <Command className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-medium whitespace-nowrap">{command.name}</span>
              {command.description && (
                <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                  {command.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Normalize a command name to always have the "/" prefix
 */
function normalizeCommandName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Parse slash commands from an array of command strings.
 * Commands come from the SDK as strings like "/compact", "/clear", etc.
 * Custom commands may have descriptions in the format "/name - description"
 */
export function parseSlashCommands(
  commandStrings: string[] | undefined
): SlashCommand[] {
  if (!commandStrings || commandStrings.length === 0) {
    return [];
  }

  // Use a Map to deduplicate by name, preferring entries with descriptions
  const commandMap = new Map<string, SlashCommand>();

  for (const cmd of commandStrings) {
    // Handle format "/name - description" or just "/name"
    const dashIndex = cmd.indexOf(" - ");
    let name: string;
    let description: string | undefined;

    if (dashIndex !== -1) {
      name = normalizeCommandName(cmd.slice(0, dashIndex));
      description = cmd.slice(dashIndex + 3).trim();
    } else {
      name = normalizeCommandName(cmd);
    }

    const existing = commandMap.get(name);
    // Keep the entry with a description, or the first one seen
    if (!existing || (description && !existing.description)) {
      commandMap.set(name, { name, description });
    }
  }

  // Sort alphabetically by name
  return Array.from(commandMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
