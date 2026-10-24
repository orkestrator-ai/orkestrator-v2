import { expect, test, type Page } from "@playwright/test";
import { scrollDiagnostics, startAnchorProbe, stopAnchorProbe } from "./transcript-anchor-probe";

declare global {
  interface Window {
    transcriptStabilityProbe?: {
      removed: boolean;
      mutations: number;
      stop: () => void;
    };
  }
}

const scrollerSelector = '[data-transcript-scroller="true"]';

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
  // The block's calls are folded to one line until the reader opens them.
  // Retried: the jump keeps correcting the rows around it for a while, and an
  // activation that lands while its row is re-laid out can miss the trigger.
  await expect(async () => {
    const show = historicToolRow.getByRole("button", { name: /^Show 16 tool calls:/ });
    if ((await show.count()) > 0) await show.press("Enter");
    await expect(historicToolRow.getByRole("button", { name: /^Fold 16 tool calls:/ })).toBeVisible(
      {
        timeout: 1_000,
      },
    );
  }).toPass();
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

test("a selection in the first row survives clipped overscan up to the protection bound", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1");
  await releaseStickyScroll(page);
  const scroller = page.locator(scrollerSelector);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const row = page.locator('[data-chat-message-index="0"]');
  await expect(row).toBeVisible();
  await waitForFrames(page, 8);
  const held = await row.elementHandle();
  await row.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element.querySelector("p")!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  for (let index = 1; index <= 20; index++) {
    await scroller.evaluate((element, next) => {
      const target = element.querySelector(`[data-chat-message-index="${next}"]`)!;
      element.scrollTop +=
        target.getBoundingClientRect().top - element.getBoundingClientRect().top + 1;
      element.dispatchEvent(new Event("scroll"));
    }, index);
    await waitForFrames(page, 4);
    if (index <= 8) expect(await held!.evaluate((element) => element.isConnected)).toBe(true);
    if (index === 8)
      expect(await page.evaluate(() => document.getSelection()?.toString())).toContain(
        "History message 0",
      );
  }
  // Past protection and the ordinary 400px viewport buffer it virtualizes away.
  await expect(row).toHaveCount(0);
});

test("a detached reader's row holds every painted frame while new rows stream", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1");
  await releaseStickyScroll(page);
  await page.getByRole("button", { name: "Scroll to tool history" }).click();
  const scroller = page.locator(scrollerSelector);
  const historicToolRow = page.locator('[data-chat-message-index="40"]');
  await expect(historicToolRow).toBeVisible();
  await expect
    .poll(async () => (await scrollDiagnostics(scroller)).lastOutcome)
    .toMatch(/converged|clamped/);
  await startAnchorProbe(scroller, 'css:[data-chat-message-index="40"]');
  for (let index = 0; index < 4; index++) {
    await page.getByRole("button", { name: "Append turn" }).click();
    await expect(page.getByTestId("transcript-row-count")).toHaveText(String(84 + index));
  }
  await waitForFrames(page, 12);
  const probe = await stopAnchorProbe(scroller);
  expect(probe.count).toBeGreaterThan(8);
  expect(probe.missing).toBe(0);
  expect(probe.maxError).toBeLessThanOrEqual(2);
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(100);
});

test("a downward wheel during a history jump keeps the reader in control", async ({ page }) => {
  await page.goto("/streaming-transcript?long=1");
  await releaseStickyScroll(page);
  const scroller = page.locator(scrollerSelector);
  const before = await scrollDiagnostics(scroller);
  // Start the jump and interrupt it in the same task, before its first
  // correction can run, in the direction a naive cancel ignores. The native
  // movement the wheel would cause is applied directly.
  await scroller.evaluate((element) => {
    const jump = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Scroll to tool history",
    )!;
    jump.click();
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 240, bubbles: true }));
    element.scrollTop += 240;
  });
  await waitForFrames(page, 10);
  const afterWheel = await scroller.evaluate((element) => element.scrollTop);
  const writesAfterWheel = (await scrollDiagnostics(scroller)).writes as number;
  // Past every guardrail the retired operation could have used.
  await page.waitForTimeout(1_000);
  const diagnostics = await scrollDiagnostics(scroller);
  expect(diagnostics.operationsStarted).toBe((before.operationsStarted as number) + 1);
  expect(diagnostics.lastOutcome).toBe("cancelled");
  expect(diagnostics.userInterruptions).toBe((before.userInterruptions as number) + 1);
  expect(diagnostics.writes).toBe(writesAfterWheel);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(afterWheel, 0);
  // The reader stays detached: streaming does not pull them to the tail.
  await page.getByRole("button", { name: "Append turn" }).click();
  await waitForFrames(page, 6);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(afterWheel, 0);
});

