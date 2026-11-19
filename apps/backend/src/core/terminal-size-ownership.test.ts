import { describe, expect, test } from "bun:test";
import {
  TERMINAL_SIZE_DISCONNECT_GRACE_MS,
  TERMINAL_SIZE_OWNER_LEASE_MS,
  TerminalSizeOwnership,
} from "./terminal-size-ownership.js";

const WIDE = { cols: 200, rows: 50 };
const NARROW = { cols: 40, rows: 30 };

function tracker(options: { maxSessions?: number } = {}) {
  let now = 1_000;
  const ownership = new TerminalSizeOwnership({ now: () => now, ...options });
  return {
    ownership,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("TerminalSizeOwnership", () => {
  test("the first client to resize an unowned terminal becomes its owner", () => {
    const { ownership } = tracker();
    expect(ownership.decide("s", "desktop", false, WIDE)).toEqual({
      apply: true,
      owned: true,
      unchanged: false,
    });
    expect(ownership.isOwner("s", "desktop")).toBe(true);
  });

  test("a passive update from another client does not change the owner's size", () => {
    const { ownership } = tracker();
    ownership.decide("s", "desktop", true, WIDE);
    // Opening a phone view, or rotating it, is layout, not interaction.
    expect(ownership.decide("s", "phone", false, NARROW)).toEqual({
      apply: false,
      owned: false,
      unchanged: false,
    });
    expect(ownership.isOwner("s", "desktop")).toBe(true);
    // The owner's own layout changes still apply.
    expect(ownership.decide("s", "desktop", false, { cols: 180, rows: 50 }).apply).toBe(true);
  });

  test("a claim transfers ownership, and the previous owner's updates then stop applying", () => {
    const { ownership } = tracker();
    ownership.decide("s", "desktop", true, WIDE);
    expect(ownership.decide("s", "phone", true, NARROW)).toEqual({
      apply: true,
      owned: true,
      unchanged: false,
    });
    expect(ownership.decide("s", "desktop", false, WIDE).apply).toBe(false);
    expect(ownership.decide("s", "desktop", true, WIDE).apply).toBe(true);
    expect(ownership.isOwner("s", "desktop")).toBe(true);
  });

  test("the owner resending the size it last set is reported unchanged", () => {
    const { ownership } = tracker();
    ownership.decide("s", "desktop", true, WIDE);
    expect(ownership.decide("s", "desktop", true, WIDE)).toEqual({
      apply: true,
      owned: true,
      unchanged: true,
    });
    expect(ownership.decide("s", "desktop", true, NARROW).unchanged).toBe(false);
    // A transfer is never unchanged, even at the same geometry: the PTY may
    // have been resized by someone else in between.
    expect(ownership.decide("s", "phone", true, NARROW).unchanged).toBe(false);
  });

  test("an older client without an id applies only while nobody owns the size", () => {
    const { ownership } = tracker();
    expect(ownership.decide("s", null, false, WIDE)).toEqual({
      apply: true,
      owned: false,
      unchanged: false,
    });
    // It never takes ownership, so a newer client's update still applies.
    expect(ownership.decide("s", "desktop", false, NARROW).owned).toBe(true);
    expect(ownership.decide("s", null, false, WIDE).apply).toBe(false);
    expect(ownership.decide("s", null, true, WIDE).apply).toBe(false);
  });

  test("ownership is per session", () => {
    const { ownership } = tracker();
    ownership.decide("a", "desktop", true, WIDE);
    expect(ownership.decide("b", "phone", false, NARROW).apply).toBe(true);
    expect(ownership.isOwner("a", "desktop")).toBe(true);
    expect(ownership.isOwner("b", "phone")).toBe(true);
  });

  test("an owner that goes quiet past its lease stops holding the size", () => {
    const { ownership, advance } = tracker();
    ownership.decide("s", "desktop", true, WIDE);
    advance(TERMINAL_SIZE_OWNER_LEASE_MS - 1);
    expect(ownership.decide("s", "phone", false, NARROW).apply).toBe(false);
    advance(1);
    expect(ownership.decide("s", "phone", false, NARROW)).toMatchObject({
      apply: true,
      owned: true,
    });
  });

  test("every accepted resize from the owner renews its lease", () => {
    const { ownership, advance } = tracker();
    ownership.decide("s", "desktop", true, WIDE);
    advance(TERMINAL_SIZE_OWNER_LEASE_MS - 1);
    ownership.decide("s", "desktop", false, WIDE);
    advance(TERMINAL_SIZE_OWNER_LEASE_MS - 1);
    expect(ownership.decide("s", "phone", false, NARROW).apply).toBe(false);
  });

  test("a release hands the size to whoever resizes next", () => {
    const { ownership } = tracker();
    ownership.decide("a", "desktop", true, WIDE);
    ownership.decide("b", "desktop", true, WIDE);
    expect(ownership.release("phone", { sessionId: "a" })).toBe(0);
    expect(ownership.release("desktop", { sessionId: "a" })).toBe(1);
    expect(ownership.isOwner("a", "desktop")).toBe(false);
    expect(ownership.isOwner("b", "desktop")).toBe(true);
    expect(ownership.decide("a", "phone", false, NARROW).apply).toBe(true);
    // Without a session, every session the client owns is released.
    ownership.decide("c", "desktop", true, WIDE);
    expect(ownership.release("desktop")).toBe(2);
    expect(ownership.ownedSessionCount()).toBe(1);
  });

  test("a dropped connection keeps the size only for the grace period", () => {
    const { ownership, advance } = tracker();
    ownership.decide("s", "phone", true, NARROW);
    expect(ownership.release("phone", { disconnected: true })).toBe(1);
    advance(TERMINAL_SIZE_DISCONNECT_GRACE_MS - 1);
    expect(ownership.decide("s", "desktop", false, WIDE).apply).toBe(false);
    advance(1);
    expect(ownership.decide("s", "desktop", false, WIDE).apply).toBe(true);
  });

  test("a client that reconnects within the grace period renews its ownership", () => {
    const { ownership, advance } = tracker();
    ownership.decide("s", "phone", true, NARROW);
    ownership.release("phone", { disconnected: true });
    advance(TERMINAL_SIZE_DISCONNECT_GRACE_MS - 1);
    expect(ownership.decide("s", "phone", false, NARROW).apply).toBe(true);
    advance(TERMINAL_SIZE_DISCONNECT_GRACE_MS);
    expect(ownership.decide("s", "desktop", false, WIDE).apply).toBe(false);
  });

  test("forgetting a session clears its owner", () => {
    const { ownership } = tracker();
    ownership.decide("s", "desktop", true, WIDE);
    ownership.forget("s");
    expect(ownership.decide("s", "phone", false, NARROW).apply).toBe(true);
  });

  test("tracks a bounded number of sessions, dropping the least recently renewed", () => {
    const { ownership } = tracker({ maxSessions: 2 });
    ownership.decide("a", "desktop", true, WIDE);
    ownership.decide("b", "desktop", true, WIDE);
    ownership.decide("a", "desktop", false, WIDE);
    ownership.decide("c", "desktop", true, WIDE);
    expect(ownership.isOwner("a", "desktop")).toBe(true);
    expect(ownership.isOwner("b", "desktop")).toBe(false);
    expect(ownership.isOwner("c", "desktop")).toBe(true);
    expect(ownership.ownedSessionCount()).toBe(2);
  });
});
