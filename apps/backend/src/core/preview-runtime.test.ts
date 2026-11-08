import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

let harness: PreviewHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("PreviewRuntime.init", () => {
  test("a failed init is retried by the next call instead of poisoning the runtime", async () => {
    harness = await createPreviewHarness();
    const load = spyOn(harness.storage.previewServices, "loadPreviewSettings");
    try {
      load.mockImplementationOnce(async () => {
        throw new Error("settings unavailable");
      });
      const first = harness.runtime.init();
      // Concurrent callers share the one failing attempt.
      expect(harness.runtime.init()).toBe(first);
      await expect(first).rejects.toThrow("settings unavailable");
      expect(load).toHaveBeenCalledTimes(1);

      await harness.runtime.init();
      expect(load).toHaveBeenCalledTimes(2);
      // A successful init is kept.
      await harness.runtime.init();
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      load.mockRestore();
    }
  });

  test("concurrent callers share one successful attempt", async () => {
    harness = await createPreviewHarness();
    const load = spyOn(harness.storage.previewServices, "loadPreviewSettings");
    try {
      const calls = [harness.runtime.init(), harness.runtime.init(), harness.runtime.init()];
      expect(new Set(calls).size).toBe(1);
      await Promise.all(calls);
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });
});
