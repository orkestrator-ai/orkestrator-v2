import { eventSink } from "../src/core/backend-emit.js";
import { describe, expect, test } from "bun:test";
import { BackendRuntime } from "../src/core/backend-runtime";
import type { CommandContext } from "../src/core/commands";
import {
  buildTmuxPaneUpdate,
  INTERACTIVE_SNAPSHOT_MAX_MS,
  INTERACTIVE_SNAPSHOT_MIN_MS,
  InteractiveTmuxTerminalManager,
} from "../src/core/tmux";
import { setTimeout as delay } from "node:timers/promises";

import { RecurringWorkMetrics } from "../src/core/recurring-work-metrics";
import { deferred, waitFor } from "./tmux-test-harness.js";

const LEASE_MS = 45_000;

describe("interactive tmux terminal snapshots", () => {
  test("emits line patches and falls back for resize-shaped redraws", () => {
    expect(buildTmuxPaneUpdate("one\ntwo\nthree", "one\nTWO\nthree")).toEqual({
      text: "\u001b[2;1H\u001b[2KTWO",
      full: false,
    });
    expect(buildTmuxPaneUpdate("one\ntwo\nthree", "one\n\u001b[31mTWO\u001b[0m\nthree")).toEqual({
      text: "\u001b[2;1H\u001b[2K\u001b[31mTWO\u001b[0m",
      full: false,
    });
    expect(buildTmuxPaneUpdate("one\ntwo", "one\ntwo\nthree")).toEqual({
      text: "\u001b[H\u001b[2Jone\r\ntwo\r\nthree",
      full: true,
    });
    expect(buildTmuxPaneUpdate("one\ntwo", "\n")).toEqual({
      text: "\u001b[H\u001b[2J",
      full: true,
    });
    expect(buildTmuxPaneUpdate("same", "same")).toEqual({
      text: "",
      full: false,
    });
    expect(buildTmuxPaneUpdate("same", "same", true)).toEqual({
      text: "\u001b[H\u001b[2Jsame",
      full: true,
    });
  });
  /**
   * `tmux capture-pane -p` terminates *every* row, so a capture of an N-row
   * pane contains N newlines. Replaying that verbatim issues a line feed with
   * the cursor already on the bottom row, which scrolls the viewport by one and
   * leaves every later line address naming the wrong row. Verified against tmux
   * 3.6a: a 6-row pane showing two lines captures as "line1\nline2\n\n\n\n\n".
   */
  test("keeps repaint and patch row addressing agreed on a real capture", () => {
    const before = "line1\nline2\n\n\n\n\n";
    const after = "line1\nLINE2\n\n\n\n\n";

    const repaint = buildTmuxPaneUpdate(undefined, before);
    expect(repaint.full).toBe(true);
    // Six rows written with five separators: the cursor finishes on the last
    // row without ever scrolling, so row R keeps displaying capture line R.
    expect(repaint.text).toBe("\u001b[H\u001b[2Jline1\r\nline2\r\n\r\n\r\n\r\n");
    expect(repaint.text.split("\r\n")).toHaveLength(6);

    // `line2` is capture line 2, so it must be patched at row 2.
    expect(buildTmuxPaneUpdate(before, after)).toEqual({
      text: "\u001b[2;1H\u001b[2KLINE2",
      full: false,
    });
  });

  test("treats a terminated and an unterminated capture as the same pane", () => {
    expect(buildTmuxPaneUpdate("one\ntwo\nthree\n", "one\nTWO\nthree\n")).toEqual({
      text: "\u001b[2;1H\u001b[2KTWO",
      full: false,
    });
    // Row count is what forces a repaint, so a terminator present on only one
    // side must not read as an extra row.
    expect(buildTmuxPaneUpdate("one\ntwo\nthree", "one\nTWO\nthree\n")).toEqual({
      text: "\u001b[2;1H\u001b[2KTWO",
      full: false,
    });
    expect(buildTmuxPaneUpdate("one\ntwo\n", "one\ntwo\nthree\n")).toEqual({
      text: "\u001b[H\u001b[2Jone\r\ntwo\r\nthree",
      full: true,
    });
  });

  test("repaints blank and empty captures without a trailing feed", () => {
    expect(buildTmuxPaneUpdate(undefined, "\n\n\n")).toEqual({
      text: "\u001b[H\u001b[2J\r\n\r\n",
      full: true,
    });
    expect(buildTmuxPaneUpdate(undefined, "")).toEqual({
      text: "\u001b[H\u001b[2J",
      full: true,
    });
  });

  function createInteractiveHarness(
    captures: Array<string | Promise<string>>,
    resizes: Array<void | Promise<void>> = [],
    options: { leased?: boolean; metrics?: RecurringWorkMetrics } = {},
  ) {
    let now = 1_000_000;
    const scheduled: Array<{ callback: () => void; delayMs: number; timer: object }> = [];
    const cancelled = new Set<unknown>();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    let captureIndex = 0;
    let resizeIndex = 0;
    const resizeCalls: Array<{ cols: number; rows: number }> = [];
    let writes = 0;
    const tmux = {
      environmentId: "env-interactive",
      tabId: "tab-interactive",
      resize: async (cols: number, rows: number) => {
        resizeCalls.push({ cols, rows });
        const resize = resizes[resizeIndex++];
        if (resize) await resize;
      },
      writeInteractive: async () => {
        writes += 1;
      },
      capturePane: async () => {
        const capture = captures[captureIndex++];
        if (capture === undefined) throw new Error("unexpected capture");
        return await capture;
      },
    };
    const manager = new InteractiveTmuxTerminalManager({
      schedule: (callback, delayMs) => {
        const timer = {};
        scheduled.push({ callback, delayMs, timer });
        return timer;
      },
      cancel: (timer) => {
        cancelled.add(timer);
      },
      now: () => now,
      leaseMs: LEASE_MS,
      ...(options.metrics ? { metrics: options.metrics } : {}),
    });
    const id = manager.create(tmux as never, 120, 40, { leased: options.leased });
    const context = {
      emit: eventSink((event: string, payload: unknown) => emitted.push({ event, payload })),
      runtime: new BackendRuntime({ emit: () => undefined }),
    } as unknown as CommandContext;
    return {
      manager,
      id,
      context,
      scheduled,
      cancelled,
      emitted,
      resizeCalls,
      captureCount: () => captureIndex,
      writeCount: () => writes,
      tmux,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  test("backs off on unchanged panes and resets on output or input", async () => {
    const harness = createInteractiveHarness(["same", "same", "changed"]);
    await harness.manager.start(harness.id, harness.context);

    expect(harness.emitted).toHaveLength(1);
    expect(harness.scheduled[0]?.delayMs).toBe(INTERACTIVE_SNAPSHOT_MIN_MS);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.scheduled.length === 2);
    expect(harness.emitted).toHaveLength(1);
    expect(harness.scheduled[1]?.delayMs).toBe(
      Math.min(INTERACTIVE_SNAPSHOT_MAX_MS, INTERACTIVE_SNAPSHOT_MIN_MS * 2),
    );

    harness.scheduled[1]!.callback();
    await waitFor(() => harness.scheduled.length === 3);
    expect(harness.emitted).toHaveLength(2);
    expect(harness.scheduled[2]?.delayMs).toBe(INTERACTIVE_SNAPSHOT_MIN_MS);

    await harness.manager.write(harness.id, "x", harness.context);
    expect(harness.writeCount()).toBe(1);
    expect(harness.scheduled.at(-1)?.delayMs).toBe(INTERACTIVE_SNAPSHOT_MIN_MS);
  });

  test("sustained typing cannot push the pending capture out", async () => {
    // The renderer sends one write per keystroke. Anything faster than one
    // character per INTERACTIVE_SNAPSHOT_MIN_MS — ordinary typing, or OS key
    // auto-repeat — used to cancel and re-arm the capture on every keystroke,
    // so the pane emitted nothing at all until the user stopped typing.
    const harness = createInteractiveHarness(["initial", "typed"]);
    await harness.manager.start(harness.id, harness.context);
    const armed = harness.scheduled[0]!;

    for (const char of "hello world")
      await harness.manager.write(harness.id, char, harness.context);

    expect(harness.writeCount()).toBe(11);
    expect(harness.cancelled).not.toContain(armed.timer);
    expect(harness.scheduled).toHaveLength(1);

    armed.callback();
    await waitFor(() => harness.emitted.length === 2);
  });

  test("input pulls a backed-off capture forward", async () => {
    const harness = createInteractiveHarness(["same", "same", "same"]);
    await harness.manager.start(harness.id, harness.context);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.scheduled.length === 2);
    harness.scheduled[1]!.callback();
    await waitFor(() => harness.scheduled.length === 3);
    const backedOff = harness.scheduled[2]!;
    expect(backedOff.delayMs).toBeGreaterThan(INTERACTIVE_SNAPSHOT_MIN_MS);

    await harness.manager.write(harness.id, "x", harness.context);

    expect(harness.cancelled).toContain(backedOff.timer);
    expect(harness.scheduled.at(-1)?.delayMs).toBe(INTERACTIVE_SNAPSHOT_MIN_MS);
  });

  test("a failed capture does not stop the interactive pane polling", async () => {
    // One transient `tmux capture-pane` failure — a resize race, a momentarily
    // busy server — must not leave the terminal permanently frozen.
    const failing = deferred<string>();
    const harness = createInteractiveHarness(["initial", failing.promise, "recovered"]);
    await harness.manager.start(harness.id, harness.context);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.captureCount() === 2);
    failing.reject(new Error("tmux capture-pane failed"));

    await waitFor(() => harness.scheduled.length === 2);
    harness.scheduled[1]!.callback();
    await waitFor(() => harness.emitted.length === 2);
  });

  test("detach suppresses an in-flight capture and prevents rescheduling", async () => {
    const pending = deferred<string>();
    const harness = createInteractiveHarness(["initial", pending.promise]);
    await harness.manager.start(harness.id, harness.context);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.captureCount() === 2);
    harness.manager.detach(harness.id);
    expect(harness.cancelled).toContain(harness.scheduled[0]!.timer);

    pending.resolve("too late");
    await delay(0);
    expect(harness.emitted).toHaveLength(1);
    expect(harness.scheduled).toHaveLength(1);
  });

  test("forced recovery invalidates an older in-flight capture", async () => {
    const stale = deferred<string>();
    const harness = createInteractiveHarness(["initial", stale.promise, "recovered"]);
    await harness.manager.start(harness.id, harness.context);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.captureCount() === 2);

    const recovery = harness.manager.start(harness.id, harness.context);
    await waitFor(() => harness.captureCount() === 3);
    await recovery;

    expect(harness.emitted).toHaveLength(2);
    expect(harness.emitted[1]).toEqual({
      event: `terminal-output-${harness.id}`,
      payload: expect.objectContaining({ text: expect.stringContaining("recovered"), full: true }),
    });

    stale.resolve("stale capture");
    await delay(0);
    expect(harness.emitted).toHaveLength(2);
  });

  test("resize discards an in-flight capture and makes the next frame full", async () => {
    const stale = deferred<string>();
    const harness = createInteractiveHarness(["initial", stale.promise, "resized pane"]);
    await harness.manager.start(harness.id, harness.context);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.captureCount() === 2);
    await harness.manager.resize(harness.id, 90, 24);

    stale.resolve("old geometry");
    await waitFor(() => harness.scheduled.length === 2);
    expect(harness.emitted).toHaveLength(1);

    harness.scheduled[1]!.callback();
    await waitFor(() => harness.emitted.length === 2);
    expect(harness.emitted[1]).toEqual({
      event: `terminal-output-${harness.id}`,
      payload: expect.objectContaining({
        text: expect.stringContaining("resized pane"),
        full: true,
      }),
    });
  });

  test("serializes overlapping geometry changes in request order", async () => {
    const firstResize = deferred<void>();
    const secondResize = deferred<void>();
    const harness = createInteractiveHarness(
      ["initial"],
      [undefined, firstResize.promise, secondResize.promise],
    );
    await harness.manager.start(harness.id, harness.context);

    const first = harness.manager.resize(harness.id, 100, 30);
    await waitFor(() => harness.resizeCalls.length === 2);
    const second = harness.manager.resize(harness.id, 80, 20);
    await delay(0);
    expect(harness.resizeCalls).toHaveLength(2);

    firstResize.resolve(undefined);
    await first;
    await waitFor(() => harness.resizeCalls.length === 3);
    secondResize.resolve(undefined);
    await second;

    expect(harness.resizeCalls).toEqual([
      { cols: 120, rows: 40 },
      { cols: 100, rows: 30 },
      { cols: 80, rows: 20 },
    ]);
  });

  test("resumes captures after a failed resize instead of staying suspended", async () => {
    const failedResize = deferred<void>();
    const harness = createInteractiveHarness(
      ["initial", "after failed resize"],
      [undefined, failedResize.promise],
    );
    await harness.manager.start(harness.id, harness.context);

    const resize = harness.manager.resize(harness.id, 90, 24);
    await waitFor(() => harness.resizeCalls.length === 2);
    failedResize.reject(new Error("tmux resize-window failed"));
    // The caller still sees the failure, but capture suspension must not outlive
    // it — the pane would otherwise emit nothing for the rest of the session.
    await expect(resize).rejects.toThrow("tmux resize-window failed");

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.emitted.length === 2);
    expect(harness.emitted[1]).toEqual({
      event: `terminal-output-${harness.id}`,
      payload: expect.objectContaining({
        text: expect.stringContaining("after failed resize"),
        full: true,
      }),
    });
  });

  test("does not resurrect a detached terminal from a late geometry change", async () => {
    const harness = createInteractiveHarness(["initial"]);
    await harness.manager.start(harness.id, harness.context);
    harness.manager.detach(harness.id);

    await expect(harness.manager.resize(harness.id, 80, 20)).rejects.toThrow();
    expect(harness.captureCount()).toBe(1);
    expect(harness.emitted).toHaveLength(1);
  });
  test("an unleased terminal keeps capturing without renewals (older clients)", async () => {
    const harness = createInteractiveHarness(["initial", "same"]);
    await harness.manager.start(harness.id, harness.context);
    harness.advance(LEASE_MS * 10);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.scheduled.length === 2);
    expect(harness.captureCount()).toBe(2);
    expect(harness.manager.size()).toBe(1);
  });

  test("a leased terminal no client renewed stops capturing at its next tick", async () => {
    // A reload, a closed window or a cut link sends no detach (to-do 7745, retired).
    const harness = createInteractiveHarness(["initial"], [], { leased: true });
    await harness.manager.start(harness.id, harness.context);
    harness.advance(LEASE_MS);

    harness.scheduled[0]!.callback();
    await delay(0);
    expect(harness.captureCount()).toBe(1);
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.manager.size()).toBe(0);
    expect(harness.manager.renew(harness.id)).toBe(false);
    await expect(harness.manager.start(harness.id, harness.context)).rejects.toThrow(
      "tmux interactive terminal session not found",
    );
  });

  test("a write or resize on a lapsed but still-held terminal detaches it and refuses", async () => {
    // The lease ran out between two capture ticks, so the terminal is still
    // in the map when a late write or resize reaches it.
    for (const operation of ["write", "resize"] as const) {
      const harness = createInteractiveHarness(["initial"], [], { leased: true });
      await harness.manager.start(harness.id, harness.context);
      const resizesBefore = harness.resizeCalls.length;
      harness.advance(LEASE_MS);
      expect(harness.manager.size()).toBe(1);

      const late =
        operation === "write"
          ? harness.manager.write(harness.id, "ls\r", harness.context)
          : harness.manager.resize(harness.id, 80, 20);
      await expect(late).rejects.toThrow("tmux interactive terminal session not found");

      expect(harness.manager.size()).toBe(0);
      expect(harness.cancelled).toContain(harness.scheduled[0]!.timer);
      expect(harness.writeCount()).toBe(0);
      expect(harness.resizeCalls).toHaveLength(resizesBefore);
      expect(harness.manager.renew(harness.id)).toBe(false);
    }
  });

  test("renewals keep a leased terminal capturing", async () => {
    const harness = createInteractiveHarness(["initial", "next", "again"], [], { leased: true });
    await harness.manager.start(harness.id, harness.context);
    for (const tick of [0, 1]) {
      // Each renewal lands just before the previous lease runs out.
      harness.advance(LEASE_MS - 10);
      expect(harness.manager.renew(harness.id)).toBe(true);
      harness.advance(5);
      harness.scheduled[tick]!.callback();
      await waitFor(() => harness.scheduled.length === tick + 2);
    }
    expect(harness.captureCount()).toBe(3);
    expect(harness.manager.size()).toBe(1);
  });

  test("a renewal after the lease lapsed answers false so the client re-creates", async () => {
    // A sleeping laptop or a throttled hidden page renews late.
    const harness = createInteractiveHarness(["initial"], [], { leased: true });
    await harness.manager.start(harness.id, harness.context);
    harness.advance(LEASE_MS + 5_000);

    expect(harness.manager.renew(harness.id)).toBe(false);
    expect(harness.manager.size()).toBe(0);
    expect(harness.cancelled).toContain(harness.scheduled[0]!.timer);
  });

  test("creating a terminal sweeps a lapsed one that was never started", () => {
    const harness = createInteractiveHarness([], [], { leased: true });
    harness.advance(LEASE_MS);
    const next = harness.manager.create(harness.tmux as never, 80, 24, { leased: true });
    expect(harness.manager.size()).toBe(1);
    expect(harness.manager.renew(harness.id)).toBe(false);
    expect(harness.manager.renew(next)).toBe(true);
  });

  test("renewing arms a lease on a terminal created without one", async () => {
    const harness = createInteractiveHarness(["initial"]);
    await harness.manager.start(harness.id, harness.context);
    expect(harness.manager.renew(harness.id)).toBe(true);
    harness.advance(LEASE_MS);
    harness.scheduled[0]!.callback();
    await delay(0);
    expect(harness.manager.size()).toBe(0);
  });

  test("counts each timer capture as a tmux-interactive-capture attempt", async () => {
    const metrics = new RecurringWorkMetrics({ enabled: true });
    const harness = createInteractiveHarness(["initial", "initial", "changed"], [], {
      metrics,
    });
    await harness.manager.start(harness.id, harness.context);
    harness.scheduled[0]!.callback();
    await waitFor(() => harness.scheduled.length === 2);
    harness.scheduled[1]!.callback();
    await waitFor(() => harness.scheduled.length === 3);

    const kind = metrics.snapshot().kinds["tmux-interactive-capture"]!;
    // The start's forced repaint is not a timer attempt.
    expect(kind.started).toBe(2);
    expect(kind.changed).toBe(1);
    expect(kind.unchanged).toBe(1);
  });
});
