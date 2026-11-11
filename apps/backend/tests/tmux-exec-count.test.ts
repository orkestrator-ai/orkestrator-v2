import { describe, expect, test } from "bun:test";
import * as backendModule from "../src/core/tmux-backend";
import * as sessionModule from "../src/core/tmux-session-manager";
import { RecurringWorkMetrics } from "../src/core/recurring-work-metrics";
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

  test("an idle sibling stays below the old idle budget while a busy tab rings four times a second", async () => {
    const counts = (await run("idle sibling of a busy ringing tab"))!;
    expect(counts.total).toBeLessThanOrEqual(seconds + 8);
  });

  test("every exec of the loop is charged to its tmux-tab-loop tick (todo 7567)", async () => {
    for (const scenario of SCENARIOS) {
      const metrics = new RecurringWorkMetrics({ enabled: true });
      const counts = await measureTmuxExecs(
        sessionModule as never,
        backendModule as never,
        scenario,
        seconds,
        { metrics },
      );
      if (!counts) continue;
      const snapshot = metrics.snapshot();
      const loop = snapshot.kinds["tmux-tab-loop"];
      // Nothing escapes to the unattributed bucket or another kind.
      expect(loop?.workUnits["docker-exec"]).toBe(counts.total);
      expect(snapshot.unattributed.workUnits["docker-exec"] ?? 0).toBe(0);
      // One attempt per tick, and a tick costs at most a snapshot plus its
      // search, drains and tail reads.
      expect(loop?.started).toBeGreaterThan(0);
      expect(loop?.started).toBeLessThanOrEqual(counts.total);
      expect(loop?.failed).toBe(0);
    }
  });

  test("a tick is changed only when it finds transcript lines or hook files (todo 7567)", async () => {
    const outcomes = async (scenario: (typeof SCENARIOS)[number], hookFileAtSeconds?: number) => {
      const metrics = new RecurringWorkMetrics({ enabled: true });
      const counts = await measureTmuxExecs(
        sessionModule as never,
        backendModule as never,
        scenario,
        seconds,
        { metrics, ...(hookFileAtSeconds === undefined ? {} : { hookFileAtSeconds }) },
      );
      if (!counts) return null;
      const loop = metrics.snapshot().kinds["tmux-tab-loop"]!;
      // Every settled tick reports exactly one outcome.
      expect(loop.changed + loop.unchanged).toBe(loop.completed);
      expect(loop.completed).toBe(loop.started);
      return loop;
    };
    for (const scenario of SCENARIOS) {
      // A bound tab reads its transcript's one line on the first tick, which
      // is its only change; an unbound tab never finds a line.
      const quiet = await outcomes(scenario);
      if (!quiet) continue;
      const transcriptChanges = scenario.bound ? 1 : 0;
      expect(quiet.changed).toBe(transcriptChanges);
      expect(quiet.unchanged).toBeGreaterThan(0);
      // A hook file listed once, mid-run, is one more changed tick, and the
      // ticks after it are unchanged again.
      const hooked = (await outcomes(scenario, seconds / 2))!;
      expect(hooked.changed).toBe(transcriptChanges + 1);
      expect(hooked.unchanged).toBeGreaterThan(0);
    }
  });

  test("a busy tab costs one exec per fast tick", async () => {
    const counts = (await run("busy tab"))!;
    expect(counts.total).toBeLessThanOrEqual(seconds * 4 + 2);
  });
});
