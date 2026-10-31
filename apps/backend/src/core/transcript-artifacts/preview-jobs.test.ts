import { describe, expect, mock, spyOn, test } from "bun:test";

import { chromium } from "playwright-core";

import { runWorkerJob } from "./preview-jobs.js";
import type { WorkerJobPackage } from "./preview-worker-protocol.js";

const PROBE: WorkerJobPackage = {
  v: 1,
  job: { kind: "probe" },
  limits: { readinessMs: 2_000, mermaidRenderMs: 2_000, probeStepMs: 1_000, workerWallMs: 5_000 },
};

describe("preview worker launch failures", () => {
  test.each([
    {
      error:
        "browserType.launchServer: [ERROR:net/socket/unix_domain_server_socket_posix.cc:117] Socket path too long: /tmp/worker/SingletonSocket",
      message:
        "Chromium could not start in the preview worker: its temporary directory path is too long for Chromium's socket",
    },
    {
      error: "browserType.launchServer: Chromium sandboxing failed!",
      message: "Chromium could not start with its sandbox enabled in the preview worker",
    },
  ])("reports the cause of $error", async ({ error, message }) => {
    const launch = spyOn(chromium, "launchServer").mockRejectedValue(new Error(error));
    const emit = mock(() => {});
    try {
      const result = await runWorkerJob(PROBE, emit);
      expect(result).toMatchObject({
        ok: false,
        kind: "probe",
        failure: { code: "renderer_unavailable", message, resource: "browser-launch" },
      });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ chromiumSandbox: true }));
      expect(emit).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
    }
  });
});
