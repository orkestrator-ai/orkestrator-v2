import { expect, test, type Frame, type Page } from "@playwright/test";
import type {} from "./fixture/RichTranscriptPerfFixture";

const SCROLLER = '[data-transcript-scroller="true"]';
const IFRAME = 'iframe[data-artifact-static-document="true"]';
const RENDERED = `${IFRAME}[data-state="rendered"]`;
/** The message indexes of the fixture's static documents. */
const staticRow = (n: number) => 25 + n * 150;
const staticCard = (n: number) =>
  `[data-artifact-publication="pub_perf${String(1_000 + n).padStart(8, "0")}"]`;

interface FrameStats {
  mounted: number;
  granted: number;
  framesMounted: number;
  framesReloaded: number;
  framesFailed: number;
}

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/rich-transcript-perf${query}`);
  await page.waitForFunction(() => window.__richPerf?.ready === true);
}

async function frameStats(page: Page): Promise<FrameStats> {
  return page.evaluate(() => window.__richPerf!.stats().staticFrames as FrameStats);
}

async function jumpToStatic(page: Page, n: number): Promise<Frame> {
  await page.evaluate((index) => window.__richPerf!.scrollToIndex(index), staticRow(n));
  const iframe = page.locator(staticCard(n)).locator(RENDERED);
  // Includes loading the document, which a saturated host can take seconds over.
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  const frame = await (await iframe.elementHandle())!.contentFrame();
  if (!frame) throw new Error("No frame");
  return frame;
}

function distanceFromBottom(page: Page): Promise<number> {
  return page
    .locator(SCROLLER)
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

test.describe("static documents in the virtualized transcript", () => {
  test("opening a conversation frames nothing until a report is reached", async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__richPerf!.scrollToBottom());
    await page.waitForTimeout(500);
    expect(await frameStats(page)).toMatchObject({ mounted: 0, framesMounted: 0, granted: 0 });
  });

  test("scrolling through more reports than slots stays bounded, with no reload or failure", async ({
    page,
  }) => {
    await open(page);
    for (let n = 0; n < 8; n++) {
      await jumpToStatic(page, n);
      const stats = await frameStats(page);
      expect(stats.mounted).toBeLessThanOrEqual(4);
      expect(stats.granted).toBeLessThanOrEqual(4);
    }
    // Revisiting converges instead of accumulating.
    for (let n = 0; n < 4; n++) await jumpToStatic(page, n);
    const stats = await frameStats(page);
    expect(stats.mounted).toBeLessThanOrEqual(4);
    expect(stats.framesReloaded).toBe(0);
    expect(stats.framesFailed).toBe(0);
    await expect(page.locator('[data-artifact-static-state="failed"]')).toHaveCount(0);
  });

  test("streaming into another message does not reload a completed document", async ({ page }) => {
    await open(page);
    const frame = await jumpToStatic(page, 2);
    await frame.evaluate(() => {
      (window as unknown as { __stillHere: boolean }).__stillHere = true;
    });
    const before = await frameStats(page);
    const reads = () =>
      page.evaluate(
        () => window.__richPerf!.counters().backendCalls.transcript_artifact_read_representation,
      );
    const readsBefore = await reads();
    await page.evaluate(() => window.__richPerf!.startStream(20, 24));
    await page.waitForTimeout(1_500);
    await page.evaluate(() => window.__richPerf!.stopStream());
    expect(
      await frame.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere),
    ).toBe(true);
    expect(await frameStats(page)).toMatchObject({
      framesMounted: before.framesMounted,
      framesReloaded: 0,
    });
    expect(await reads()).toBe(readsBefore);
  });

  test("a resize while reading history does not move the reader or pull them down", async ({
    page,
  }) => {
    await open(page);
    const frame = await jumpToStatic(page, 3);
    const iframe = page.locator(staticCard(3)).locator(RENDERED);
    // Bring the control on screen first, so the click itself scrolls nothing.
    await frame.locator("summary").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const before = await iframe.boundingBox();
    const heightBefore = before!.height;
    await frame.locator("summary").click();
    await expect
      .poll(async () => (await iframe.boundingBox())!.height)
      .toBeGreaterThan(heightBefore);
    const after = await iframe.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
    expect(await distanceFromBottom(page)).toBeGreaterThan(5_000);
  });

  test("growth while following the end keeps following", async ({ page }) => {
    await open(page, "?staticTail=1");
    await page.evaluate(() => window.__richPerf!.scrollToBottom());
    const iframe = page.locator(RENDERED);
    await expect(iframe).toBeVisible();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
    const heightBefore = (await iframe.boundingBox())!.height;
    const frame = await (await iframe.elementHandle())!.contentFrame();
    await frame!.locator("summary").click();
    await expect
      .poll(async () => (await iframe.boundingBox())!.height)
      .toBeGreaterThan(heightBefore);
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
  });

  test("a selection survives scrolling the frame out of view while its row is mounted", async ({
    page,
  }) => {
    await open(page);
    const frame = await jumpToStatic(page, 4);
    await frame.locator("h2").click();
    await frame.locator("h2").selectText();
    const text = await frame.evaluate(() => document.getSelection()?.toString());
    expect(text).toContain("Synthetic report");
    const iframe = page.locator(staticCard(4)).locator(RENDERED);
    // Just past the fold, inside Virtuoso's 200 px overscan: off screen, still mounted.
    // Reapplied until it holds: the jump's own anchoring can still be settling.
    await expect(async () => {
      await page.locator(SCROLLER).evaluate((element, selector) => {
        const target = document.querySelector(selector)!.getBoundingClientRect();
        const bottom = element.getBoundingClientRect().bottom;
        if (target.top < bottom + 20) element.scrollTop -= bottom - target.top + 100;
      }, RENDERED);
      await expect(iframe).not.toBeInViewport({ timeout: 300 });
    }).toPass({ timeout: 5_000 });
    await page.waitForTimeout(500);
    await expect(iframe).toHaveCount(1);
    expect(await frame.evaluate(() => document.getSelection()?.toString())).toBe(text);
    const stats = await frameStats(page);
    expect(stats.framesReloaded).toBe(0);
    expect(stats.mounted).toBeLessThanOrEqual(4);
  });
});
