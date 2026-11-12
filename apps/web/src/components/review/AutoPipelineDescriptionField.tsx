import { lazy, Suspense, useState, type Ref } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * No fixed height: nothing sits below the description, so it grows to fill the
 * rest of the page, and past it with its content (the page scrolls, not the
 * pane). The textarea grows with its text through `field-sizing-content`.
 */
const PANE = "min-h-48 w-full grow rounded-md border border-border/70 focus-hairline outline-none";
const MessageMarkdown = lazy(() =>
  import("@/components/chat/MessageMarkdown").then((module) => ({
    default: module.MessageMarkdown,
  })),
);

/**
 * Rendered Markdown until the user clicks or presses Enter on it, then the raw
 * Markdown in a textarea; leaving the textarea shows the rendered result again.
 * Links in the rendered view open as links rather than starting an edit.
 */
export function AutoPipelineDescriptionField({
  value,
  disabled = false,
  onChange,
  inputRef,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const [editing, setEditing] = useState(false);
  if (editing && !disabled)
    return (
      <Textarea
        ref={inputRef}
        aria-label="Description"
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Dialog dismissal is intercepted by the owning DialogContent's capture hook.
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.blur();
          }
        }}
        className={cn(PANE, "resize-none font-mono text-xs leading-relaxed")}
      />
    );
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="Description, rendered. Activate to edit the Markdown"
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (disabled || (event.target as HTMLElement).closest("a")) return;
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (disabled || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setEditing(true);
        }
      }}
      className={cn(
        PANE,
        "overflow-x-auto bg-input-surface px-4 py-3 text-left text-sm shadow-xs",
        disabled ? "cursor-default opacity-70" : "cursor-text hover:border-border",
      )}
    >
      {value.trim() ? (
        <Suspense fallback={<p className="whitespace-pre-wrap break-words">{value}</p>}>
          <MessageMarkdown
            content={value}
            className="break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0"
          />
        </Suspense>
      ) : (
        <p className="text-muted-foreground italic">Click to add a description…</p>
      )}
    </div>
  );
}
