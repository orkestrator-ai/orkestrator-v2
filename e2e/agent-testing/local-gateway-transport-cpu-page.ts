import { TERMINAL_VISIBLE_TEXT_PAGE_SOURCE } from "./terminal-visible-text";

/** Page code: count and keep the tail of one terminal session's frames. */
export function listenCode(sessionId: string): string {
  return `(async () => {
    const state = { tail: "", count: 0, desynced: 0, keys: "", waiters: [] };
    globalThis.__cpuTerminal = state;
    await window.orkestrator.listen(${JSON.stringify(`terminal-output-${sessionId}`)}, (payload) => {
      state.count += 1;
      if (payload && typeof payload === "object") {
        state.keys = Object.keys(payload).sort().join(",");
        if (payload.desynced) state.desynced += 1;
        if (typeof payload.text === "string") state.tail = (state.tail + payload.text).slice(-4096);
      }
      for (const waiter of state.waiters.splice(0)) waiter();
    });
    // As a terminal view does: the direct transport's terminal socket holds a
    // channel's frames until the page has applied a snapshot.
    if ("orkestratorDesktopHost" in window) {
      await window.orkestrator.eventStreamReady(${JSON.stringify(`terminal-output-${sessionId}`)});
      const snapshot = await window.orkestrator.invoke("get_terminal_output_snapshot", {
        sessionId: ${JSON.stringify(sessionId)},
      });
      await window.orkestrator.invoke("terminal_snapshot_applied", {
        sessionId: ${JSON.stringify(sessionId)},
        generation: snapshot.generation,
        revision: snapshot.revision,
      });
    }
    return true;
  })()`;
}

/**
 * Page code: resolve once `marker` has arrived in this window, from its own
 * frames or, after a desync dropped some, the authoritative snapshot. Its
 * escape stripping is the shared helper's, as page source.
 */
export function waitCode(sessionId: string, marker: string): string {
  return `new Promise((resolve, reject) => {
    const state = globalThis.__cpuTerminal;
    const visible = ${TERMINAL_VISIBLE_TEXT_PAGE_SOURCE};
    let recovered = state.desynced;
    const check = async () => {
      if (visible(state.tail).includes(${JSON.stringify(marker)})) return resolve(state.count);
      if (state.desynced > recovered) {
        recovered = state.desynced;
        const snapshot = await window.orkestrator.invoke("get_terminal_output_snapshot", {
          sessionId: ${JSON.stringify(sessionId)},
        });
        await window.orkestrator.invoke("terminal_snapshot_applied", {
          sessionId: ${JSON.stringify(sessionId)}, generation: snapshot.generation, revision: snapshot.revision,
        });
        if (visible(snapshot.output).includes(${JSON.stringify(marker)})) return resolve(state.count);
      }
      if (visible(state.tail).includes(${JSON.stringify(marker)})) return resolve(state.count);
      if (state.desynced > recovered) return check();
      state.waiters.push(() => { void check().catch(reject); });
    };
    void check().catch(reject);
  })`;
}

/** Install before opening the workload; observer delivery is independent of the timing buffer. */
export const resourceActivityCode = `(() => {
  const activity = { count: 0, last: performance.now() };
  const observer = new PerformanceObserver((list) => {
    activity.count += list.getEntries().length;
    activity.last = performance.now();
  });
  observer.observe({ type: "resource", buffered: true });
  globalThis.__cpuResources = { activity, observer };
})()`;

export const resourceQuietCode = `(() => {
  const { activity, observer } = globalThis.__cpuResources;
  const pending = observer.takeRecords();
  if (pending.length) { activity.count += pending.length; activity.last = performance.now(); }
  return performance.now() - activity.last >= 3000;
})()`;

export function parseRunCount(value: string | undefined): number {
  const runs = Number(value ?? 3);
  if (!Number.isSafeInteger(runs) || runs <= 0 || runs > 10) {
    throw new Error("ORKESTRATOR_LOCAL_TRANSPORT_CPU_RUNS must be an integer from 1 to 10");
  }
  return runs;
}
