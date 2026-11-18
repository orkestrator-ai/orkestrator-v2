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

async function expectInsetHairline(frame: Locator, color: string) {
  await expect(frame).toHaveCSS("outline-style", "solid");
  await expect(frame).toHaveCSS("outline-width", "1px");
  await expect(frame).toHaveCSS("outline-offset", "-2px");
  await expect(frame).toHaveCSS("outline-color", color);
}

for (const kind of ["manual", "service"] as const) {
  test(`${kind} address draws the frame hairline for Tab, click and forced colors`, async ({
    page,
    browserName,
  }) => {
    await page.goto(kind === "service" ? "/browser?service" : "/browser");
    const address = page.getByRole("textbox", { name: "Browser address" });
    const frame = address.locator("..");
    await expect(frame).toHaveCSS("outline-style", "none");
    const restingBorder = await frame.evaluate((el) => getComputedStyle(el).borderTopColor);

    // Step backwards from Go to reach the address via a real keyboard event.
    const go = page.getByRole("button", { name: "Go", exact: true });
    await expect(go).toBeEnabled();
    await go.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(address).toBeFocused();
    await expectInsetHairline(frame, "rgb(59, 130, 246)");
    await expect(frame).toHaveCSS("border-top-color", restingBorder);

    await page.keyboard.press("Tab");
    await expect(go).toBeFocused();
    await expect(frame).toHaveCSS("outline-style", "none");
    await address.click();
    await expect(address).toBeFocused();
    await expectInsetHairline(frame, "rgb(59, 130, 246)");
    await expect(frame).toHaveCSS("border-top-color", restingBorder);

    // WebKit does not support forced-colors emulation.
    if (browserName !== "webkit") {
      await page.emulateMedia({ forcedColors: "active" });
      const highlight = await frame.evaluate((el) => {
        const sample = el.ownerDocument.createElement("span");
        sample.style.outline = "1px solid Highlight";
        el.append(sample);
        const color = getComputedStyle(sample).outlineColor;
        sample.remove();
        return color;
      });
      await expectInsetHairline(frame, highlight);
    }
  });
}

test("invalid service address keeps the picker and address focus colors independent", async ({
  page,
}) => {
  await page.goto("/browser?service");
  const address = page.getByRole("textbox", { name: "Browser address" });
  const frame = address.locator("..");
  const picker = page.getByRole("button", { name: "Preview service web" });
  await expect(picker).toBeVisible();
  await frame.evaluate((el) => (el.style.transition = "none"));
  const restingBorder = await frame.evaluate((el) => getComputedStyle(el).borderTopColor);

  await address.fill("https://example.invalid/");
  await address.press("Enter");
  await expect(address).toHaveAttribute("aria-invalid", "true");
  await expectInsetHairline(frame, "rgb(229, 83, 75)");
  await expect(frame).not.toHaveCSS("border-top-color", restingBorder);
  const errorBorder = await frame.evaluate((el) => getComputedStyle(el).borderTopColor);

  await page.keyboard.press("Shift+Tab");
  await expect(picker).toBeFocused();
  await expectInsetHairline(picker, "rgb(59, 130, 246)");
  await expect(frame).toHaveCSS("outline-style", "none");
  await expect(frame).toHaveCSS("border-top-color", errorBorder);

  await page.keyboard.press("Tab");
  await expect(address).toBeFocused();
  await expectInsetHairline(frame, "rgb(229, 83, 75)");
  await expect(frame).toHaveCSS("border-top-color", errorBorder);

  await address.fill("/ready");
  await address.press("Enter");
  await expect(address).toHaveAttribute("aria-invalid", "false");
  await expectInsetHairline(frame, "rgb(59, 130, 246)");
  await expect(frame).toHaveCSS("border-top-color", restingBorder);
});

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
