import { expect, test, type Page } from "@playwright/test";

/**
 * The build tab's Key information panel pops out into a tab of its own, and a
 * right-click on the header button goes straight to that tab.
 */

const expectedTarget = JSON.stringify({
  environmentId: "key-info-environment",
  pipelineId: "key-info-pipeline",
});

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.getByTestId("pipeline-key-information-tab").evaluate((element) => {
    const scroller = element.querySelector<HTMLElement>(".overflow-y-auto");
    if (!scroller) throw new Error("Missing key information scroller");
    return scroller.scrollWidth - scroller.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

test("the panel's pop-out button opens the brief as a tab", async ({ page }) => {
  await page.goto("/key-information-tab");
  const header = page.getByTestId("build-pipeline-header");
  await header.getByRole("button", { name: "Key information" }).click();
  const panel = page.getByRole("dialog", { name: "Key information" });
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "Open key information in a tab" }).click();

  await expect(panel).toBeHidden();
  await expect(page.getByTestId("opened-with")).toHaveText(expectedTarget);
  const tab = page.getByTestId("pipeline-key-information-tab");
  await expect(tab.getByRole("region", { name: "Problem" })).toBeVisible();
  await expect(tab.getByRole("region", { name: "Summary" })).toBeVisible();
  await expect(tab.getByRole("group", { name: "At a glance" })).toBeVisible();
  await expect(tab.getByRole("region", { name: "Tests" }).getByRole("row")).toHaveCount(6);
  await expectNoHorizontalOverflow(page);
});

test("right-clicking the header button goes straight to the tab", async ({ page }) => {
  await page.goto("/key-information-tab");
  await page
    .getByTestId("build-pipeline-header")
    .getByRole("button", { name: "Key information" })
    .click({ button: "right" });

  await expect(page.getByRole("dialog", { name: "Key information" })).toHaveCount(0);
  await expect(page.getByTestId("opened-with")).toHaveText(expectedTarget);
  await expect(page.getByTestId("pipeline-key-information-tab")).toBeVisible();
});

test("a summary tile jumps to its section", async ({ page }) => {
  await page.goto("/key-information-tab?view=tab");
  const tab = page.getByTestId("pipeline-key-information-tab");
  await tab
    .getByRole("group", { name: "At a glance" })
    .getByRole("button", { name: /Verification/ })
    .click();

  const verification = tab.getByRole("region", { name: "Verification" });
  await expect(verification).toBeInViewport();
  await expect(verification.getByText("Round 2: passed")).toBeVisible();
});

test("a wide pane adds the section list and puts context beside the solution", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "this asserts the wide layout");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/key-information-tab?view=tab");
  const tab = page.getByTestId("pipeline-key-information-tab");

  await expect(tab.getByRole("navigation", { name: "Key information sections" })).toBeVisible();
  const context = await tab.getByRole("region", { name: "Context" }).boundingBox();
  const solution = await tab.getByRole("region", { name: "Solution" }).boundingBox();
  if (!context || !solution) throw new Error("Expected rendered sections");
  expect(Math.abs(context.y - solution.y)).toBeLessThanOrEqual(1);
  expect(solution.x).toBeGreaterThan(context.x + context.width);
  await expectNoHorizontalOverflow(page);
});

test("the tab explains an empty brief", async ({ page }) => {
  await page.goto("/key-information-tab?view=tab&empty=1");
  await expect(page.getByText("Nothing has been recorded yet")).toBeVisible();
});

for (const state of ["loading", "error", "missing"] as const) {
  test(`hydration ${state} is visible and recoverable`, async ({ page }, testInfo) => {
    await page.goto(`/key-information-tab?view=tab&hydration=${state}`);
    const message =
      state === "error"
        ? "Could not load key information."
        : state === "missing"
          ? "This pipeline is no longer available."
          : "Loading key information…";
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await page.screenshot({
      path: `output/visual-previews/key-info-${state}-${testInfo.project.name}.png`,
    });
    if (state === "error") {
      await page.getByRole("button", { name: "Retry" }).click();
      await expect(page.getByTestId("pipeline-key-information-tab")).toBeVisible();
      await page.screenshot({
        path: `output/visual-previews/key-info-recovered-${testInfo.project.name}.png`,
      });
      await page.reload();
      await expect(page.getByRole("alert")).toHaveText(message);
    }
  });
}

