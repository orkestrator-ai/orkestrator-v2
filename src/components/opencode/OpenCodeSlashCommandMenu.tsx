import { useEffect, useRef } from "react";
import { Command } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OpenCodeSlashCommand } from "@/lib/opencode-client";

interface OpenCodeSlashCommandMenuProps {
  commands: OpenCodeSlashCommand[];
  selectedIndex: number;
  onSelect: (command: OpenCodeSlashCommand) => void;
  onClose: () => void;
}

export function OpenCodeSlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  onClose,
}: OpenCodeSlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  if (commands.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className={cn(
        "absolute z-50 max-h-64 w-full max-w-[36rem] overflow-y-auto",
        "animate-in fade-in-0 zoom-in-95 rounded-xl border border-zinc-700/70 bg-zinc-900/95 shadow-[0_18px_48px_rgba(0,0,0,0.42)] backdrop-blur-sm",
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
                "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                isSelected
                  ? "bg-zinc-800/80 text-foreground"
                  : "hover:bg-zinc-800/70 hover:text-foreground",
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
