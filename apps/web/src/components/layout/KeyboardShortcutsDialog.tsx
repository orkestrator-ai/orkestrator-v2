import { useEffect, useMemo, useState } from "react";
import { Keyboard, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  detectShortcutPlatform,
  filterKeyboardShortcuts,
  isKeyboardShortcutsShortcut,
  shortcutKeys,
  type ShortcutPlatform,
} from "@/lib/keyboard-shortcuts";

function KeyCaps({ keys }: { keys: readonly string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className="min-w-5 rounded-md border border-border/70 bg-zinc-900 px-1.5 py-0.5 text-center font-sans text-[11px] font-medium text-zinc-300"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/**
 * The dialog body. It unmounts when the dialog closes, so every open starts
 * with an empty search; the dialog focuses the search input as it opens.
 */
function KeyboardShortcutsPanel({ platform }: { platform: ShortcutPlatform }) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => filterKeyboardShortcuts(query, platform), [query, platform]);
  const openShortcut = platform === "mac" ? ["⌘", "⇧", "K"] : ["Ctrl", "Shift", "K"];

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search keyboard shortcuts..."
          aria-label="Search keyboard shortcuts"
          aria-controls="keyboard-shortcuts-list"
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div
        id="keyboard-shortcuts-list"
        data-testid="keyboard-shortcuts-list"
        className="max-h-[28rem] overflow-y-auto px-2 py-2"
      >
        {groups.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-muted-foreground">
            No shortcuts match that search.
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <section key={group.id} aria-labelledby={`keyboard-shortcuts-${group.id}`}>
                <h3
                  id={`keyboard-shortcuts-${group.id}`}
                  className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500"
                >
                  {group.title}
                </h3>
                <ul className="space-y-0.5">
                  {group.shortcuts.map((shortcut) => (
                    <li
                      key={shortcut.id}
                      data-testid={`keyboard-shortcut-${shortcut.id}`}
                      className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm text-zinc-200"
                    >
                      <span className="min-w-0 flex-1 truncate">{shortcut.description}</span>
                      <KeyCaps keys={shortcutKeys(shortcut, platform) ?? []} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-border/70 px-4 py-2 text-[11px] text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <Keyboard className="h-3.5 w-3.5" aria-hidden="true" />
          Keyboard shortcuts
        </span>
        <span className="inline-flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <KeyCaps keys={openShortcut} />
            <span>Toggle</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <KeyCaps keys={["Esc"]} />
            <span>Close</span>
          </span>
        </span>
      </div>
    </>
  );
}

/** Lists every keyboard shortcut, searchable; toggled with ⌘⇧K / Ctrl+Shift+K. */
export function KeyboardShortcutsDialog({
  platform: platformOverride,
}: {
  platform?: ShortcutPlatform;
}) {
  const [open, setOpen] = useState(false);
  const platform = useMemo(() => platformOverride ?? detectShortcutPlatform(), [platformOverride]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isKeyboardShortcutsShortcut(event)) return;
      event.preventDefault();
      setOpen((current) => !current);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        data-testid="keyboard-shortcuts-dialog"
        className="max-w-2xl gap-0 overflow-hidden p-0 sm:max-w-2xl sm:p-0"
      >
        <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
        <DialogDescription className="sr-only">
          Every keyboard shortcut in Orkestrator. Type to filter the list.
        </DialogDescription>
        <KeyboardShortcutsPanel platform={platform} />
      </DialogContent>
    </Dialog>
  );
}
