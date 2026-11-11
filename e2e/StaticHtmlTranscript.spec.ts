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

  test("Find matches a report's body once it has been shown, and leads back to its card", async ({
    page,
  }) => {
    await open(page);
    const n = 2;
    // The fixture's report numbers: unique to this report's body, not in its summary.
    const reportNumber = 1_000 + n;
    const query = `Synthetic session ${reportNumber}-7`;
    const input = page.getByRole("textbox", { name: "Find in chat" });
    const result = page.getByRole("search", { name: "Find in agent chat" });
    await page.keyboard.press("ControlOrMeta+f");
    await input.fill(query);
    await expect(result).toContainText("No results");
    await page.keyboard.press("Escape");

    await jumpToStatic(page, n);
    await expect
      .poll(() =>
        page
          .locator(staticCard(n))
          .locator("[data-rich-search-mirror]")
          .evaluate((element) => element.textContent),
      )
      .toContain(query);

    await page.evaluate(() => window.__richPerf!.scrollToBottom());
    await expect(page.locator(staticCard(n))).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+f");
    await input.fill("");
    await input.fill(query);
    await expect(result).toContainText("1 of 1");
    await expect(page.locator(staticCard(n))).toBeVisible({ timeout: 30_000 });
    // Inside a table cell and a closed disclosure alike, but never the styles.
    await input.fill("Synthetic data for the performance gate.");
    await expect(result).not.toContainText("No results");
    await input.fill("border-top:1px");
    await expect(result).toContainText("No results");
  });

  test("Find highlights the active match inside the document and keeps it selected", async ({
    page,
  }) => {
    // Find indexes all 3,000 messages of the fixture each time its bar opens.
    test.slow();
    await open(page);
    const n = 3;
    const reportNumber = 1_000 + n;
    const input = page.getByRole("textbox", { name: "Find in chat" });
    const result = page.getByRole("search", { name: "Find in agent chat" });
    const frame = await jumpToStatic(page, n);
    await expect
      .poll(() =>
        page
          .locator(staticCard(n))
          .locator("[data-rich-search-mirror]")
          .evaluate((element) => element.textContent),
      )
      .toContain(`Synthetic session ${reportNumber}-7`);

    const highlighted = (name: string) =>
      frame.evaluate((highlight) => {
        const ranges = Array.from(
          (CSS.highlights.get(highlight) ?? new Highlight()).values(),
        ) as Range[];
        return ranges.map((range) => range.toString());
      }, name);

    await page.keyboard.press("ControlOrMeta+f");
    await input.fill(`session ${reportNumber}-`);
    await expect(result).toContainText("1 of ");
    const label = await result.textContent();
    const total = Number(/of (\d+)/.exec(label ?? "")?.[1]);
    expect(total).toBeGreaterThan(1);
    await expect
      .poll(() => highlighted("ork-find-match").then((ranges) => ranges.length))
      .toBe(total);
    await expect.poll(() => highlighted("ork-find-active")).toEqual([`session ${reportNumber}-`]);

    // Stepping moves the active match through the frame, in Find's own order.
    const activeRow = () =>
      frame.evaluate(() => {
        const [range] = Array.from(
          (CSS.highlights.get("ork-find-active") ?? new Highlight()).values(),
        ) as Range[];
        return range?.startContainer.parentElement?.closest("tr")?.rowIndex ?? -1;
      });
    await expect.poll(activeRow).toBe(0);
    await page.keyboard.press("Enter");
    await expect(result).toContainText(`2 of ${total}`);
    await expect.poll(activeRow).toBe(1);

    // The document's text and height did not change for it: nothing was written in.
    expect(await frame.evaluate(() => document.querySelectorAll("mark").length)).toBe(0);
    const stats = await frameStats(page);
    expect(stats.framesReloaded).toBe(0);
    expect(stats.framesFailed).toBe(0);

    // A closed disclosure opens for its match and closes again when Find does.
    const notes = () => frame.evaluate(() => document.querySelector("details")?.open);
    expect(await notes()).toBe(false);
    await input.fill("Synthetic data for the performance gate.");
    await expect.poll(notes).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(notes).toBe(false);
    await expect.poll(() => highlighted("ork-find-match")).toEqual([]);
  });

  for (const zoom of [1, 1.5]) {
    test(`Find brings a deep document match into view at ${zoom * 100}% CSS zoom`, async ({
      page,
    }, testInfo) => {
      test.slow();
      await open(page);
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
      }, zoom);
      const frame = await jumpToStatic(page, 3);
      await expect(page.locator(staticCard(3)).locator("[data-rich-search-mirror]")).toContainText(
        "Synthetic data for the performance gate.",
      );
      await page.keyboard.press("ControlOrMeta+f");
      await page
        .getByRole("textbox", { name: "Find in chat" })
        .fill("Synthetic data for the performance gate.");
      await expect
        .poll(async () => {
          const local = await frame.evaluate(() => {
            const [range] = Array.from(
              (CSS.highlights.get("ork-find-active") ?? new Highlight()).values(),
            ) as Range[];
            if (!range) return null;
            const box = range.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom };
          });
          if (!local) return false;
          const host = await page.locator(staticCard(3)).locator(RENDERED).boundingBox();
          const viewport = await page.locator(SCROLLER).boundingBox();
          return (
            !!host &&
            !!viewport &&
            host.y + local.top * zoom >= viewport.y &&
            host.y + local.bottom * zoom <= viewport.y + viewport.height
          );
        })
        .toBe(true);
      await page.screenshot({
        path: `output/visual-previews/static-find-${zoom}-${testInfo.project.name}.png`,
      });
    });
  }

  test("a report opened while Find is open updates the count and highlights itself", async ({
    page,
  }) => {
    // Find indexes all 3,000 messages of the fixture each time its bar opens.
    test.slow();
    await open(page);
    const n = 5;
    const query = `Synthetic session ${1_000 + n}-7`;
    const input = page.getByRole("textbox", { name: "Find in chat" });
    const result = page.getByRole("search", { name: "Find in agent chat" });
    await page.keyboard.press("ControlOrMeta+f");
    await input.fill(query);
    await expect(result).toContainText("No results");
    // Reaching the report is all it takes: the query is not edited again.
    const frame = await jumpToStatic(page, n);
    await expect(result).toContainText("1 of 1");
    await expect
      .poll(() =>
        frame.evaluate(() => {
          const [range] = Array.from(
            (CSS.highlights.get("ork-find-active") ?? new Highlight()).values(),
          ) as Range[];
          return range?.toString();
        }),
      )
      .toBe(query);
  });

  test("Find counts a report the reader never reached from its stored text, then highlights it in its frame", async ({
    page,
  }, testInfo) => {
    // Find indexes all 3,000 messages of the fixture each time its bar opens.
    test.slow();
    // Publications whose verification stored the document's text (5780 task 2).
    await open(page, "?storedText=1");
    const storedTextReads = () =>
      page.evaluate(() => window.__richPerf!.counters().storedTextReads);
    const n = 4;
    const query = `Synthetic session ${1_000 + n}-7`;
    const input = page.getByRole("textbox", { name: "Find in chat" });
    const result = page.getByRole("search", { name: "Find in agent chat" });
    await expect(page.locator(staticCard(n))).toHaveCount(0);
    // Opening the conversation reads no document text.
    expect(await storedTextReads()).toBe(0);
    expect((await frameStats(page)).framesMounted).toBe(0);

    await page.keyboard.press("ControlOrMeta+f");
    await input.fill(query);
    // Counted with no card ever shown, then reached like any other match.
    await expect(result).toContainText("1 of 1", { timeout: 30_000 });
    const iframe = page.locator(staticCard(n)).locator(RENDERED);
    await expect(iframe).toBeVisible({ timeout: 30_000 });
    await expect(iframe).toBeInViewport();
    const frame = (await (await iframe.elementHandle())!.contentFrame())!;
    await expect
      .poll(() =>
        frame.evaluate(() => {
          const [range] = Array.from(
            (CSS.highlights.get("ork-find-active") ?? new Highlight()).values(),
          ) as Range[];
          return range?.toString();
        }),
      )
      .toBe(query);
    await page.screenshot({
      path: `output/visual-previews/static-find-stored-text-${testInfo.project.name}.png`,
    });

    // One read per report for the whole session, however the query changes.
    const reads = await storedTextReads();
    expect(reads).toBeGreaterThan(1);
    await input.fill("Synthetic data for the performance gate.");
    await expect(result).toContainText(new RegExp(`of ${reads}\\b`));
    expect(await storedTextReads()).toBe(reads);
    const stats = await frameStats(page);
    expect(stats.framesFailed).toBe(0);
    expect(stats.mounted).toBeLessThanOrEqual(stats.granted);
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
