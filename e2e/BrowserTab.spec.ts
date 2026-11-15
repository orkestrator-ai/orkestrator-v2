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

test("URL tab toolbar follows pane container breakpoints without horizontal overflow", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "desktop project provides all pane widths",
  );
  await page.goto("/browser");

  const pane = page.getByTestId("browser-pane");
  const root = pane.locator(":scope > div");
  const address = page.getByRole("textbox", { name: "Browser address" });
  const form = address.locator("xpath=ancestor::form");
  const annotations = page.getByRole("button", { name: /^Annotations/ });

  for (const width of [400, 480]) {
    await setPaneWidth(pane, width);
    const [buttonBox, formBox] = await Promise.all([annotations.boundingBox(), form.boundingBox()]);
    expect(buttonBox).not.toBeNull();
    expect(formBox).not.toBeNull();
    // The address keeps its own row below 672 px, as in a service tab.
    expect(formBox!.y).toBeGreaterThanOrEqual(buttonBox!.y + buttonBox!.height);
    await expectNoHorizontalOverflow(root);
  }

  await setPaneWidth(pane, 720);
  const [wideButtonBox, wideFormBox] = await Promise.all([
    annotations.boundingBox(),
    form.boundingBox(),
  ]);
  expect(wideButtonBox).not.toBeNull();
  expect(wideFormBox).not.toBeNull();
  expect(Math.abs(wideFormBox!.y - wideButtonBox!.y)).toBeLessThanOrEqual(8);
  // A saved address has no in-app view: it offers the user's browser instead.
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open in browser" })).toBeVisible();
  await expectNoHorizontalOverflow(root);
});

test("the saved-address and empty states stay contained in a narrow pane", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "covered once in the desktop layout engine",
  );
  await page.goto("/browser");
  const pane = page.getByTestId("browser-pane");
  await setPaneWidth(pane, 320);
  await expect(page.getByRole("heading", { name: "http://localhost:3000/" })).toBeVisible();
  await expectNoHorizontalOverflow(pane.locator(":scope > div"));

  await page.goto("/browser?empty=1");
  const emptyPane = page.getByTestId("browser-pane");
  await setPaneWidth(emptyPane, 320);
  await expect(page.getByText("Preview a backend service")).toBeVisible();
  await expectNoHorizontalOverflow(emptyPane.locator(":scope > div"));
});
