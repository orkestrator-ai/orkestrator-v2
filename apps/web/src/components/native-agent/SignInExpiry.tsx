/**
 * One "Sign-in ends <date>" line under an account label, for every platform
 * (Agent Info's account card and Settings' sign-in card). Renders nothing when
 * the account reports no end.
 */
import { useState } from "react";
import { AlertTriangle, CalendarClock } from "lucide-react";
import type { NativeAgentAccount } from "@orkestrator/protocol/native-agent";
import { describeSignInExpiry, type SignInExpiryTone } from "@/lib/sign-in-expiry";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<SignInExpiryTone, string> = {
  upcoming: "text-muted-foreground",
  soon: "text-amber-500",
  ended: "font-medium text-destructive",
};

export function SignInExpiry({
  account,
  now,
  locale,
  className,
}: {
  account: Pick<NativeAgentAccount, "expiresAt" | "expiresAtEstimated"> | undefined;
  /** Fixed clock for tests and previews; the mount time otherwise. */
  now?: number;
  locale?: string;
  className?: string;
}) {
  // The line is read when the card opens; a card left open for days is rare
  // enough that it need not tick.
  const [mountedAt] = useState(() => Date.now());
  const line = describeSignInExpiry(account, now ?? mountedAt, locale);
  if (!line) return null;
  const Icon = line.tone === "upcoming" ? CalendarClock : AlertTriangle;
  return (
    <p
      data-sign-in-expiry={line.tone}
      title={line.note}
      className={cn("flex items-start gap-1 text-xs", TONE_CLASS[line.tone], className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0">
        {line.lead}
        <time dateTime={line.dateTime}>{line.date}</time>
        {line.trail}
        {line.note ? <span className="sr-only">. {line.note}</span> : null}
      </span>
    </p>
  );
}
