import { expect, test } from "@playwright/test";

test("the build pipeline header keeps every control inside a phone viewport", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "this asserts the phone layout");
  await page.goto("/build-pipeline-header");

  const header = page.getByTestId("build-pipeline-header");
  const summary = page.getByTestId("build-pipeline-header-summary");
  const controls = page.getByTestId("build-pipeline-header-controls");
  const buttons = ["Retry Review", "Pause", "Cancel"].map((name) =>
    controls.getByRole("button", { name }),
  );

  await expect(header).toBeVisible();
  await expect(controls).toBeVisible();
  for (const button of buttons) await expect(button).toBeVisible();

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
});
