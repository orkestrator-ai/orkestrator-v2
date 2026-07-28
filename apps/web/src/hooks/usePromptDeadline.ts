import { useEffect, useState } from "react";

/** Formats a live prompt deadline as `m:ss`, or null once it has expired. */
export function formatPromptDeadline(msRemaining: number): string | null {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return null;
  const totalSeconds = Math.ceil(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Shared countdown for blocking questions, permissions, and approvals.
 *
 * An absent deadline means the upstream protocol did not publish one and is
 * therefore not treated as expired. A present but invalid deadline fails
 * closed: the card becomes inert instead of leaving a dangerous action live.
 */
export function usePromptDeadline(expiresAt?: number): {
  remaining: string | null;
  expired: boolean;
} {
  const [remaining, setRemaining] = useState<string | null>(() =>
    expiresAt === undefined
      ? null
      : formatPromptDeadline(expiresAt - Date.now()),
  );

  useEffect(() => {
    if (expiresAt === undefined) {
      setRemaining(null);
      return;
    }
    const update = () =>
      setRemaining(formatPromptDeadline(expiresAt - Date.now()));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return {
    remaining,
    expired: expiresAt !== undefined && remaining === null,
  };
}
