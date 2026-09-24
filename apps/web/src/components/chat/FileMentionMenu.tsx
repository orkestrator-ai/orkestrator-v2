import { useEffect, useRef, type ReactNode } from "react";
import { Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/components/files-panel/FileIcon";
import { useViewportBoundedMenu } from "@/hooks/useViewportBoundedMenu";
import type { FileCandidate } from "@/types";

/** Tallest the menu grows when the viewport has room (Tailwind `max-h-96`). */
const PREFERRED_MAX_HEIGHT_PX = 384;

interface FileMentionMenuProps {
  files: FileCandidate[];
  selectedIndex: number;
  onSelect: (file: FileCandidate) => void;
  onClose: () => void;
}

export function FileMentionMenu({ files, selectedIndex, onSelect, onClose }: FileMentionMenuProps) {
  const { menuRef, setMenuRef, style, side } =
    useViewportBoundedMenu<HTMLDivElement>(PREFERRED_MAX_HEIGHT_PX);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [selectedIndex]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuRef, onClose]);

  // Height is bounded by the visible viewport so the list scrolls rather than
  // running off-screen on mobile, where the keyboard leaves little room.
  function renderShell(children: ReactNode) {
    return (
      <div
        ref={setMenuRef}
        role="listbox"
        aria-label="File and folder suggestions"
        data-side={side}
        className={cn(
          "absolute z-50 w-full min-w-0 overflow-y-auto overscroll-contain rounded-xl border border-zinc-700/70 bg-zinc-900/95 shadow-[0_18px_48px_rgba(0,0,0,0.42)] backdrop-blur-sm sm:w-96",
          "animate-in fade-in-0 zoom-in-95",
        )}
        style={style}
      >
        {children}
      </div>
    );
  }

  if (files.length === 0) {
    return renderShell(
      <div className="p-3 text-center text-sm text-muted-foreground" role="status">
        No files or folders found
      </div>,
    );
  }

  return renderShell(
    <div className="p-1">
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground" aria-hidden="true">
        Files & Folders
      </div>
      {files.map((file, index) => {
        const isSelected = index === selectedIndex;
        const lastSlashIndex = file.relativePath.lastIndexOf("/");
        const directory = lastSlashIndex >= 0 ? file.relativePath.slice(0, lastSlashIndex) : "";

        return (
          <button
            key={file.relativePath}
            ref={isSelected ? selectedRef : undefined}
            role="option"
            aria-selected={isSelected}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              onSelect(file);
            }}
            onClick={(event) => {
              event.preventDefault();
              if (event.detail === 0) {
                onSelect(file);
              }
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
              isSelected
                ? "bg-zinc-800/80 text-foreground"
                : "hover:bg-zinc-800/70 hover:text-foreground",
            )}
          >
            {file.isDirectory ? (
              <Folder
                className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400"
                aria-hidden="true"
              />
            ) : (
              <FileIcon filename={file.filename} className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate font-medium">{file.filename}</span>
            {directory && (
              <span
                className={cn(
                  "ml-auto max-w-[160px] truncate text-xs",
                  isSelected ? "text-primary-foreground/80" : "text-muted-foreground",
                )}
              >
                {directory}
              </span>
            )}
          </button>
        );
      })}
    </div>,
  );
}
