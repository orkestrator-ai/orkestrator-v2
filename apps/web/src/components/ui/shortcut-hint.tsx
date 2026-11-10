/** A key and what it does, as listed in a search palette's footer. */
export function ShortcutHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="rounded-md border border-border/70 bg-zinc-900 px-1.5 py-0.5 font-sans text-[10px] font-medium text-zinc-300">
        {keys}
      </kbd>
      <span>{label}</span>
    </span>
  );
}
