import { expect, spyOn, test } from "bun:test";
import { withDesignLiveHeartbeat } from "./design-live-heartbeat";

for (const outcome of ["complete", "timeout"] as const) {
  test(`unchanged projection and approval waits stay below the silence limit until ${outcome}`, async () => {
    let now = 0;
    let lastOutput = 0;
    let tick = () => {};
    let interval = 0;
    let stopped = false;
    const log = spyOn(console, "log").mockImplementation(() => {
      lastOutput = now;
    });
    try {
      const run = withDesignLiveHeartbeat(
        "claude",
        async () => {
          // Virtual time exceeds both the runner's 300 s silence limit and
          // the live turn's 420 s limit without any projection progress.
          for (now = 1_000; now <= 480_000; now += 1_000) {
            if (now % interval === 0) tick();
            expect(now - lastOutput).toBeLessThan(300_000);
          }
          if (outcome === "timeout") throw new Error("turn timeout");
          return "done";
        },
        (emit, intervalMs) => {
          tick = emit;
          interval = intervalMs;
          return () => {
            stopped = true;
          };
        },
      );
      if (outcome === "timeout") await expect(run).rejects.toThrow("turn timeout");
      else expect(await run).toBe("done");
      expect(interval).toBeLessThanOrEqual(60_000);
      expect(log).toHaveBeenCalledTimes(8);
      expect(log.mock.calls.every((args) => args[0] === "[design-live] claude heartbeat")).toBe(
        true,
      );
      expect(stopped).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
}