test("the panel's section headings stay put and scroll the brief to a section", async ({
  page,
}, testInfo) => {
  await page.goto("/key-information-tab");
  await page
    .getByTestId("build-pipeline-header")
    .getByRole("button", { name: "Key information" })
    .click();
  const panel = page.getByRole("dialog", { name: "Key information" });
  const nav = panel.getByRole("navigation", { name: "Key information sections" });
  await expect(nav).toBeVisible();
  const scroller = panel.getByTestId("pipeline-key-information-scroller");
  const briefBox = await scroller.boundingBox();
  const navBox = await nav.boundingBox();
  if (!briefBox || !navBox) throw new Error("Missing panel layout");
  if (testInfo.project.name === "mobile-chromium") {
    expect(navBox.y + navBox.height).toBeLessThanOrEqual(briefBox.y + 1);
  } else {
    expect(navBox.x + navBox.width).toBeLessThanOrEqual(briefBox.x + 1);
  }
  await expect(page.getByTestId("pipeline-flow-scroll")).toBeVisible();
  const snapshot = () =>
    page.evaluate(() => ({
      pageX: window.scrollX,
      pageY: window.scrollY,
      ancestors: Array.from(document.querySelectorAll("*"))
        .filter(
          (element) =>
            !element.closest('[role="dialog"]') &&
            (element.scrollHeight > element.clientHeight ||
              element.scrollWidth > element.clientWidth),
        )
        .map((element) => [element.scrollLeft, element.scrollTop]),
      graphBounds: document
        .querySelector('[data-testid="pipeline-flow-scroll"]')!
        .getBoundingClientRect()
        .toJSON(),
      graphTransforms: Array.from(
        document.querySelectorAll('[data-testid="pipeline-flow-scroll"] [style]'),
      ).map((element) => element.getAttribute("style")),
    }));
  const outsideBefore = await snapshot();
  await page.screenshot({
    path: `output/visual-previews/key-nav-before-${testInfo.project.name}.png`,
  });
  const before = await nav.boundingBox();

  const verification = nav.getByRole("button", { name: "Verification" });
  await verification.click();

  const region = panel.getByRole("region", { name: "Verification" });
  await expect(region).toBeInViewport();
  await expect(verification).toHaveAttribute("aria-current", "location");
  await expect.poll(async () => (await nav.boundingBox())?.y).toBe(before?.y);
  // The list did not scroll away with the brief; a phone's row of headings
  // slides sideways to keep the current one showing.
  await expect(nav).toBeInViewport();
  await expect(verification).toBeInViewport();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await snapshot()).toEqual(outsideBefore);
  await page.screenshot({
    path: `output/visual-previews/key-nav-after-${testInfo.project.name}.png`,
  });
});

test("wide paired headings keep either selected member on a small manual scroll", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "paired layout requires a wide pane");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/key-information-tab?view=tab");
  const tab = page.getByTestId("pipeline-key-information-tab");
  const context = tab.getByRole("region", { name: "Context", exact: true });
  // Model a long context while preserving the real paired-grid layout.
  await context.evaluate((element) => {
    element.style.minHeight = "1200px";
  });
  const nav = tab.getByRole("navigation", { name: "Key information sections" });
  for (const name of ["Context", "Solution"]) {
    const button = nav.getByRole("button", { name: new RegExp(`^${name}`) });
    await button.click();
    const scroller = tab.locator(".overflow-y-auto").first();
    await scroller.evaluate((element) => element.dispatchEvent(new Event("scrollend")));
    await scroller.evaluate((element) => {
      element.scrollTop += 5;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(button).toHaveAttribute("aria-current", "location");
    await page.screenshot({
      path: `output/visual-previews/key-nav-paired-${name.toLowerCase()}.png`,
    });
  }
});
