import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    transcriptStabilityProbe?: {
      removed: boolean;
      mutations: number;
      stop: () => void;
    };
  }
}

for (const action of ["Append section", "Append tool"]) {
  test(`earlier tool block stays mounted during ${action.toLowerCase()}`, async ({ page }) => {
    await page.goto("/streaming-transcript");
    const scroller = page.locator('[data-virtuoso-scroller="true"]');
    await expect(page.getByText("The live app check matches the expected behavior.")).toBeVisible();
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    const row = page.locator('[data-chat-message-index="0"]');
    await expect(row).toBeVisible();
    await page.evaluate(() => {
      const root = document.querySelector("[data-virtuoso-scroller]")!;
      const first = root.querySelector('[data-chat-message-index="0"]')!;
      const probe = { removed: false, mutations: 0, stop: () => observer.disconnect() };
      // Checking only the settled DOM misses the bug: the row disappears and
      // returns between updates. Do not measure layout here, which changes the
      // very measurement timing this regression is exercising.
      const observer = new MutationObserver(() => {
        probe.mutations += 1;
        probe.removed ||= !first.isConnected;
      });
      observer.observe(root, { childList: true, subtree: true });
      window.transcriptStabilityProbe = probe;
    });
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: action }).click();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let frames = 0;
            const next = () => (++frames === 4 ? resolve() : requestAnimationFrame(next));
            requestAnimationFrame(next);
          }),
      );
    }
    const result = await page.evaluate(() => {
      const probe = window.transcriptStabilityProbe!;
      probe.stop();
      return { removed: probe.removed, mutations: probe.mutations };
    });
    expect(result.mutations).toBeGreaterThan(0);
    expect(result.removed).toBe(false);
    await expect(row).toBeVisible();
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
  });
}
