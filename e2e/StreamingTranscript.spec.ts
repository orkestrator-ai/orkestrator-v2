import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    transcriptStabilityProbe?: {
      removed: boolean;
      mutations: number;
      stop: () => void;
    };
  }
}

const scrollerSelector = '[data-virtuoso-scroller="true"]';

async function waitForFrames(page: Page, count = 4) {
  await page.evaluate(
    (frameCount) =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const next = () => (++frames === frameCount ? resolve() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
    count,
  );
}

async function distanceFromBottom(page: Page) {
  return page
    .locator(scrollerSelector)
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

async function releaseStickyScroll(page: Page) {
  const scroller = page.locator(scrollerSelector);
  await expect(scroller).toBeVisible();
  await waitForFrames(page, 8);
  await scroller.evaluate((element) => {
    // Seed the hook's last observed position before expressing upward user
    // intent; initial bottom-follow can settle without a browser scroll event.
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.scrollTop = Math.max(0, element.scrollTop - 600);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(100);
}

for (const { action, rowDelta } of [
  { action: "Append section", rowDelta: 2 },
  { action: "Append tool", rowDelta: 1 },
]) {
  test(`earlier tool block stays mounted during ${action.toLowerCase()}`, async ({ page }) => {
    await page.goto("/streaming-transcript");
    const scroller = page.locator(scrollerSelector);
    await expect(page.getByText("The live app check matches the expected behavior.")).toBeVisible();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
    const row = page.locator('[data-chat-message-index="0"]');
    await expect(
      row,
      "precondition: the observed row must be inside the render window",
    ).toBeVisible();
    const initialRowCount = Number(await page.getByTestId("transcript-row-count").textContent());
    expect(initialRowCount).toBe(3);

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
      await expect(page.getByTestId("transcript-row-count")).toHaveText(
        String(initialRowCount + rowDelta * (i + 1)),
      );
      await waitForFrames(page);
    }
    const result = await page.evaluate(() => {
      const probe = window.transcriptStabilityProbe!;
      probe.stop();
      return { removed: probe.removed, mutations: probe.mutations };
    });
    expect(result.mutations).toBeGreaterThan(0);
    expect(result.removed).toBe(false);
    await expect(row).toBeVisible();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
    await expect(scroller).toBeVisible();
  });
}

test("cold fill keeps the long transcript render window bounded", async ({ page }) => {
  await page.goto("/streaming-transcript?long=1");
  await expect(page.getByTestId("transcript-row-count")).toHaveText("83");
  await expect
    .poll(() => page.evaluate(() => window.transcriptRenderProbe?.firstFrameMounted ?? null))
    .not.toBeNull();

  const probe = await page.evaluate(() => window.transcriptRenderProbe!);
  const mountedRows = await page.locator("[data-chat-message-index]").count();
  expect(probe.firstFrameMounted).toBeLessThanOrEqual(8);
  expect(probe.maxMounted).toBeLessThanOrEqual(24);
  expect(mountedRows).toBeLessThanOrEqual(24);
});

test("a tool row outside the render window remains reachable after a long-session append", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1");
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
  const historicToolRow = page.locator('[data-chat-message-index="40"]');
  await expect(
    historicToolRow,
    "precondition: long-session history must be fully outside the render window",
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Append turn" }).click();
  await expect(page.getByTestId("transcript-row-count")).toHaveText("84");
  await expect(historicToolRow).toHaveCount(0);

  await releaseStickyScroll(page);
  await page.getByRole("button", { name: "Scroll to tool history" }).click();
  await expect(historicToolRow).toBeVisible();
  await expect(historicToolRow.getByRole("button", { name: "Exec Command success" })).toHaveCount(
    16,
  );
});

test("non-sticky history keeps its anchor while new transcript rows stream", async ({ page }) => {
  await page.goto("/streaming-transcript?long=1");
  await releaseStickyScroll(page);
  await page.getByRole("button", { name: "Scroll to tool history" }).click();
  const historicToolRow = page.locator('[data-chat-message-index="40"]');
  await expect(historicToolRow).toBeVisible();
  await waitForFrames(page, 8);
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(100);
  const anchorTop = (await historicToolRow.boundingBox())!.y;

  for (let index = 0; index < 3; index++) {
    await page.getByRole("button", { name: "Append turn" }).click();
    await expect(page.getByTestId("transcript-row-count")).toHaveText(String(84 + index));
    await waitForFrames(page);
    const currentTop = (await historicToolRow.boundingBox())!.y;
    expect(Math.abs(currentTop - anchorTop)).toBeLessThanOrEqual(2);
    await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(100);
  }
});

test("measured history restores before an explicit jump to the latest row", async ({ page }) => {
  await page.goto("/streaming-transcript?long=1");
  await releaseStickyScroll(page);
  await page.getByRole("button", { name: "Scroll to tool history" }).click();
  const historicToolRow = page.locator('[data-chat-message-index="40"]');
  await expect(historicToolRow).toBeVisible();
  await waitForFrames(page, 8);
  const scrollTopBefore = await page
    .locator(scrollerSelector)
    .evaluate((element) => element.scrollTop);

  await page.getByRole("button", { name: "Save and remount" }).click();
  await expect(page.getByTestId("list-generation")).toHaveText("1");
  await expect
    .poll(() => page.evaluate(() => window.transcriptRenderProbe?.restoredRangeCount ?? 0))
    .toBeGreaterThan(0);
  await expect(historicToolRow).toBeVisible();
  await expect
    .poll(() => page.locator(scrollerSelector).evaluate((element) => element.scrollTop))
    .toBeCloseTo(scrollTopBefore, -1);

  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
  await expect(page.locator('[data-chat-message-index="82"]')).toBeVisible();
});
