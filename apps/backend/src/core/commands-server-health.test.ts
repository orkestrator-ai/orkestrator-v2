import { describe, expect, mock, test } from "bun:test";

import { confirmRunningServerHealth } from "./commands-server-health.js";
import {
  LOCAL_SERVER_REUSE_FIRST_PROBE_TIMEOUT_MS,
  LOCAL_SERVER_REUSE_HEALTH_INTERVAL_MS,
  LOCAL_SERVER_REUSE_RETRY_PROBE_TIMEOUT_MS,
} from "./commands-runtime-state.js";

describe("confirmRunningServerHealth", () => {
  test("exits when the child dies after the first failed probe", async () => {
    let alive = true;
    const checkHealth = mock(async () => {
      alive = false;
      return false;
    });
    const delay = mock(async () => undefined);

    expect(
      await confirmRunningServerHealth(1234, undefined, () => alive, { checkHealth, delay }),
    ).toEqual({ healthy: false, failedProbes: 1 });
    expect(checkHealth).toHaveBeenCalledTimes(1);
    expect(checkHealth).toHaveBeenCalledWith(
      1234,
      "/global/health",
      undefined,
      LOCAL_SERVER_REUSE_FIRST_PROBE_TIMEOUT_MS,
    );
    expect(delay).not.toHaveBeenCalled();
  });

  test("uses the longer timeout for retry probes and counts each failure", async () => {
    const timeouts: number[] = [];
    const checkHealth = mock(
      async (
        _port: number,
        _path?: string,
        _headers?: Record<string, string>,
        timeoutMs?: number,
      ) => {
        timeouts.push(timeoutMs ?? -1);
        return false;
      },
    );
    const delay = mock(async () => undefined);

    expect(
      await confirmRunningServerHealth(1234, undefined, () => true, { checkHealth, delay }),
    ).toEqual({ healthy: false, failedProbes: 3 });
    expect(timeouts).toEqual([
      LOCAL_SERVER_REUSE_FIRST_PROBE_TIMEOUT_MS,
      LOCAL_SERVER_REUSE_RETRY_PROBE_TIMEOUT_MS,
      LOCAL_SERVER_REUSE_RETRY_PROBE_TIMEOUT_MS,
    ]);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(LOCAL_SERVER_REUSE_HEALTH_INTERVAL_MS);
  });
});
