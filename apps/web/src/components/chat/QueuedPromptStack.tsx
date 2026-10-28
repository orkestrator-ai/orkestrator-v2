import {
  forwardRef,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { AlertCircle, CornerDownRight, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NativeComposeQueuedPrompt {
  id: string;
  text: string;
  /**
   * Steer this prompt into the running turn, draining it from the queue.
   * Absent when there is no live turn to steer or this prompt cannot be steered.
   */
  onSteer?: () => void | Promise<void>;
  /** Load this prompt back into the composer. Absent when it cannot be edited here. */
  onEdit?: () => void | Promise<void>;
  /** Remove this prompt from the queue. Absent when it needs the dialog to confirm. */
  onRemove?: () => void | Promise<void>;
}

export interface NativeComposeQueueState {
  length: number;
  error?: { message: string } | null;
  /** Opens the full queue manager (edit, reorder, remove). */
  onOpen: () => void;
  /** Queued prompts in run order: the first one is sent next. */
  items: readonly NativeComposeQueuedPrompt[];
}

export interface QueuedPromptStackHandle {
  /** Focus the first action nearest the input. False when no row has actions. */
  enter: () => boolean;
}

type QueuedPromptAction = "steer" | "edit" | "remove";

const ACTION_KEYS = {
  steer: "onSteer",
  edit: "onEdit",
  remove: "onRemove",
} as const satisfies Record<QueuedPromptAction, keyof NativeComposeQueuedPrompt>;

/** A keyboard-started action whose prompt may leave the queue, taking focus with it. */
interface PendingFocus {
  id: string;
  action: QueuedPromptAction;
  /** Prompt ids in run order when the action started. */
  order: string[];
  settled: boolean;
}

interface OwnedFocus {
  id: string;
  element: HTMLElement;
  order: string[];
}

const LABEL_PREVIEW_CHARS = 80;

function labelPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_PREVIEW_CHARS ? `${flat.slice(0, LABEL_PREVIEW_CHARS)}…` : flat;
}

function focusIsLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body;
}

interface QueuedPromptStackProps {
  queue: NativeComposeQueueState;
  /** Return focus to the prompt input, at the saved caret or at the end of its text. */
  onExit: (caret: "restore" | "end") => void;
}

/**
 * Every queued prompt as a strip on top of the composer, the next to run
 * nearest the input. Each strip can steer its own prompt into the running
 * turn, load it back into the composer, or drop it.
 *
 * Actionable rows form a roving tab stop. The composer hands focus in with
 * ArrowUp from its first line; ArrowUp and ArrowDown move between strips,
 * ArrowDown from the lowest strip or Escape goes back to the input.
 */
