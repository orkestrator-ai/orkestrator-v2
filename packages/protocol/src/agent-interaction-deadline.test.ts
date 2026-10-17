import { describe, expect, test } from "bun:test";
import {
  InteractionDeadline,
  type InteractionDeadlineClock,
} from "./agent-interaction-deadline.js";
import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_HOLD_CEILING_MS,
} from "./agent-interactions.js";

const START = 1_800_000_000_000;
const WINDOW = AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
const CEILING = AGENT_INTERACTION_HOLD_CEILING_MS;

/** A manual clock: timers fire only when the test advances time past them. */
function manualClock() {
  let now = START;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: InteractionDeadlineClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      nextId += 1;
      timers.set(nextId, { at: now + ms, callback });
      return nextId;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = target;
  };
  return { clock, advance, pending: () => timers.size };
}

function deadline(overrides: Partial<ConstructorParameters<typeof InteractionDeadline>[0]> = {}) {
  const { clock, advance, pending } = manualClock();
  let expired = 0;
  const value = new InteractionDeadline({
    clock,
    onExpire: () => {
      expired += 1;
    },
    ...overrides,
  });
  return { deadline: value, advance, pending, expired: () => expired };
}

describe("InteractionDeadline", () => {
  test("expires once at the end of the window when nobody pauses it", () => {
    const { deadline: value, advance, expired } = deadline();
    expect(value.expiresAt).toBe(START + WINDOW);
    expect(value.hold()).toEqual({ available: true });
    advance(WINDOW - 1);
    expect(expired()).toBe(0);
    advance(1);
    expect(expired()).toBe(1);
    expect(value.settled).toBe(true);
    expect(value.setHeld(true)).toBe("settled");
  });

  test("a pause stops the countdown until the hold ceiling", () => {
    const { deadline: value, advance, expired } = deadline();
    advance(60_000);
    expect(value.setHeld(true)).toBe("applied");
    expect(value.heldAt).toBe(START + 60_000);
    expect(value.expiresAt).toBe(START + 60_000 + CEILING);
    expect(value.hold()).toEqual({ available: true, heldAt: START + 60_000 });

    advance(WINDOW * 10);
    expect(expired()).toBe(0);
    // Still declined in the end: a forgotten card cannot pin the turn forever.
    advance(CEILING);
    expect(expired()).toBe(1);
  });

  test("a resume restarts a fresh window rather than the remainder", () => {
    const { deadline: value, advance, expired } = deadline();
    advance(WINDOW - 3_000);
    value.setHeld(true);
    advance(60 * 60_000);
    expect(value.setHeld(false)).toBe("applied");
    expect(value.heldAt).toBeUndefined();
    const resumedAt = START + WINDOW - 3_000 + 60 * 60_000;
    expect(value.expiresAt).toBe(resumedAt + WINDOW);
    advance(WINDOW - 1);
    expect(expired()).toBe(0);
    advance(1);
    expect(expired()).toBe(1);
  });

  test("pausing twice, or resuming a running countdown, changes nothing", () => {
    const { deadline: value } = deadline();
    expect(value.setHeld(false)).toBe("unchanged");
    value.setHeld(true);
    const ceiling = value.expiresAt;
    expect(value.setHeld(true)).toBe("unchanged");
    expect(value.expiresAt).toBe(ceiling);
  });

  test("a provider limit caps both the pause and the resume", () => {
    const limitAt = START + 30 * 60_000;
    const { deadline: value, advance, expired } = deadline({ providerLimitAt: () => limitAt });
    expect(value.hold()).toEqual({ available: true, reason: "provider-limit" });
    value.setHeld(true);
    expect(value.expiresAt).toBe(limitAt);
    expect(value.hold()).toEqual({ available: true, heldAt: START, reason: "provider-limit" });

    advance(limitAt - START - 2 * 60_000);
    value.setHeld(false);
    expect(value.expiresAt).toBe(limitAt);
    advance(2 * 60_000);
    expect(expired()).toBe(1);
  });

  test("a pause is unavailable once the provider limit is the countdown itself", () => {
    const {
      deadline: value,
      advance,
      expired,
    } = deadline({
      expiresAt: START + 60_000,
      providerLimitAt: () => START + 60_000,
    });
    expect(value.hold()).toEqual({ available: false, reason: "no-extension" });
    expect(value.setHeld(true)).toBe("unavailable");
    expect(value.heldAt).toBeUndefined();
    advance(60_000);
    expect(expired()).toBe(1);
  });

  test("a far provider limit leaves an ordinary pause", () => {
    const { deadline: value } = deadline({ providerLimitAt: () => START + 2 * CEILING });
    expect(value.hold()).toEqual({ available: true });
    value.setHeld(true);
    expect(value.expiresAt).toBe(START + CEILING);
  });

  test("an upstream party that may stop waiting is reported while paused", () => {
    const { deadline: value } = deadline({ upstreamMayExpire: true });
    expect(value.hold()).toEqual({ available: true, reason: "upstream-may-expire" });
    value.setHeld(true);
    expect(value.hold()).toEqual({
      available: true,
      heldAt: START,
      reason: "upstream-may-expire",
    });
  });

  test("settling clears the timer so an answered request never expires", () => {
    const { deadline: value, advance, expired, pending } = deadline();
    value.setHeld(true);
    value.settle();
    expect(pending()).toBe(0);
    advance(CEILING * 2);
    expect(expired()).toBe(0);
    expect(value.setHeld(false)).toBe("settled");
  });
});
