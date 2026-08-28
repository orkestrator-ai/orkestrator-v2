import { X } from "lucide-react";

type TerminalWarningBannerProps = {
  /** The warning text. Doubles as the live-region announcement. */
  message: string;
  onDismiss: () => void;
};

/**
 * The single overlay used for every terminal warning.
 *
 * Both the bootstrap and the replay warning render through here so that two
 * identically-styled banners cannot behave differently: whichever one is
 * showing, the dismiss control is in the same place and does the same thing.
 *
 * The dismiss affordance is a separate control rather than the message itself.
 * Making the message clickable gives the button the whole warning sentence as
 * its accessible name, which tells assistive technology nothing about what
 * activating it does, and gives sighted users no signal that the banner is
 * interactive at all.
 */
export function TerminalWarningBanner({ message, onDismiss }: TerminalWarningBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute top-2 left-2 z-20 flex max-w-[min(36rem,calc(100%-1rem))] items-start gap-2 rounded-md border border-amber-500/40 bg-amber-950/90 px-2.5 py-1.5 text-xs text-amber-100 shadow-md backdrop-blur-sm"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        aria-label="Dismiss terminal warning"
        title="Dismiss"
        onClick={onDismiss}
        className="-mr-0.5 shrink-0 cursor-pointer rounded-sm p-0.5 text-amber-300 transition-colors hover:bg-amber-500/20 hover:text-amber-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-300"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
