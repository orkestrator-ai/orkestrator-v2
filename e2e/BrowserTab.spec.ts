import { expect, test, type Locator } from "@playwright/test";

async function setPaneWidth(pane: Locator, width: number) {
  await pane.evaluate((element, nextWidth) => {
    element.style.width = `${nextWidth}px`;
  }, width);
}

async function expectNoHorizontalOverflow(locator: Locator) {
  await expect
    .poll(() => locator.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
}

test("browser toolbar follows pane container breakpoints without horizontal overflow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project provides all pane widths");
  await page.goto("/browser");

  const pane = page.getByTestId("browser-pane");
  const root = pane.locator(":scope > div");
  const address = page.getByRole("textbox", { name: "Browser address" });
  const form = address.locator("xpath=ancestor::form");
  const back = page.getByRole("button", { name: "Back" });
  const backendLabel = page.getByText("Backend", { exact: true });
  const iframe = page.getByTitle("Backend browser preview");

  await setPaneWidth(pane, 400);
  const [narrowBackBox, narrowFormBox] = await Promise.all([
    back.boundingBox(),
    form.boundingBox(),
  ]);
  expect(narrowBackBox).not.toBeNull();
  expect(narrowFormBox).not.toBeNull();
  expect(narrowFormBox!.y).toBeGreaterThanOrEqual(narrowBackBox!.y + narrowBackBox!.height);
  await expect(backendLabel).toBeHidden();
  await expectNoHorizontalOverflow(root);

  await setPaneWidth(pane, 480);
  const [mediumBackBox, mediumFormBox] = await Promise.all([
    back.boundingBox(),
    form.boundingBox(),
  ]);
  expect(mediumBackBox).not.toBeNull();
  expect(mediumFormBox).not.toBeNull();
  expect(Math.abs(mediumFormBox!.y - mediumBackBox!.y)).toBeLessThanOrEqual(1);
  await expect(backendLabel).toBeHidden();
  await expectNoHorizontalOverflow(root);

  await setPaneWidth(pane, 560);
  await expect(backendLabel).toBeVisible();
  await expect(iframe).toHaveCSS("color-scheme", "dark");
  const [rootBox, iframeBox] = await Promise.all([root.boundingBox(), iframe.boundingBox()]);
  expect(rootBox).not.toBeNull();
  expect(iframeBox).not.toBeNull();
  expect(iframeBox!.x).toBeGreaterThanOrEqual(rootBox!.x);
  expect(iframeBox!.x + iframeBox!.width).toBeLessThanOrEqual(rootBox!.x + rootBox!.width);
  await expectNoHorizontalOverflow(root);
});

test("long errors and the empty state stay contained in a narrow pane", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "covered once in the desktop layout engine");
  await page.goto("/browser");
  const pane = page.getByTestId("browser-pane");
  const root = pane.locator(":scope > div");
  await setPaneWidth(pane, 320);

  await page.evaluate(() => {
    Object.defineProperty(window, "orkestratorGateway", {
      configurable: true,
      get() {
        throw "unbroken-error-".repeat(40);
      },
    });
  });
  await page.getByRole("textbox", { name: "Browser address" }).fill("3000");
  await page.getByRole("button", { name: "Go" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expectNoHorizontalOverflow(alert);
  await expectNoHorizontalOverflow(root);

  await page.goto("/browser?empty=1");
  const emptyPane = page.getByTestId("browser-pane");
  await setPaneWidth(emptyPane, 320);
  const emptyRoot = emptyPane.locator(":scope > div");
  await expect(page.getByText("Preview a backend service")).toBeVisible();
  await expectNoHorizontalOverflow(emptyRoot);
});
