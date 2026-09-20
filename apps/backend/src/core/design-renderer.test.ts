import { describe, expect, mock, test } from "bun:test";
import type { Browser } from "playwright-core";
import { DesignRenderer, resolveDesignChromiumPath } from "./design-renderer.js";

const frame = { html: "<p>Hello</p>", width: 320, height: 240 };

function fakeBrowser(options: { screenshot?: Buffer; block?: Promise<void> } = {}) {
  const abort = mock(() => {});
  const close = mock(async () => {});
  const page = {
    setDefaultTimeout() {},
    setContent: mock(async () => {}),
    evaluate: mock(async (_fn: unknown, operation: { op: string }) => {
      if (options.block) await options.block;
      return operation.op === "render" ? true : frame.html;
    }),
    screenshot: mock(async () => options.screenshot ?? Buffer.from("png")),
  };
  const context = {
    close,
    route: mock(async (_pattern: string, handler: (route: { abort: () => void }) => void) => {
      handler({ abort });
    }),
    newPage: mock(async () => page),
  };
  const browser = {
    once: mock(() => {}),
    newContext: mock(async () => context),
    close: mock(async () => {}),
  } as unknown as Browser;
  return { browser, abort, close, page };
}

describe("DesignRenderer", () => {
  test("reports an actionable missing-browser status", () => {
    expect(
      resolveDesignChromiumPath(
        { ORKESTRATOR_DESIGN_CHROMIUM_PATH: "/definitely/missing/chromium" },
        [],
      ),
    ).toBeUndefined();
    expect(new DesignRenderer(undefined, () => undefined).status()).toEqual({
      ready: false,
      error: expect.stringContaining("ORKESTRATOR_DESIGN_CHROMIUM_PATH"),
    });
  });

  test("resets a failed launch and can retry", async () => {
    const fake = fakeBrowser();
    let attempts = 0;
    const launch = mock(async () => {
      attempts++;
      if (attempts === 1) throw new Error("launch failed");
      return fake.browser;
    });
    const renderer = new DesignRenderer(launch as never, () => "/chromium");
    await expect(renderer.run(frame, { op: "serialize" })).rejects.toThrow("needs Chromium");
    await expect(renderer.run(frame, { op: "serialize" })).resolves.toBe(frame.html);
    expect(launch).toHaveBeenCalledTimes(2);
    await renderer.close();
  });

  test("aborts every network route and rejects oversized captures", async () => {
    const fake = fakeBrowser({ screenshot: Buffer.alloc(8 * 1024 * 1024 + 1) });
    const renderer = new DesignRenderer(mock(async () => fake.browser) as never, () => "/chromium");
    await expect(renderer.run(frame, { op: "capture" })).rejects.toThrow("Capture exceeds 8 MiB");
    expect(fake.abort).toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalled();
    await renderer.close();
  });

  test("rejects the seventeenth pending render and recovers after the queue drains", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeBrowser({ block: blocked });
    const renderer = new DesignRenderer(mock(async () => fake.browser) as never, () => "/chromium");
    const pending = Array.from({ length: 16 }, () => renderer.run(frame, { op: "serialize" }));
    await expect(renderer.run(frame, { op: "serialize" })).rejects.toThrow("renderer busy");
    release();
    await expect(Promise.all(pending)).resolves.toHaveLength(16);
    await expect(renderer.run(frame, { op: "serialize" })).resolves.toBe(frame.html);
    await renderer.close();
  });
});
