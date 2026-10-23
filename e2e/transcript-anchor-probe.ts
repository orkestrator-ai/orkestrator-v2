import type { Locator } from "@playwright/test";

export interface AnchorProbeResult {
  /** Samples taken (the trace below keeps at most `capacity`). */
  count: number;
  /** Samples where the anchor was not connected. */
  missing: number;
  /** Largest |offset - expected| over every sample, CSS px. */
  maxError: number;
  expected: number;
  /** [time, offset, scrollTop] for the most recent samples. */
  trace: number[][];
}

/**
 * Starts sampling one anchor's offset from the scroller's top, once per frame,
 * just after paint (a task posted from `requestAnimationFrame`), so it reads
 * what the reader saw rather than an unpainted intermediate layout. Reads one
 * anchor and the scroller only; stores a bounded numeric ring buffer and never
 * touches React. Stop it with `stopAnchorProbe`.
 *
 * `partId` names a `[data-transcript-part-id]` element. The anchor must be
 * visible when the probe starts.
 */
export async function startAnchorProbe(scroller: Locator, partId: string, capacity = 2048) {
  await scroller.evaluate(
    (el, { partId, capacity }) => {
      const resolve = () =>
        Array.from(el.querySelectorAll<HTMLElement>("[data-transcript-part-id]")).find(
          (node) => node.dataset.transcriptPartId === partId,
        ) ?? null;
      const offsetOf = (node: HTMLElement) =>
        node.getBoundingClientRect().top - el.getBoundingClientRect().top;
      const first = resolve();
      if (!first) throw new Error("Anchor must be visible before measurement");
      const expected = offsetOf(first);
      const samples = new Float64Array(capacity * 3);
      const state = { count: 0, missing: 0, maxError: 0, running: true, frame: 0 };
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        if (!state.running) return;
        const anchor = resolve();
        const offset = anchor?.isConnected ? offsetOf(anchor) : Number.NaN;
        if (!Number.isFinite(offset)) state.missing += 1;
        else state.maxError = Math.max(state.maxError, Math.abs(offset - expected));
        const slot = (state.count % capacity) * 3;
        samples[slot] = performance.now();
        samples[slot + 1] = offset;
        samples[slot + 2] = el.scrollTop;
        state.count += 1;
        state.frame = requestAnimationFrame(() => channel.port2.postMessage(0));
      };
      state.frame = requestAnimationFrame(() => channel.port2.postMessage(0));
      (window as unknown as { __anchorProbe: unknown }).__anchorProbe = {
        stop() {
          state.running = false;
          cancelAnimationFrame(state.frame);
          const kept = Math.min(state.count, capacity);
          const start = state.count - kept;
          const trace = Array.from({ length: kept }, (_, index) => {
            const slot = ((start + index) % capacity) * 3;
            return [samples[slot]!, samples[slot + 1]!, samples[slot + 2]!];
          });
          return {
            count: state.count,
            missing: state.missing,
            maxError: state.maxError,
            expected,
            trace,
          };
        },
      };
    },
    { partId, capacity },
  );
}

export async function stopAnchorProbe(scroller: Locator): Promise<AnchorProbeResult> {
  return scroller.evaluate(() =>
    (window as unknown as { __anchorProbe: { stop(): AnchorProbeResult } }).__anchorProbe.stop(),
  );
}

/** The transcript controller's content-free counters (see `SCROLL_DIAGNOSTICS_PROPERTY`). */
export async function scrollDiagnostics(scroller: Locator): Promise<Record<string, unknown>> {
  return scroller.evaluate(
    (el) =>
      (
        el as unknown as { orkTranscriptScrollDiagnostics?: () => Record<string, unknown> }
      ).orkTranscriptScrollDiagnostics?.() ?? {},
  );
}
