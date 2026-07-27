import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface BlockingPromptCardProps {
  children: ReactNode;
  className?: string;
  role?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  "data-session-id"?: string;
  "data-client-url"?: string;
}

/**
 * Container for any prompt the turn is blocked on — approvals, permission
 * requests and questions.
 *
 * One treatment across all three agents. Claude and OpenCode used a neutral
 * `bg-card` panel while Codex used an amber-accented one; amber wins because it
 * is the only one that reads as "this is waiting for you" rather than as
 * another message. The cards are pinned above the composer, so they carry no
 * outer margin of their own — the dock supplies the spacing.
 */
export function BlockingPromptCard({
  children,
  className,
  ...dataProps
}: BlockingPromptCardProps) {
  return (
    <div
      {...dataProps}
      className={cn(
        "overflow-hidden rounded-lg border border-amber-500/40 bg-amber-500/5 shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}
