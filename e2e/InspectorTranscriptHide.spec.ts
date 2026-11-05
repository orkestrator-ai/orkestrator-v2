import { expect, test, type Locator } from "@playwright/test";

const VIEWS = [
  {
    name: "Build Pipeline",
    url: "/pipeline-flow?scenario=building&longTranscript&paneControls",
    showPane: "Activate build pane",
    overview: "pipeline-flow-scroll",
  },
  {
    // The report is the one container query container inside a transcript's scroller.
    name: "Build Pipeline with a review report",
    url: "/pipeline-flow?scenario=fanout&longTranscript=report&paneControls",
    showPane: "Activate build pane",
    overview: "pipeline-flow-scroll",
  },
  {
    name: "Graph Run",
    url: "/graph-run-flow?longTranscript",
    showPane: "Activate graph pane",
    overview: "graph-run-overview-scroll",
  },
];

async function scrollHalfway(scroller: Locator): Promise<number> {
  const range = await scroller.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(range).toBeGreaterThan(50);
  const offset = Math.floor(range / 2);
  await scroller.evaluate((element, top) => {
    element.scrollTop = top;
  }, offset);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(offset);
  return offset;
}

// These transcripts use `activation: "latest"`, so showing the pane lands on the
// newest message in every engine, and the overview around them stays put. WebKit
// resets some hidden scrollers (0860); run this file with ORKESTRATOR_E2E_BROWSER=webkit.
for (const view of VIEWS) {
  test(`${view.name} shows the newest message when its pane returns`, async ({ page }) => {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 700 });
    await page.goto(view.url);
    const transcript = page.locator("[data-transcript-scroller]");
    const overview = page.getByTestId(view.overview);
    const hidePane = page.getByRole("button", { name: "Activate other pane" });
    const showPane = page.getByRole("button", { name: view.showPane });
    const bottomGap = () =>
      transcript.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      );
    const overviewTop = () => overview.evaluate((element) => element.scrollTop);
    await expect(transcript).toContainText("Transcript entry 40.");
    await expect.poll(bottomGap).toBeLessThanOrEqual(1);
    const mounted = await transcript.elementHandle();

    // A follower, with output arriving while hidden.
    let overviewOffset = await scrollHalfway(overview);
    await hidePane.click();
    await expect(transcript).toBeHidden();
    await page.getByRole("button", { name: "Append transcript entry" }).click();
    await showPane.click();
    await expect(transcript).toContainText("Transcript entry 41.");
    await expect.poll(bottomGap).toBeLessThanOrEqual(1);
    await expect.poll(overviewTop).toBe(overviewOffset);
    expect(await transcript.evaluate((element, original) => element === original, mounted)).toBe(
      true,
    );

    // A reader who scrolled up: the documented exception to returning to their place.
    await transcript.scrollIntoViewIfNeeded();
    await transcript.hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(bottomGap).toBeGreaterThan(100);
    overviewOffset = await scrollHalfway(overview);
    await hidePane.click();
    await expect(transcript).toBeHidden();
    await showPane.click();
    await expect.poll(bottomGap).toBeLessThanOrEqual(1);
    await expect.poll(overviewTop).toBe(overviewOffset);
  });
}
