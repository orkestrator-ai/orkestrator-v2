import { createHash } from "node:crypto";

/** Identifies one Fix attempt without exposing its provider session or contents. */
export function multiReviewFixIdentity(session: unknown): string | undefined {
  if (!session || typeof session !== "object" || !("sessionKey" in session)) return undefined;
  if (typeof session.sessionKey !== "string" || !session.sessionKey.trim()) return undefined;
  const startedAt =
    "startedAt" in session && typeof session.startedAt === "string" ? session.startedAt : "";
  return createHash("sha256")
    .update(JSON.stringify([session.sessionKey, startedAt]))
    .digest("hex");
}
