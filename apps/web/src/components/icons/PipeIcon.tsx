import { cn } from "@/lib/utils";

/**
 * A straight pipe section with a flange at each end, drawn in lucide's style.
 * Lucide has no pipe glyph, and this marks build pipeline environments in the
 * sidebar. Decorative, like lucide icons.
 */
export function PipeIcon({ className }: { className?: string }) {
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
      className={cn("lucide lucide-pipe", className)}
      aria-hidden="true"
    >
      <rect x="2" y="6" width="4" height="12" rx="1" />
      <rect x="18" y="6" width="4" height="12" rx="1" />
      <path d="M6 9h12" />
      <path d="M6 15h12" />
    </svg>
  );
}
