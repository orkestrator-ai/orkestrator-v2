/**
 * A deadline for an approval a test parks by hand.
 *
 * Suites that seed `state.approvals` directly supply their own `settle`, so the
 * deadline is only ever read — published `expiresAt` and `hold` — never left to
 * expire. Its clock reads the wall time but arms nothing, so a seeded approval
 * leaves no timer behind.
 */
import {
  InteractionDeadline,
  type InteractionDeadlineClock,
} from "@orkestrator/protocol/agent-interaction-deadline";

const INERT_CLOCK: InteractionDeadlineClock = {
  now: () => Date.now(),
  setTimeout: () => undefined,
  clearTimeout: () => undefined,
};

export function testApprovalDeadline(
  requestedAt: number = Date.now(),
  windowMs = 60_000,
): InteractionDeadline {
  return new InteractionDeadline({
    onExpire: () => undefined,
    requestedAt,
    windowMs,
    clock: INERT_CLOCK,
  });
}
