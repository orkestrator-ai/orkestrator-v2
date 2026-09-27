import { expect, test, type Page } from "@playwright/test";

// `window.readCoordinatorProbe` is declared by the fixture.

/**
 * Headless Chromium keeps every page `visible`, even behind another tab, so
 * the document's visibility is emulated: the property is overridden and a real
 * `visibilitychange` event is dispatched. Timers, event delivery and the
 * shared coordinator are all real.
 */
async function setVisibility(page: Page, state: "visible" | "hidden") {
  return page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => next });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => next === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    return performance.now();
  }, state);
}

const reads = (page: Page) => page.evaluate(() => window.readCoordinatorProbe?.reads ?? []);

test("hidden documents stop coordinated reads and resume reconciles critical reads first", async ({
  page,
}) => {
  await page.goto("/read-coordinator");
  await expect(page.getByTestId("session-reads")).toContainText("(current)");

  // Visible: the 500 ms critical key keeps polling on its own timer.
  await expect
    .poll(async () => (await reads(page)).filter((read) => read.name === "session").length)
    .toBeGreaterThanOrEqual(3);
  expect(
    (await reads(page)).filter((read) => read.name === "session" && read.reason === "mount"),
  ).toHaveLength(1);

  const hiddenAt = await setVisibility(page, "hidden");
  await page.waitForTimeout(2_500);
  const whileHidden = (await reads(page)).filter((read) => read.at > hiddenAt + 5);
  expect(whileHidden).toEqual([]);

  const visibleAt = await setVisibility(page, "visible");
  await expect
    .poll(async () =>
      (await reads(page)).some((read) => read.at >= visibleAt && read.name === "files"),
    )
    .toBe(true);
  const resumed = (await reads(page)).filter((read) => read.at >= visibleAt);
  expect(resumed[0]).toMatchObject({ name: "session", reason: "resume" });
  const firstFiles = resumed.find((read) => read.name === "files")!;
  expect(firstFiles.reason).toBe("resume");
  // Critical: coalescing window only (50 ms) plus scheduling slack.
  expect(resumed[0]!.at - visibleAt).toBeLessThan(400);
  // Standard: spread inside its bounded window (100–600 ms after coalescing).
  expect(firstFiles.at).toBeGreaterThan(resumed[0]!.at);
  expect(firstFiles.at - visibleAt).toBeLessThan(1_200);
});
