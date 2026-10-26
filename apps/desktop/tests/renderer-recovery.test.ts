import { describe, expect, mock, test } from "bun:test";
import {
  installRendererRecovery,
  RENDERER_RECOVERY_MAX_RELOADS,
  RENDERER_RECOVERY_WINDOW_MS,
} from "../electron/renderer-recovery";

function harness() {
  let handler: ((event: unknown, details: { reason: string; exitCode: number }) => void) | null =
    null;
  const state = { destroyed: false, time: 0 };
  const reload = mock(() => undefined);
  const pending: (() => void)[] = [];
  const log = mock((_message: string) => undefined);
  installRendererRecovery(
    {
      on: ((_name: string, callback: typeof handler) => {
        handler = callback;
      }) as never,
      reload,
      isDestroyed: () => state.destroyed,
    },
    { log, now: () => state.time, schedule: (callback) => void pending.push(callback) },
  );
  return {
    reload,
    log,
    state,
    gone: (reason: string) => handler?.({}, { reason, exitCode: reason === "killed" ? 9 : 0 }),
    flush: () => pending.splice(0).forEach((callback) => callback()),
  };
}

describe("renderer recovery", () => {
  test("reloads a window whose renderer was killed instead of leaving it white", () => {
    const { gone, flush, reload, log } = harness();
    gone("killed");
    expect(reload).not.toHaveBeenCalled();
    flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("killed");
  });

  test("leaves a clean exit and a destroyed window alone", () => {
    const { gone, flush, reload, state } = harness();
    gone("clean-exit");
    flush();
    gone("crashed");
    state.destroyed = true;
    flush();
    expect(reload).not.toHaveBeenCalled();
  });

  test("coalesces overlapping crash events without consuming the reload budget", () => {
    const { gone, flush, reload } = harness();
    for (let attempt = 0; attempt < RENDERER_RECOVERY_MAX_RELOADS; attempt += 1) {
      gone("crashed");
      gone("killed");
      gone("oom");
      flush();
      expect(reload).toHaveBeenCalledTimes(attempt + 1);
    }
    gone("crashed");
    flush();
    expect(reload).toHaveBeenCalledTimes(RENDERER_RECOVERY_MAX_RELOADS);
  });

  test("logs a disposed-frame reload failure and allows subsequent recovery", () => {
    const { gone, flush, reload, log } = harness();
    reload.mockImplementationOnce(() => {
      throw new Error("Render frame was disposed");
    });
    gone("crashed");
    expect(flush).not.toThrow();
    expect(log.mock.calls.at(-1)![0]).toContain("Render frame was disposed");
    gone("killed");
    flush();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  test("stops reloading a renderer that keeps dying, and starts again later", () => {
    const { gone, flush, reload, state } = harness();
    for (let attempt = 0; attempt <= RENDERER_RECOVERY_MAX_RELOADS; attempt += 1) {
      gone("crashed");
      flush();
      state.time += 1_000;
    }
    expect(reload).toHaveBeenCalledTimes(RENDERER_RECOVERY_MAX_RELOADS);

    state.time += RENDERER_RECOVERY_WINDOW_MS;
    gone("oom");
    flush();
    expect(reload).toHaveBeenCalledTimes(RENDERER_RECOVERY_MAX_RELOADS + 1);
  });
});
