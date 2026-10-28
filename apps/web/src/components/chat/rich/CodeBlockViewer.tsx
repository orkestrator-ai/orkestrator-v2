import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Copy, RotateCcw, WrapText, X } from "lucide-react";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyRichText } from "@/lib/chat/rich-markdown/clipboard";
import { useDialogFocusReturn } from "@/lib/chat/rich-markdown/dialog-focus";
import {
  pinRichViewKey,
  useRichContentViewStore,
  type RichViewState,
} from "@/stores/richContentViewStore";
import { cn } from "@/lib/utils";
import { RichToolbarButton } from "./RichBlockFrame";

/**
 * Read-only viewer for content too large for its inline block (a long fence,
 * a clipped message's full source). It shows the exact text, never edits or
 * writes a file, and closes with Escape; Radix traps focus, and
 * `useDialogFocusReturn` returns it to the control that opened it.
 */
export function SourceViewerDialog({
  open,
  onOpenChange,
  title,
  description,
  source,
  copyLabel = "source",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  source: string;
  copyLabel?: string;
}) {
  const [wrap, setWrap] = useState(false);
  const focusReturn = useDialogFocusReturn();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        {...focusReturn}
        size="full"
        className="flex max-h-[85vh] w-[min(64rem,calc(100vw-2rem))] flex-col gap-2"
      >
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
          <DialogDescription>
            {description ?? "Read-only view of the exact source. Nothing here writes a file."}
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex items-center justify-end gap-1"
          role="toolbar"
          aria-label="Viewer actions"
        >
          <RichToolbarButton label="Wrap lines" pressed={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText aria-hidden="true" />
          </RichToolbarButton>
          <RichToolbarButton
            label={`Copy ${copyLabel}`}
            onClick={() => void copyRichText(source, copyLabel)}
          >
            <Copy aria-hidden="true" />
          </RichToolbarButton>
        </div>
        <pre
          tabIndex={0}
          className={cn(
            "min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-5 text-foreground",
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
        >
          {source}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Pin displacement recovery.
 *
 * An open expanded view pins its scoped view state so eviction cannot drop it.
 * Pins are bounded (`maxPinnedViewStateEntries`); pinning past the bound
 * unpins the oldest pin. Its owner is told, closes its expanded view (it is no
 * longer protected) and shows a "Reopen" action that restores the view state
 * captured at the moment of displacement and pins it again. The captured
 * snapshots are bounded by the same limit and contain only view choices.
 */

const displacementListeners = new Map<string, Set<() => void>>();
const displacedSnapshots = new Map<string, RichViewState>();
const snapshotSubscribers = new Set<() => void>();

function emitSnapshots(): void {
  for (const subscriber of Array.from(snapshotSubscribers)) subscriber();
}

function subscribeSnapshots(subscriber: () => void): () => void {
  snapshotSubscribers.add(subscriber);
  return () => snapshotSubscribers.delete(subscriber);
}

function recordDisplacement(key: string): void {
  const current = useRichContentViewStore.getState().entries.get(key);
  // A find reveal is temporary and never restored.
  const snapshot: RichViewState = { ...current };
  delete snapshot.findRevealed;
  displacedSnapshots.delete(key);
  displacedSnapshots.set(key, snapshot);
  while (displacedSnapshots.size > FRONTEND_RENDER_POLICY.maxPinnedViewStateEntries) {
    const oldest = displacedSnapshots.keys().next().value;
    if (oldest === undefined) break;
    displacedSnapshots.delete(oldest);
  }
  emitSnapshots();
  for (const listener of Array.from(displacementListeners.get(key) ?? [])) listener();
}

function clearDisplacement(key: string): void {
  if (displacedSnapshots.delete(key)) emitSnapshots();
}

/**
 * Pin `key` and notify the owner of any pin this displaces. Every rich block
 * pins through here (not `pinRichViewKey` directly) so displacement is never
 * silent.
 */
export function pinRichViewWithRecovery(key: string): () => void {
  clearDisplacement(key);
  const pin = pinRichViewKey(key);
  if (pin.displaced !== null && pin.displaced !== key) recordDisplacement(pin.displaced);
  return pin.release;
}

/** Test seam: forget recorded displacements. */
export function resetRichViewPinRecovery(): void {
  displacedSnapshots.clear();
  emitSnapshots();
}

/**
 * Pin `key` while `active` (an open expanded view). When another block's pin
 * displaces this one, `onDisplaced` runs (the caller closes its expanded
 * view) and `displaced` becomes true until the user reopens or dismisses.
 * The flag also survives unmount/remount of the same identity.
 */
export function useRichViewPin(
  key: string,
  active: boolean,
  onDisplaced: () => void,
): { displaced: boolean; reopen: () => void; dismiss: () => void } {
  const onDisplacedRef = useRef(onDisplaced);
  useLayoutEffect(() => {
    onDisplacedRef.current = onDisplaced;
  });

  useEffect(() => {
    if (!active) return;
    const release = pinRichViewWithRecovery(key);
    const listener = () => onDisplacedRef.current();
    let listeners = displacementListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      displacementListeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = displacementListeners.get(key);
      current?.delete(listener);
      if (current?.size === 0) displacementListeners.delete(key);
      release();
    };
  }, [active, key]);

  const snapshot = useSyncExternalStore(
    subscribeSnapshots,
    () => displacedSnapshots.get(key),
    () => undefined,
  );

  const reopen = useCallback(() => {
    const saved = displacedSnapshots.get(key);
    clearDisplacement(key);
    // Restoring `expanded: true` re-opens the view, whose effect pins it again.
    useRichContentViewStore.getState().update(key, { ...saved, expanded: true });
  }, [key]);
  const dismiss = useCallback(() => clearDisplacement(key), [key]);

  return { displaced: snapshot !== undefined, reopen, dismiss };
}

/** The visible recovery affordance for a displaced expanded view. */
export function RichPinRecoveryNotice({
  what,
  onReopen,
  onDismiss,
}: {
  /** What was closed, e.g. "expanded chart". */
  what: string;
  onReopen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-rich-chrome="true"
      data-rich-pin-displaced="true"
      className="flex select-none flex-wrap items-center gap-2 border-b border-border/60 bg-amber-500/10 px-3 py-1 text-[11px] text-foreground"
    >
      <span className="min-w-0 flex-1">
        The {what} was closed because too many expanded views are open. Its view settings were kept.
      </span>
      <button
        type="button"
        onClick={onReopen}
        className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <RotateCcw aria-hidden="true" className="size-3" /> Reopen
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="inline-flex size-5 items-center justify-center rounded outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </div>
  );
}
