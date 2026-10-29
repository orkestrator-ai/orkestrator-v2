import { useId } from "react";
import { cn } from "@/lib/utils";

const PLAY_PATH = "M15 14.2v7.6a1 1 0 0 0 1.5.86l6.1-4a1 1 0 0 0 0-1.32l-6.1-4a1 1 0 0 0-1.5.86z";

/**
 * "Run graph": lucide's `Network` with its bottom-right node swapped for an
 * outlined play triangle, so it reads as a graph and stays distinct from the
 * plain `Play` used by Run Commands. A mask clears the triangle's whole area
 * plus a gap around it, so its hollow centre is empty rather than showing the
 * graph through it. Masking rather than painting a background-coloured halo
 * keeps that holding on any button background (hover included). Decorative,
 * like lucide icons.
 */
export function GraphPlayIcon({ className }: { className?: string }) {
  // Mask ids are document-global, so each instance needs its own.
  const maskId = `graph-play-halo-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("lucide lucide-graph-play", className)}
      aria-hidden="true"
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="white" stroke="none" />
        <path d={PLAY_PATH} fill="black" stroke="black" strokeWidth={5.5} />
      </mask>
      <g mask={`url(#${maskId})`}>
        <rect x="9" y="2" width="6" height="6" rx="1" />
        <rect x="2" y="16" width="6" height="6" rx="1" />
        <path d="M12 12V8" />
        <path d="M5 16v-3a1 1 0 0 1 1-1h6.5" />
      </g>
      <path d={PLAY_PATH} />
    </svg>
  );
}