export const QueuedPromptStack = forwardRef<QueuedPromptStackHandle, QueuedPromptStackProps>(
  function QueuedPromptStack({ queue, onExit }, ref) {
    const [pending, setPending] = useState(false);
    const [activeId, setActiveId] = useState<string | null>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const rows = useRef(new Map<string, HTMLLIElement>());
    const ownedFocusRef = useRef<OwnedFocus | null>(null);
    const pendingFocusRef = useRef<PendingFocus | null>(null);
    const itemsRef = useRef(queue.items);
    const onExitRef = useRef(onExit);
    const hintId = useId();
    const { items, length } = queue;
    // Run order; index 0 sits nearest the input.
    const actionable = items
      .filter((item) => item.onSteer || item.onEdit || item.onRemove)
      .map((item) => item.id);
    const tabStopId =
      activeId !== null && actionable.includes(activeId) ? activeId : (actionable[0] ?? null);

    const focusRow = (id: string | undefined): boolean => {
      const button = id === undefined ? undefined : rows.current.get(id)?.querySelector("button");
      if (!button) return false;
      button.focus({ preventScroll: true });
      button.scrollIntoView?.({ block: "nearest" });
      return true;
    };

    useImperativeHandle(ref, () => ({
      enter: () => {
        pendingFocusRef.current = null;
        return focusRow(actionable[0]);
      },
    }));

    // Once a keyboard-started steer or removal takes its strip away, focus
    // would fall to the page. Move it to the strip that runs after it (which
    // takes its place), else the nearest one left, else the input.
    const settleFocus = () => {
      const after = pendingFocusRef.current;
      if (!after) return;
      const current = itemsRef.current;
      if (current.some((item) => item.id === after.id)) {
        // Still queued once settled: the action failed or the item came back.
        if (after.settled && focusIsLost()) focusRow(after.id);
        return;
      }
      // Edit loads the replacement draft after removing the queue item.
      if (after.action === "edit" && !after.settled) return;
      pendingFocusRef.current = null;
      if (!focusIsLost()) return;
      if (after.action === "edit") {
        onExitRef.current("end");
        return;
      }
      focusSurvivor(after, current);
    };

    const focusSurvivor = (
      after: { id: string; order: string[] },
      current: readonly NativeComposeQueuedPrompt[],
    ) => {
      // If only the focused action disappeared, prefer another action on its row.
      if (focusRow(after.id)) return;
      const live = new Set(
        current
          .filter((item) => item.onSteer || item.onEdit || item.onRemove)
          .map((item) => item.id),
      );
      const index = after.order.indexOf(after.id);
      const later = after.order.slice(index + 1).find((id) => live.has(id));
      const earlier = after.order
        .slice(0, index)
        .reverse()
        .find((id) => live.has(id));
      if (!focusRow(later ?? earlier ?? live.values().next().value)) onExitRef.current("restore");
    };

    useLayoutEffect(() => {
      itemsRef.current = items;
      onExitRef.current = onExit;
    });
    const onQueueChange = useEffectEvent(() => {
      const after = pendingFocusRef.current;
      settleFocus();
      const owned = ownedFocusRef.current;
      if (!pendingFocusRef.current && owned && !owned.element.isConnected) {
        ownedFocusRef.current = null;
        if (focusIsLost()) focusSurvivor(owned, itemsRef.current);
      }
      // A settled action whose prompt is still here after the queue changed
      // did not take it away; stop tracking it.
      if (after?.settled && pendingFocusRef.current === after) pendingFocusRef.current = null;
    });
    // Which prompts and actions are available, not the array identity, which a
    // provider tab rebuilds on every render.
    const queueSignature = JSON.stringify(
      items.map((item) => [item.id, !!item.onSteer, !!item.onEdit, !!item.onRemove]),
    );
    useEffect(() => {
      onQueueChange();
    }, [queueSignature]);

    useEffect(() => {
      const releaseFocus = (event: FocusEvent) => {
        if (event.target instanceof Node && !listRef.current?.contains(event.target)) {
          ownedFocusRef.current = null;
          pendingFocusRef.current = null;
        }
      };
      document.addEventListener("focusin", releaseFocus);
      return () => document.removeEventListener("focusin", releaseFocus);
    }, []);

    const run = async (item: NativeComposeQueuedPrompt, action: QueuedPromptAction) => {
      const callback = item[ACTION_KEYS[action]];
      if (!callback || pending) return;
      const active = document.activeElement;
      const fromStack = Boolean(active && listRef.current?.contains(active));
      const tracked: PendingFocus | null = fromStack
        ? { id: item.id, action, order: items.map((candidate) => candidate.id), settled: false }
        : null;
      pendingFocusRef.current = tracked;
      setPending(true);
      try {
        await callback();
      } finally {
        setPending(false);
        if (tracked && pendingFocusRef.current === tracked) {
          tracked.settled = true;
          settleFocus();
        }
      }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === "Escape") {
        // Handled here so the tab's Escape-to-stop does not also fire.
        event.preventDefault();
        pendingFocusRef.current = null;
        onExit("restore");
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-queued-prompt-id]");
      const index = actionable.indexOf(row?.dataset.queuedPromptId ?? "");
      if (index === -1) return;
      event.preventDefault();
      pendingFocusRef.current = null;
      if (event.key === "ArrowUp") {
        focusRow(actionable[index + 1]);
      } else if (!focusRow(actionable[index - 1])) {
        onExit("restore");
      }
    };

    if (length === 0) return null;
    const actionClass =
      "shrink-0 rounded text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 aria-disabled:cursor-wait aria-disabled:opacity-50";
    return (
      <div
        data-testid="compose-queue-strip"
        className="mx-auto w-[95%] rounded-t-lg border border-b-0 border-border/70 bg-input-surface text-xs"
      >
        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-0.5 text-[11px] text-muted-foreground">
          {queue.error ? (
            <AlertCircle className="h-3 w-3 shrink-0 text-destructive" aria-hidden="true" />
          ) : null}
          <span className="min-w-0 flex-1 truncate" aria-hidden="true">
            {queue.error ? `Blocked: ${queue.error.message}` : `${length} queued`}
          </span>
          <button
            type="button"
            onClick={queue.onOpen}
            className="shrink-0 rounded outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label={
              queue.error
                ? `${length} queued prompts blocked: ${queue.error.message}`
                : `View queued prompts (${length})`
            }
            title={
              queue.error
                ? `Queued prompt was not sent: ${queue.error.message}`
                : "View queued prompts"
            }
          >
            View all
          </button>
        </div>
        <span id={hintId} className="sr-only">
          Up and Down arrows move between queued prompts. Escape returns to the prompt input.
        </span>
        {/* Reversed so the next prompt sits nearest the input and the list
            opens scrolled to it; DOM and reading order stay in run order. */}
        <ul
          ref={listRef}
          aria-label="Queued prompts"
          onKeyDown={handleKeyDown}
          onFocusCapture={(event) => {
            const element = event.target as HTMLElement;
            const id =
              element.closest<HTMLElement>("[data-queued-prompt-id]")?.dataset.queuedPromptId;
            if (!id) return;
            setActiveId(id);
            ownedFocusRef.current = { id, element, order: items.map((item) => item.id) };
          }}
          className="flex max-h-28 flex-col-reverse overflow-y-auto pb-0.5"
        >
          {items.map((item, index) => {
            const position = `${index + 1} of ${length}`;
            const tabIndex = item.id === tabStopId ? 0 : -1;
            return (
              <li
                key={item.id}
                ref={(row) => {
                  if (row) rows.current.set(item.id, row);
                  else rows.current.delete(item.id);
                }}
                data-testid="compose-queue-item"
                data-queued-prompt-id={item.id}
                className="flex min-w-0 items-center gap-3 px-3 py-1 focus-within:bg-muted/40"
              >
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.text}>
                  {item.text}
                </span>
                {item.onSteer ? (
                  <button
                    type="button"
                    tabIndex={tabIndex}
                    // A mouse steer keeps focus in the prompt input, as the send button does.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void run(item, "steer")}
                    // Not `disabled`: that would drop keyboard focus mid-steer.
                    aria-disabled={pending || undefined}
                    aria-busy={pending}
                    aria-label={`Steer queued prompt ${position}: ${labelPreview(item.text)}`}
                    aria-describedby={hintId}
                    title="Send this prompt into the running turn now"
                    className={cn(
                      actionClass,
                      "flex items-center gap-1 px-0.5 hover:text-foreground",
                    )}
                  >
                    <CornerDownRight className="h-3.5 w-3.5" aria-hidden="true" />
                    Steer
                  </button>
                ) : null}
                {item.onEdit ? (
                  <button
                    type="button"
                    tabIndex={tabIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void run(item, "edit")}
                    aria-disabled={pending || undefined}
                    aria-busy={pending}
                    aria-label={`Edit queued prompt ${position}`}
                    title="Edit queued prompt"
                    className={cn(actionClass, "hover:text-foreground")}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
                {item.onRemove ? (
                  <button
                    type="button"
                    tabIndex={tabIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void run(item, "remove")}
                    aria-disabled={pending || undefined}
                    aria-busy={pending}
                    aria-label={`Remove queued prompt ${position}`}
                    title="Remove queued prompt"
                    className={cn(actionClass, "hover:text-destructive")}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  },
);
