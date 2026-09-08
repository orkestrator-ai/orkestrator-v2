import { PlugZap, X } from "lucide-react";

type TerminalDisconnectedBannerProps = {
  /** Why this terminal has no shell, in the user's terms. */
  message: string;
  onReconnect: () => void;
  onDismiss: () => void;
};

/**
 * Shown when a terminal has no live PTY behind it.
 *
 * A terminal in this state is indistinguishable from a working one: it still
 * renders whatever was replayed into it, still shows a cursor, and still takes
 * focus — it just silently drops every keystroke. This banner is the only thing
 * that tells the user their input is going nowhere, so it carries the recovery
 * action rather than only reporting the state.
 */
export function TerminalDisconnectedBanner({
  message,
  onReconnect,
  onDismiss,
}: TerminalDisconnectedBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute top-2 left-2 z-20 flex max-w-[min(36rem,calc(100%-1rem))] items-start gap-2 rounded-md border border-red-500/40 bg-red-950/90 px-2.5 py-1.5 text-xs text-red-100 shadow-md backdrop-blur-sm"
    >
      <PlugZap className="mt-px h-3.5 w-3.5 shrink-0 text-red-300" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onReconnect}
        className="shrink-0 cursor-pointer rounded-sm border border-red-400/40 px-1.5 py-0.5 font-medium text-red-100 transition-colors hover:bg-red-500/20 focus-visible:outline focus-visible:outline-1 focus-visible:outline-red-300"
      >
        Reconnect
      </button>
      <button
        type="button"
        aria-label="Dismiss disconnected notice"
        title="Dismiss"
        onClick={onDismiss}
        className="-mr-0.5 shrink-0 cursor-pointer rounded-sm p-0.5 text-red-300 transition-colors hover:bg-red-500/20 hover:text-red-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-red-300"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
