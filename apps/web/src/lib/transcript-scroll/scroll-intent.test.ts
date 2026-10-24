import { describe, expect, test } from "bun:test";
import {
  followAllowed,
  initialScrollIntent,
  owedOnRelease,
  reduceScrollIntent,
  viewportMode,
  type ScrollIntentEvent,
  type ScrollIntentState,
} from "./scroll-intent";

function run(state: ScrollIntentState, ...events: ScrollIntentEvent[]) {
  return events.reduce(reduceScrollIntent, state);
}

describe("scroll intent", () => {
  test("starts following and allows automatic follow", () => {
    const state = initialScrollIntent();
    expect(viewportMode(state)).toBe("following");
    expect(followAllowed(state)).toBe(true);
  });

  test("a navigation owns the viewport; latest follows, anything else reads", () => {
    const find = run(initialScrollIntent(), { type: "navigate", owner: "find" });
    expect(viewportMode(find)).toBe("navigating");
    expect(find.wantsFollow).toBe(false);
    expect(followAllowed(find)).toBe(false);
    const done = run(find, { type: "finish", generation: find.generation });
    expect(viewportMode(done)).toBe("reading");

    const latest = run(done, { type: "navigate", owner: "latest" });
    expect(latest.wantsFollow).toBe(true);
    expect(viewportMode(run(latest, { type: "finish", generation: latest.generation }))).toBe(
      "following",
    );
  });

  test("a stale finish cannot end a newer navigation", () => {
    const first = run(initialScrollIntent(), { type: "navigate", owner: "row" });
    const second = run(first, { type: "navigate", owner: "find" });
    expect(run(second, { type: "finish", generation: first.generation }).operation?.owner).toBe(
      "find",
    );
  });

  test("user navigation in any direction retires the operation and bumps the generation", () => {
    const navigating = run(initialScrollIntent(), { type: "navigate", owner: "history" });
    const interrupted = run(navigating, { type: "user-navigation" });
    expect(interrupted.operation).toBeNull();
    expect(interrupted.generation).toBeGreaterThan(navigating.generation);
    // Intent is unchanged until the movement's direction is known.
    expect(interrupted.wantsFollow).toBe(false);
  });

  test("only the reader leaving or arriving changes follow intent", () => {
    const left = run(initialScrollIntent(), { type: "user-departed" });
    expect(left.wantsFollow).toBe(false);
    expect(run(left, { type: "growth" }).wantsFollow).toBe(false);
    expect(run(left, { type: "user-arrived" }).wantsFollow).toBe(true);
  });

  test("taking a pause retires an incompatible operation; find keeps its own navigation", () => {
    const latest = run(initialScrollIntent(), { type: "navigate", owner: "latest" });
    expect(run(latest, { type: "pause", reason: "selection", paused: true }).operation).toBeNull();
    const finding = run(initialScrollIntent(), { type: "navigate", owner: "find" });
    expect(run(finding, { type: "pause", reason: "find", paused: true }).operation?.owner).toBe(
      "find",
    );
    expect(
      run(finding, { type: "pause", reason: "expanded-artifact", paused: true }).operation,
    ).toBeNull();
  });

  test("one pause cannot release another; growth is owed only to a follower on the final release", () => {
    let state = run(
      initialScrollIntent(),
      { type: "pause", reason: "selection", paused: true },
      { type: "growth" },
      { type: "pause", reason: "find", paused: true },
    );
    const afterOne = run(state, { type: "pause", reason: "selection", paused: false });
    expect(afterOne.pauseReasons.size).toBe(1);
    expect(owedOnRelease(state, afterOne)).toBe(false);
    state = afterOne;
    const released = run(state, { type: "pause", reason: "find", paused: false });
    expect(owedOnRelease(state, released)).toBe(true);
  });

  test("reader movement or a navigation during a pause supersedes what it held", () => {
    const paused = run(
      initialScrollIntent(),
      { type: "pause", reason: "selection", paused: true },
      { type: "growth" },
    );
    const moved = run(paused, { type: "user-navigation" });
    expect(
      owedOnRelease(moved, run(moved, { type: "pause", reason: "selection", paused: false })),
    ).toBe(false);
    const navigated = run(
      paused,
      { type: "navigate", owner: "find" },
      { type: "finish", generation: 2 },
    );
    expect(
      owedOnRelease(
        navigated,
        run(navigated, { type: "pause", reason: "selection", paused: false }),
      ),
    ).toBe(false);
  });

  test("pause reasons are idempotent tokens", () => {
    const once = run(initialScrollIntent(), { type: "pause", reason: "find", paused: true });
    expect(run(once, { type: "pause", reason: "find", paused: true })).toBe(once);
    expect(run(once, { type: "pause", reason: "selection", paused: false })).toBe(once);
  });

  test("deactivation retires the operation and disallows follow", () => {
    const navigating = run(initialScrollIntent(), { type: "navigate", owner: "latest" });
    const inactive = run(navigating, { type: "deactivate" });
    expect(inactive.operation).toBeNull();
    expect(viewportMode(inactive)).toBe("inactive");
    expect(followAllowed(inactive)).toBe(false);
  });
});
