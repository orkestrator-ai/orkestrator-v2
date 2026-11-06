/**
 * The content-free message a desktop workspace realm sends its main process
 * for each step of its boot (`apps/web/src/lib/realm-boot-timing.ts`). The
 * main process parses it with {@link parseRealmBootTimingMessage}, adds the
 * realm's node from its own records and writes `workspaces` `realm.boot-step`
 * to the saved log. Nothing in it comes from the node's data.
 */

export const REALM_BOOT_TIMING_MESSAGE = "bootTiming";

/**
 * - `catalogue-read`: the cached model-catalogue read the first render waits on.
 * - `catalogue-seed`: the background seed that follows it.
 * - `first-render`: the realm's first committed render.
 * - `first-environments`: the first authoritative `get_environments` read.
 * - `fan-out-complete`: every project's environments and the boot hydration
 *   reads settled; `requests` counts the hydration requests it sent.
 */
export const REALM_BOOT_STEPS = [
  "catalogue-read",
  "catalogue-seed",
  "first-render",
  "first-environments",
  "fan-out-complete",
] as const;

export type RealmBootStep = (typeof REALM_BOOT_STEPS)[number];

export interface RealmBootTimingMessage {
  type: typeof REALM_BOOT_TIMING_MESSAGE;
  step: RealmBootStep;
  /** How long the step itself took. */
  durationMs: number;
  /** When the step ended, from the start of the realm's document. */
  sinceStartMs?: number;
  outcome?: "ok" | "failed";
  requests?: number;
}

/** A realm document lives for hours; anything past this is not a boot step. */
const MAX_BOOT_DURATION_MS = 60 * 60_000;
const MAX_BOOT_REQUESTS = 100_000;
const STEPS: ReadonlySet<string> = new Set(REALM_BOOT_STEPS);

function duration(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_BOOT_DURATION_MS
    ? Math.round(value)
    : null;
}

/** Accepts only the fixed shape above, so no free text can reach the log. */
export function parseRealmBootTimingMessage(value: unknown): RealmBootTimingMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type !== REALM_BOOT_TIMING_MESSAGE) return null;
  if (typeof message.step !== "string" || !STEPS.has(message.step)) return null;
  const durationMs = duration(message.durationMs);
  if (durationMs === null) return null;
  const sinceStartMs =
    message.sinceStartMs === undefined ? undefined : duration(message.sinceStartMs);
  if (sinceStartMs === null) return null;
  const outcome = message.outcome;
  if (outcome !== undefined && outcome !== "ok" && outcome !== "failed") return null;
  const requests = message.requests;
  if (
    requests !== undefined &&
    (typeof requests !== "number" ||
      !Number.isSafeInteger(requests) ||
      requests < 0 ||
      requests > MAX_BOOT_REQUESTS)
  ) {
    return null;
  }
  return {
    type: REALM_BOOT_TIMING_MESSAGE,
    step: message.step as RealmBootStep,
    durationMs,
    ...(sinceStartMs === undefined ? {} : { sinceStartMs }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(requests === undefined ? {} : { requests: requests as number }),
  };
}
