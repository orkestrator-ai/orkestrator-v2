import { useState } from "react";
import { cn } from "@/lib/utils";
import type { LinearIssueListItem } from "@/types/linear";

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Up to two initials from a display name, the way Linear's own fallback avatar shows them. */
export function linearInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("");
  return letters.toUpperCase() || "?";
}

/**
 * The issue assignee's avatar, as Linear's board shows it in a card's corner:
 * their Linear avatar image, or their initials on Linear's colour for them when
 * they have no image or it fails to load. Renders nothing for an unassigned issue.
 * `decorative` hides it from assistive technology where the name is already shown.
 */
export function LinearAssigneeAvatar({
  issue,
  className,
  decorative = false,
}: {
  issue: Pick<LinearIssueListItem, "assigneeName" | "assigneeAvatarUrl" | "assigneeAvatarColor">;
  className?: string;
  decorative?: boolean;
}) {
  // The URL whose image failed, so a later avatar for the card is tried afresh.
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  const name = issue.assigneeName;
  if (!name) return null;
  const label = `Assigned to ${name}`;
  const base = "size-5 shrink-0 rounded-full";
  const url = issue.assigneeAvatarUrl;
  if (url && url !== failedUrl) {
    return (
      <img
        data-testid="linear-assignee-avatar"
        src={url}
        alt={decorative ? "" : label}
        aria-hidden={decorative || undefined}
        title={name}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={cn(base, "bg-muted object-cover", className)}
        onError={() => setFailedUrl(url)}
      />
    );
  }
  const color =
    issue.assigneeAvatarColor && HEX_COLOR.test(issue.assigneeAvatarColor)
      ? issue.assigneeAvatarColor
      : undefined;
  return (
    <span
      data-testid="linear-assignee-avatar"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      title={name}
      className={cn(
        base,
        "inline-flex select-none items-center justify-center text-[9px] font-semibold leading-none",
        color ? "text-white" : "bg-muted text-muted-foreground",
        className,
      )}
      style={color ? { backgroundColor: color } : undefined}
    >
      {linearInitials(name)}
    </span>
  );
}
