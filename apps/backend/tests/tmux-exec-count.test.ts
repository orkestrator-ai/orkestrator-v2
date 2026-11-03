import { describe, expect, test } from "bun:test";
import * as backendModule from "../src/core/tmux-backend";
import * as sessionModule from "../src/core/tmux-session-manager";
import { SCENARIOS, measureTmuxExecs } from "../scripts/tmux-exec-count";

/**
 * The exec budget of one tab's poll loop (to-do 1202 task 8), measured by the
 * same harness the before-and-after numbers come from. Over 120 simulated
 * seconds; the first two are the fast ticks after start.
 */
describe("tmux poll exec budget", () => {
  const seconds = 120;
  const run = (name: string) =>
    measureTmuxExecs(
      sessionModule as never,
      backendModule as never,
      SCENARIOS.find((scenario) => scenario.name.startsWith(name))!,
      seconds,
    );

  test("liveness and the pane never cost an exec of their own", async () => {
    for (const scenario of SCENARIOS) {
      const counts = await measureTmuxExecs(
        sessionModule as never,
        backendModule as never,
        scenario,
        seconds,
      );
      expect(counts?.["has-session"]).toBe(0);
      expect(counts?.["capture-pane"]).toBe(0);
    }
  });

  test("an idle tab on an older image costs one exec a second", async () => {
    const counts = (await run("idle bound tab, no doorbell"))!;
    expect(counts.total).toBeLessThanOrEqual(seconds + 8);
  });

  test("an idle tab with a confirmed doorbell does not exec every tick", async () => {
    const counts = (await run("idle bound tab, doorbell confirmed"))!;
    // 2 s of fast ticks, then one safety read every 2.5 s.
    expect(counts.total).toBeLessThanOrEqual(8 + Math.ceil((seconds - 2) / 2.5) + 2);
  });

  test("an unbound tab searches on its backoff and reads each sibling once", async () => {
    const counts = (await run("idle unbound tab, doorbell confirmed"))!;
    // A find every 10 s at most, plus one head read per sibling.
    expect(counts.discovery).toBeLessThanOrEqual(Math.ceil(seconds / 10) + 4 + 2);
  });

  test("a busy tab costs one exec per fast tick", async () => {
    const counts = (await run("busy tab"))!;
    expect(counts.total).toBeLessThanOrEqual(seconds * 4 + 2);
  });
});
