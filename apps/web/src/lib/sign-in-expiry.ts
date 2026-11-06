/**
 * The "Sign-in ends <date>" line every platform's account shows, worked out
 * from the provider-neutral `NativeAgentAccount.expiresAt` alone, so Claude,
 * Cursor and any later provider that reports a login's end read the same.
 */
import type { NativeAgentAccount } from "@orkestrator/protocol/native-agent";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long before the end the line asks for attention. */
export const SIGN_IN_EXPIRY_ATTENTION_MS = 3 * DAY_MS;
/**
 * An estimated end may come this much earlier, so attention starts that much
 * sooner too: the user is warned before the earliest likely end, not after.
 */
export const SIGN_IN_EXPIRY_ESTIMATE_MARGIN_MS = 3 * DAY_MS;

/** `upcoming`: nothing to do yet; `soon`: sign in again shortly; `ended`: probably over. */
export type SignInExpiryTone = "upcoming" | "soon" | "ended";

export interface SignInExpiryLine {
  tone: SignInExpiryTone;
  /** The whole sentence, for labels and tests. */
  text: string;
  /** The parts around the date, so the date can be a `<time>` element. */
  lead: string;
  date: string;
  trail: string;
  /** The canonical instant, for `<time dateTime>`. */
  dateTime: string;
  /** Why the date is approximate, when it is. */
  note?: string;
}

export const SIGN_IN_EXPIRY_ESTIMATE_NOTE =
  "An estimate from the provider: the sign-in may end a few days earlier.";

/** `3 Dec 2026` in the user's locale (`Dec 3, 2026` in en-US). */
export function formatSignInExpiryDate(ms: number, locale?: string): string {
  return new Date(ms).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function remaining(ms: number): string {
  if (ms < DAY_MS) return "within a day";
  const days = Math.floor(ms / DAY_MS);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The line for an account, or undefined when it reports no end (or one that
 * is not a date): a missing date is an absent line, never an error.
 */
export function describeSignInExpiry(
  account: Pick<NativeAgentAccount, "expiresAt" | "expiresAtEstimated"> | undefined,
  now: number,
  locale?: string,
): SignInExpiryLine | undefined {
  const ms = account?.expiresAt ? Date.parse(account.expiresAt) : Number.NaN;
  if (!Number.isFinite(ms)) return undefined;
  const estimated = account?.expiresAtEstimated === true;
  const date = formatSignInExpiryDate(ms, locale);
  const dateTime = new Date(ms).toISOString();
  const note = estimated ? { note: SIGN_IN_EXPIRY_ESTIMATE_NOTE } : {};
  const left = ms - now;
  if (left <= 0) {
    const lead = estimated ? "Sign-in may have ended around " : "Sign-in may have ended on ";
    return { tone: "ended", text: `${lead}${date}`, lead, date, trail: "", dateTime, ...note };
  }
  const lead = estimated ? "Sign-in ends about " : "Sign-in ends ";
  const attention =
    SIGN_IN_EXPIRY_ATTENTION_MS + (estimated ? SIGN_IN_EXPIRY_ESTIMATE_MARGIN_MS : 0);
  if (left > attention) {
    return { tone: "upcoming", text: `${lead}${date}`, lead, date, trail: "", dateTime, ...note };
  }
  const trail = ` (${remaining(left)})`;
  return { tone: "soon", text: `${lead}${date}${trail}`, lead, date, trail, dateTime, ...note };
}