test("a real wheel after a history jump is never pulled back", async ({ page }) => {
  await page.goto("/streaming-transcript?long=1");
  await releaseStickyScroll(page);
  const scroller = page.locator(scrollerSelector);
  await page.getByRole("button", { name: "Scroll to tool history" }).click();
  await scroller.hover();
  await page.mouse.wheel(0, 240);
  await waitForFrames(page, 10);
  const afterWheel = await scroller.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(1_000);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(afterWheel, 0);
});

test("a detached reader holds their place through a reflow in either direction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/streaming-transcript?long=1");
  await releaseStickyScroll(page);
  await page.getByRole("button", { name: "Scroll to tool history" }).click();
  const scroller = page.locator(scrollerSelector);
  await expect
    .poll(async () => (await scrollDiagnostics(scroller)).lastOutcome)
    .toMatch(/converged|clamped/);
  const part = await page
    .locator('[data-chat-message-index="40"] [data-transcript-part-id]')
    .first()
    .getAttribute("data-transcript-part-id");
  // The rows above the reader, whose re-wrapping is what moves them.
  const heightsAbove = () =>
    scroller.evaluate((element) =>
      Object.fromEntries(
        Array.from(element.querySelectorAll<HTMLElement>("[data-chat-message-index]"))
          .filter((row) => Number(row.dataset.chatMessageIndex) < 40)
          .map((row) => [row.dataset.chatMessageIndex!, row.getBoundingClientRect().height]),
      ),
    );
  await waitForFrames(page, 12);
  for (const width of [420, 1200]) {
    const before = await heightsAbove();
    await startAnchorProbe(scroller, part!);
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(800);
    const probe = await stopAnchorProbe(scroller);
    // Not vacuous: the rows above that stayed mounted really re-wrapped.
    const after = await heightsAbove();
    const changed = Object.keys(before)
      .filter((index) => index in after)
      .reduce((total, index) => total + Math.abs(after[index]! - before[index]!), 0);
    expect(changed).toBeGreaterThan(40);
    expect(probe.count).toBeGreaterThan(10);
    expect(probe.missing).toBe(0);
    expect(probe.maxError).toBeLessThanOrEqual(3);
  }
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(100);
});

test("a follower stays at the latest row through a reflow", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/streaming-transcript?long=1");
  await expect(page.locator(scrollerSelector)).toBeVisible();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(2);
  await page.setViewportSize({ width: 420, height: 900 });
  await waitForFrames(page, 12);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(2);
});

test("scrollbar departure after find stays put when streaming reapplies highlights", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1");
  const scroller = page.locator('[data-transcript-scroller="true"]');
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("textbox", { name: "Find in chat" }).fill("History message 75:");
  const match = page.locator('[data-chat-message-key="history-75"]');
  await expect(match).toBeVisible();
  // Wait for the bounded find operation to converge before dragging away.
  await expect.poll(async () => (await scrollDiagnostics(scroller)).lastOutcome).toBe("converged");
  await scroller.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.scrollTop -= 500;
    element.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new PointerEvent("pointerup"));
  });
  await waitForFrames(page, 8);
  const before = await scroller.evaluate((element) => element.scrollTop);
  const writes = (await scrollDiagnostics(scroller)).writes;
  const rowCount = Number(await page.getByTestId("transcript-row-count").textContent());
  await page.getByRole("button", { name: "Append turn" }).click();
  await expect(page.getByTestId("transcript-row-count")).toHaveText(String(rowCount + 1));
  // Flush highlight application and operation reconciliation frames.
  await waitForFrames(page, 12);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
  expect((await scrollDiagnostics(scroller)).writes).toBe(writes);
});
