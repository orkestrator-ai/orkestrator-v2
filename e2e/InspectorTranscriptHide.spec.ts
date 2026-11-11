import { expect, test, type Locator, type Page } from "@playwright/test";

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

/**
 * Wheel up over the transcript until the reader is clear of the end, as a
 * reader keeps scrolling.
 *
 * WebKit can swallow the first tick from the end: the list's height shrinks
 * as the wheel animation starts, the browser clamps the offset, and the clamp
 * cancels the animation, leaving the reader at the end (fanout: 4 of 4 WebKit
 * runs in the Playwright image, failing most of CI's Mobile shell (webkit)
 * runs on pull requests; the building scenario: 1 of 68). A Safari reader
 * loses that tick too, so it is a product defect, not test timing. It is
 * tracked in to-do 7766
 * (docs/todo/transcripts-and-observation/7766-webkit-first-wheel-tick-swallowed-at-end.md),
 * which also records why the retry covers every view: a single-tick
 * assertion on the views that usually keep it would fail CI intermittently.
 * When 7766 is fixed, replace the retry with one tick and assert it.
 */
async function wheelUpFromEnd(page: Page, bottomGap: () => Promise<number>): Promise<void> {
  await expect(async () => {
    await page.mouse.wheel(0, -600);
    await expect.poll(bottomGap, { timeout: 1_000 }).toBeGreaterThan(100);
  }).toPass({ timeout: 10_000 });
}

/**
 * The reader's settled offset: unchanged for `frames` consecutive animation
 * frames. WebKit animates a wheel scroll, and Virtuoso then corrects for rows
 * that measured shorter than estimated, so the offset can still be moving
 * after the gap first passes a threshold (6380).
 */
async function settledOffset(scroller: Locator, frames = 5): Promise<number> {
  const settled = await scroller.evaluate(async (element, required) => {
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let last = element.scrollTop;
    let unchanged = 0;
    const started = performance.now();
    while (performance.now() - started < 3000) {
      await nextFrame();
      const top = element.scrollTop;
      unchanged = top === last ? unchanged + 1 : 0;
      last = top;
      if (unchanged >= required) return top;
    }
    return null;
  }, frames);
  expect(settled, "the transcript's offset never held still").not.toBeNull();
  return settled!;
}

async function expectStableEnd(transcript: Locator, overview: Locator, overviewOffset: number) {
  // Wait for activation to reach latest, then observe every frame for 750 ms.
  // A single successful poll can miss a later resize or footer layout shift.
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  const samples = await transcript.evaluate(
    async (element, { overviewElement, expectedOverview }) => {
      const samples: { bottomGap: number; overviewTop: number }[] = [];
      const started = performance.now();
      do {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const sample = {
          bottomGap: element.scrollHeight - element.clientHeight - element.scrollTop,
          overviewTop: overviewElement!.scrollTop,
        };
        samples.push(sample);
        if (sample.bottomGap > 1 || sample.overviewTop !== expectedOverview) break;
      } while (performance.now() - started < 750);
      return samples;
    },
    { overviewElement: await overview.elementHandle(), expectedOverview: overviewOffset },
  );
  expect(samples.length).toBeGreaterThan(1);
  for (const sample of samples) {
    expect(sample.bottomGap).toBeLessThanOrEqual(1);
    expect(sample.overviewTop).toBe(overviewOffset);
  }
}

// These transcripts use `activation: "latest"`, so showing the pane lands on the
// newest message in every engine, and the overview around them stays put. WebKit
// resets some hidden scrollers (0860); CI runs this in Chromium and WebKit.
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
    await expectStableEnd(transcript, overview, overviewOffset);
    expect(await transcript.evaluate((element, original) => element === original, mounted)).toBe(
      true,
    );

    // A reader who scrolled up: the documented exception to returning to their place.
    await transcript.scrollIntoViewIfNeeded();
    await transcript.hover();
    await wheelUpFromEnd(page, bottomGap);
    overviewOffset = await scrollHalfway(overview);
    // Record where the reader settled, not where the wheel's movement was.
    const readerOffset = await settledOffset(transcript);
    expect(readerOffset).toBeGreaterThan(100);
    await hidePane.click();
    await expect(transcript).toBeHidden();

    // Arm before the click, ahead of activation's animation-frame callbacks.
    // Sampling after click() returns would miss a reset followed by a jump to latest.
    const firstVisibleFrame = await transcript.evaluateHandle((element) => {
      const result = { top: null as number | null };
      const sample = () => {
        if (element.getClientRects().length > 0) result.top = element.scrollTop;
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return result;
    });
    await showPane.click();
    await expect.poll(() => firstVisibleFrame.evaluate((result) => result.top)).not.toBeNull();
    expect(await firstVisibleFrame.evaluate((result) => result.top)).toBe(readerOffset);
    await firstVisibleFrame.dispose();
    await expectStableEnd(transcript, overview, overviewOffset);
  });
}

