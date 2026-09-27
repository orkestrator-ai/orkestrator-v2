import { useEffect, useId, useRef, type ReactNode } from "react";
import { AlertCircle, Ban, Command, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { groupSlashCommandRuns } from "@/lib/chat/slash-command-search";
import { useViewportBoundedMenu } from "@/hooks/useViewportBoundedMenu";

/** Tallest the menu grows when the viewport has room. */
const PREFERRED_MAX_HEIGHT_PX = 256;

/**
 * Minimal shape the menu renders. Every agent's command type structurally
 * satisfies this — Claude parses it from SDK strings, the native projection
 * carries full descriptors — so the menu stays agent-neutral. Identity and
 * availability are optional: a legacy row without them still works.
 */
export interface SlashCommandOption {
  name: string;
  description?: string;
  argumentHint?: string;
  source?:
    | "builtin"
    | "project"
    | "user"
    | "plugin"
    | "skill"
    | "template"
    | "extension"
    | "orkestrator"
    | "unknown";
  id?: string;
  /** Exact text a selection inserts; defaults to `name`. */
  insertText?: string;
  aliases?: string[];
  availability?: { state: "available" | "unavailable"; reason?: string; message?: string };
}

const SOURCE_LABELS: Record<NonNullable<SlashCommandOption["source"]>, string> = {
  orkestrator: "Orkestrator",
  builtin: "Built in",
  project: "Project",
  user: "User",
  plugin: "Plugins",
  skill: "Skills",
  template: "Templates",
  extension: "Extensions",
  unknown: "Other",
};

/** What the menu should say about the list itself, beside the rows. */
export interface SlashCommandMenuStatus {
  state: "loading" | "ready" | "stale" | "unavailable" | "unsupported";
  /** Rows that belong to the provider, as opposed to Orkestrator's own actions. */
  providerCommandCount: number;
  /** Short, user-facing detail: an error explanation or the last refresh result. */
  detail?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}

/** The explicit ordinary-text path offered when a query matches nothing. */
export type SlashCommandLiteralEscape =
  | { kind: "offer"; onSendAsText: () => void }
  | { kind: "explain"; message: string };

interface SlashCommandMenuProps<TCommand extends SlashCommandOption> {
  /** Already-filtered commands to display, in navigation order. */
  commands: TCommand[];
  selectedIndex: number;
  onSelect: (command: TCommand) => void;
  onClose: () => void;
  /** Listbox id the input's `aria-controls` points at. */
  listboxId?: string;
  /** Stable row id for `aria-activedescendant`. */
  optionId?: (command: TCommand) => string;
  /** The token as typed, sigil included, kept visible in the no-match state. */
  query?: string;
  status?: SlashCommandMenuStatus;
  /** Why the last attempted row could not be chosen. */
  blockedMessage?: string | null;
  literalEscape?: SlashCommandLiteralEscape | null;
}

function StatusLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 text-xs text-muted-foreground">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/**
 * Dropdown shown when the user types "/" in a compose bar.
 *
 * Commands are pre-filtered and ranked by the caller; keyboard navigation lives
 * in `useSlashCommandMenu`, and focus stays in the input throughout. Source
 * headers are consecutive runs of the ranked list, so what is drawn is always
 * the order the arrow keys walk.
 */
export function SlashCommandMenu<TCommand extends SlashCommandOption>({
  commands,
  selectedIndex,
  onSelect,
  onClose,
  listboxId,
  optionId,
  query,
  status,
  blockedMessage,
  literalEscape,
}: SlashCommandMenuProps<TCommand>) {
  // Bound the height by the visible viewport so the list scrolls instead of
  // running off-screen on mobile, where the keyboard leaves little room.
  const { menuRef, setMenuRef, style, side } =
    useViewportBoundedMenu<HTMLDivElement>(PREFERRED_MAX_HEIGHT_PX);
  const selectedRef = useRef<HTMLDivElement>(null);
  const fallbackId = useId();
  const baseId = listboxId ?? `slash-menu-${fallbackId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // Keep the highlighted row visible as the selection moves.
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
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

  // Escape is handled by `useSlashCommandMenu` alongside the other keys.

  const hasQuery = (query?.length ?? 0) > 1;
  const noMatch = hasQuery && commands.length === 0;
  // A legacy caller passes no status and filters to at least one row itself.
  if (!status && commands.length === 0 && !noMatch) return null;

  const groups = groupSlashCommandRuns(commands);
  const showHeaders = !hasQuery;
  const stateLine = (() => {
    if (!status) return null;
    switch (status.state) {
      case "loading":
        return (
          <StatusLine icon={<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}>
            Loading commands…
          </StatusLine>
        );
      case "unsupported":
        return (
          <StatusLine icon={<Ban className="h-3.5 w-3.5" aria-hidden="true" />}>
            This agent doesn't expose provider commands.
          </StatusLine>
        );
      case "unavailable":
        return (
          <StatusLine icon={<AlertCircle className="h-3.5 w-3.5 text-amber-300" aria-hidden />}>
            Commands couldn't be loaded.{status.detail ? ` ${status.detail}` : ""}
          </StatusLine>
        );
      case "stale":
        return (
          <StatusLine icon={<AlertCircle className="h-3.5 w-3.5 text-amber-300" aria-hidden />}>
            This list may be out of date; commands are checked again when you send.
            {status.detail ? ` ${status.detail}` : ""}
          </StatusLine>
        );
      case "ready":
        return status.providerCommandCount === 0 && !hasQuery ? (
          <StatusLine icon={<Command className="h-3.5 w-3.5" aria-hidden="true" />}>
            This session has no provider commands.{status.detail ? ` ${status.detail}` : ""}
          </StatusLine>
        ) : status.detail ? (
          <StatusLine icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}>
            {status.detail}
          </StatusLine>
        ) : null;
    }
  })();
  const announcement = blockedMessage
    ? blockedMessage
    : noMatch
      ? `No commands match ${query}`
      : status?.state === "loading"
        ? "Loading commands"
        : status?.state === "unavailable"
          ? "Commands couldn't be loaded"
          : `${commands.length} ${commands.length === 1 ? "command" : "commands"} available`;
  const canRefresh =
    status?.onRefresh && (status.state === "stale" || status.state === "unavailable");

  return (
    <div
      ref={setMenuRef}
      data-slash-command-menu
      data-side={side}
      className={cn(
        "absolute z-50 w-full max-w-[36rem] overflow-y-auto overscroll-contain",
        "rounded-xl border border-zinc-700/70 bg-zinc-900/95 shadow-[0_18px_48px_rgba(0,0,0,0.42)] backdrop-blur-sm",
        "animate-in fade-in-0 zoom-in-95",
      )}
      style={style}
      // Keep focus (and the caret) in the composer while the pointer is used.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="p-1">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Slash Commands</div>
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
        {stateLine}
        {noMatch ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No commands match <span className="font-mono text-foreground">{query}</span>
          </div>
        ) : null}
        {commands.length > 0 ? (
          <div role="listbox" id={listboxId} aria-label="Slash commands">
            {groups.map((group, groupIndex) => {
              const label =
                SOURCE_LABELS[group.source as keyof typeof SOURCE_LABELS] ?? SOURCE_LABELS.unknown;
              const headerId = `${baseId}-group-${groupIndex}`;
              return (
                <div
                  key={`${group.source}:${groupIndex}`}
                  role="group"
                  aria-labelledby={showHeaders ? headerId : undefined}
                  aria-label={showHeaders ? undefined : label}
                >
                  {showHeaders ? (
                    <div
                      id={headerId}
                      className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase"
                    >
                      {label}
                    </div>
                  ) : null}
                  {group.entries.map(({ command, index }) => {
                    const isSelected = index === selectedIndex;
                    const unavailable =
                      command.availability?.state === "unavailable"
                        ? (command.availability.message ?? "Not available in this session")
                        : null;
                    const displayName = command.insertText ?? command.name;
                    return (
                      <div
                        key={optionId ? optionId(command) : `${group.source}:${command.name}`}
                        id={optionId?.(command)}
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={unavailable ? true : undefined}
                        ref={isSelected ? selectedRef : undefined}
                        onClick={() => onSelect(command)}
                        title={unavailable ?? (command.description || displayName)}
                        className={cn(
                          "flex w-full min-w-0 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                          isSelected
                            ? "bg-zinc-800/80 text-foreground"
                            : "hover:bg-zinc-800/70 hover:text-foreground",
                          unavailable && "text-muted-foreground",
                        )}
                      >
                        <Command className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span
                          className={cn(
                            "shrink-0 font-medium whitespace-nowrap",
                            unavailable && "line-through decoration-zinc-500",
                          )}
                        >
                          {displayName}
                        </span>
                        {command.argumentHint && (
                          <span className="shrink-0 text-xs text-zinc-500">
                            {command.argumentHint}
                          </span>
                        )}
                        {unavailable ? (
                          <span className="min-w-0 flex-1 truncate text-right text-xs text-amber-200/80">
                            {unavailable}
                          </span>
                        ) : command.description ? (
                          <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                            {command.description}
                          </span>
                        ) : null}
                        {hasQuery && command.source ? (
                          <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">
                            {SOURCE_LABELS[command.source]}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : null}
        {blockedMessage ? (
          <div className="px-2 py-1.5 text-xs text-amber-200" data-slash-command-blocked>
            {blockedMessage}
          </div>
        ) : null}
        {(noMatch || hasQuery) && literalEscape ? (
          literalEscape.kind === "offer" ? (
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <span>Not a command?</span>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-foreground underline-offset-2 hover:underline"
                onClick={literalEscape.onSendAsText}
              >
                Send as text
              </button>
            </div>
          ) : (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{literalEscape.message}</div>
          )
        ) : null}
        {canRefresh ? (
          <div className="flex justify-end px-2 py-1">
            <button
              type="button"
              disabled={status?.refreshing}
              onClick={status?.onRefresh}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground hover:bg-zinc-800 disabled:opacity-60"
            >
              <RefreshCw
                className={cn("h-3 w-3", status?.refreshing && "animate-spin")}
                aria-hidden="true"
              />
              {status?.refreshing ? "Refreshing…" : "Refresh commands"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
