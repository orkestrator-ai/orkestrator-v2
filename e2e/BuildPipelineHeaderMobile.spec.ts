import { expect, test } from "@playwright/test";

for (const width of [320, 390]) {
  for (const phase of ["building", "resolving-conflicts", "creating-pr", "creating-environment"]) {
    test(`at ${width}px during ${phase}, the build pipeline header keeps every control inside a phone viewport`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile-chromium", "this asserts the phone layout");
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/build-pipeline-header?phase=${phase}`);

      const header = page.getByTestId("build-pipeline-header");
      const summary = page.getByTestId("build-pipeline-header-summary");
      const controls = page.getByTestId("build-pipeline-header-controls");
      const buttons = [
        ...(phase === "creating-environment"
          ? []
          : [
              phase === "building"
                ? "Restart Build Stage"
                : phase === "creating-pr"
                  ? "Restart PR Stage"
                  : "Restart Conflict Resolution",
            ]),
        "Pause",
        "Cancel",
      ].map((name) => controls.getByRole("button", { name }));
      const actions = page.getByTestId("build-pipeline-header-actions").getByRole("button");

      await expect(header).toBeVisible();
      await expect(controls).toBeVisible();
      for (const button of buttons) await expect(button).toBeVisible();
      await expect(actions).toHaveCount(phase === "creating-environment" ? 4 : 5);
      await expect(page.getByTestId("pipeline-progress")).toBeVisible();

      // One row of identical buttons, with the timer on a line of its own.
      const actionBoxes = await actions.evaluateAll((elements) =>
        elements.map((element) => {
          const { y, width, height } = element.getBoundingClientRect();
          return { y, width, height };
        }),
      );
      expect(new Set(actionBoxes.map((box) => `${box.y} ${box.width} ${box.height}`)).size).toBe(1);

      const geometry = await header.evaluate((element) => {
        if (!(element instanceof HTMLElement)) throw new Error("Missing build pipeline header");
        const summary = element.querySelector<HTMLElement>(
          "[data-testid='build-pipeline-header-summary']",
        );
        const controls = element.querySelector<HTMLElement>(
          "[data-testid='build-pipeline-header-controls']",
        );
        if (!summary || !controls) throw new Error("Missing build pipeline header regions");

        const headerBox = element.getBoundingClientRect();
        const summaryBox = summary.getBoundingClientRect();
        const controlsBox = controls.getBoundingClientRect();
        const descendantOverflow = Array.from(element.querySelectorAll("*")).map((child) => {
          const box = child.getBoundingClientRect();
          return Math.max(box.right - headerBox.right, headerBox.left - box.left);
        });

        return {
          headerWidth: headerBox.width,
          headerClientWidth: element.clientWidth,
          headerScrollWidth: element.scrollWidth,
          siblingOverlap: Math.max(0, summaryBox.right - controlsBox.left),
          worstOverflow: Math.max(0, ...descendantOverflow),
        };
      });

      expect(geometry.headerWidth).toBeLessThanOrEqual(390);
      expect(geometry.headerScrollWidth).toBeLessThanOrEqual(geometry.headerClientWidth + 1);
      expect(geometry.siblingOverlap).toBeLessThanOrEqual(1);
      expect(geometry.worstOverflow).toBeLessThanOrEqual(1);

      const headerBox = await header.boundingBox();
      const lastControlBox = await buttons.at(-1)!.boundingBox();
      if (!headerBox || !lastControlBox) throw new Error("Expected rendered header geometry");
      expect(lastControlBox.x + lastControlBox.width).toBeLessThanOrEqual(
        headerBox.x + headerBox.width,
      );
      expect(lastControlBox.y).toBeGreaterThanOrEqual(headerBox.y);
      expect(lastControlBox.y + lastControlBox.height).toBeLessThanOrEqual(
        headerBox.y + headerBox.height,
      );

      await expect(summary).toHaveCSS("min-width", "0px");
      const phaseBox = await page.getByTestId("build-pipeline-header-phase").boundingBox();
      const agentBox = await page.getByTestId("build-pipeline-header-agent").boundingBox();
      const progress = page.getByTestId("pipeline-progress");
      const progressBox = await progress.boundingBox();
      if (!phaseBox || !agentBox || !progressBox) throw new Error("Missing summary geometry");
      expect(phaseBox.y).toBe(agentBox.y);
      expect(progressBox.y).toBeGreaterThanOrEqual(agentBox.y + agentBox.height);
      expect(await progress.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      if (phase !== "building" && phase !== "creating-environment") {
        expect(
          await page
            .getByTestId("build-pipeline-header-phase")
            .evaluate((element) => element.scrollWidth > element.clientWidth),
        ).toBe(true);
      }
      await page.screenshot({
        path: `output/visual-previews/pipeline-header-fixed-${phase}-${width}.png`,
      });
    });
  }
}

test("panel close restores focus without a tooltip, and hover still works", async ({ page }) => {
  await page.goto("/build-pipeline-header");
  const trigger = page.getByRole("button", { name: "Key information", exact: true });
  for (const method of ["button", "Escape"]) {
    await trigger.click();
    const close = page.getByRole("button", { name: "Close key information" });
    await close.focus();
    if (method === "button") await close.click();
    else await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Key information" })).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.waitForTimeout(600);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  await page.mouse.move(0, 0);
  await trigger.hover();
  await expect(page.getByRole("tooltip", { name: "Key information" })).toBeVisible();
});

test("graph toggle switches its icon and tooltip with visibility", async ({ page }) => {
  await page.goto("/build-pipeline-header");
  const toggle = page.getByRole("button", { name: "Pipeline", exact: true });
  await toggle.hover();
  await expect(page.getByRole("tooltip", { name: "Hide pipeline" })).toBeVisible();
  await expect(toggle.locator(".lucide-panel-top-close")).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle.locator(".lucide-panel-top-open")).toBeVisible();
  await page.mouse.move(0, 0);
  await toggle.hover();
  await expect(page.getByRole("tooltip", { name: "Show pipeline" })).toBeVisible();
  await toggle.click();
  await expect(toggle.locator(".lucide-panel-top-close")).toBeVisible();
});

test("desktop header keeps summary and progress on one row", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await page.goto("/build-pipeline-header?phase=resolving-conflicts");
  const agent = await page.getByTestId("build-pipeline-header-agent").boundingBox();
  const progress = await page.getByTestId("pipeline-progress").boundingBox();
  if (!agent || !progress) throw new Error("Missing header geometry");
  expect(Math.abs(agent.y - progress.y)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: "output/visual-previews/pipeline-header-fixed-desktop.png" });
});