// Another node in the same inspector (the Ticket) only hides the stage's
// transcript; `latest` is for returning to the pane, so coming back to the
// stage keeps a reader's place (transcript-scroll.md, "Activation and persistence").
for (const view of VIEWS.filter((candidate) => candidate.url.startsWith("/pipeline-flow"))) {
  test(`${view.name} keeps a reader's place across another node`, async ({ page }) => {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 700 });
    await page.goto(view.url);
    const transcript = page.locator("[data-transcript-scroller]");
    const graph = page.getByRole("tablist", { name: "Build pipeline" });
    const stage = graph.getByRole("tab", { selected: true });
    const ticket = graph.getByRole("tab", { name: /^Ticket,/ });
    const bottomGap = () =>
      transcript.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      );
    await expect(transcript).toContainText("Transcript entry 40.");
    await expect.poll(bottomGap).toBeLessThanOrEqual(1);
    // The accessible name ends in a running time, so match its title only.
    const stageTitle = (await stage.getAttribute("aria-label"))?.split(",")[0];
    expect(stageTitle).toBeTruthy();
    const stageTab = graph.getByRole("tab", { name: new RegExp(`^${stageTitle},`) });

    await transcript.scrollIntoViewIfNeeded();
    await transcript.hover();
    await wheelUpFromEnd(page, bottomGap);
    const readerOffset = await settledOffset(transcript);

    await ticket.click();
    await expect(page.getByTestId("pipeline-ticket")).toBeVisible();
    await expect(transcript).toBeHidden();
    const firstVisibleFrame = await transcript.evaluateHandle((element) => {
      const result = { top: null as number | null };
      const sample = () => {
        if (element.getClientRects().length > 0) result.top = element.scrollTop;
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return result;
    });
    await stageTab.click();
    await expect.poll(() => firstVisibleFrame.evaluate((result) => result.top)).not.toBeNull();
    expect(await firstVisibleFrame.evaluate((result) => result.top)).toBe(readerOffset);
    await firstVisibleFrame.dispose();
    // Long enough for an activation's frame to have moved it to the end.
    expect(await settledOffset(transcript, 10)).toBe(readerOffset);
    await expect(
      page.getByRole("button", { name: "Scroll to bottom of transcript" }),
    ).toBeVisible();
  });
}

// One transcript list serves every stage, so a return to a *different* stage is
// not a return to the reader's place: it opens that stage at its newest message.
test("Build Pipeline opens another stage at its newest message after the Ticket", async ({
  page,
}) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 700 });
  await page.goto("/pipeline-flow?scenario=fanout&longTranscript=stages&paneControls");
  const transcript = page.locator("[data-transcript-scroller]");
  const graph = page.getByRole("tablist", { name: "Build pipeline" });
  const bottomGap = () =>
    transcript.evaluate(
      (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
    );
  await expect(transcript.locator('[data-chat-message-key="rev-1-40"]')).toBeVisible();
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);

  await transcript.scrollIntoViewIfNeeded();
  await transcript.hover();
  await wheelUpFromEnd(page, bottomGap);
  await settledOffset(transcript);

  await graph.getByRole("tab", { name: /^Ticket,/ }).click();
  await expect(page.getByTestId("pipeline-ticket")).toBeVisible();
  await expect(transcript).toBeHidden();
  await graph.getByRole("tab", { name: /^Build,/ }).click();
  await expect(transcript.locator('[data-chat-message-key="build-40"]')).toBeVisible();
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  // Held there, rather than settling back to the previous stage's offset.
  await settledOffset(transcript, 10);
  expect(await bottomGap()).toBeLessThanOrEqual(1);
});

// A node whose remembered inspector view is Tests hides the transcript in the
// same render that hands it that node's session. The stage the reader left is
// still the one they were reading, so showing the node's transcript opens it at
// its newest message rather than at the previous stage's offset.
test("Build Pipeline opens a stage whose Tests view was showing at its newest message", async ({
  page,
}) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 700 });
  await page.goto("/pipeline-flow?scenario=validation&longTranscript=stages&paneControls");
  const transcript = page.locator("[data-transcript-scroller]");
  const graph = page.getByRole("tablist", { name: "Build pipeline" });
  const views = page.getByRole("tablist", { name: "Inspector views" });
  const bottomGap = () =>
    transcript.evaluate(
      (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
    );
  // Prepare is selected; leave it on its Tests view.
  await expect(graph.getByRole("tab", { name: /^Prepare,/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await views.getByRole("tab", { name: "Tests", exact: true }).click();
  await expect(transcript).toBeHidden();

  await graph.getByRole("tab", { name: /^Build,/ }).click();
  await expect(transcript.locator('[data-chat-message-key="build-40"]')).toBeVisible();
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  await transcript.scrollIntoViewIfNeeded();
  await transcript.hover();
  await wheelUpFromEnd(page, bottomGap);
  await settledOffset(transcript);

  await graph.getByRole("tab", { name: /^Prepare,/ }).click();
  await expect(views.getByRole("tab", { name: "Tests", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(transcript).toBeHidden();
  await views.getByRole("tab", { name: "Transcript", exact: true }).click();
  await expect(transcript.locator('[data-chat-message-key="prep-40"]')).toBeVisible();
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  // Held there, rather than settling back to Build's offset.
  await settledOffset(transcript, 10);
  expect(await bottomGap()).toBeLessThanOrEqual(1);
});
