import { expect, test, type Locator } from "@playwright/test";

// These are pointer states at both viewport sizes.
test.use({ hasTouch: false });

const insetHairline = /(?:inset 0px 0px 0px 1px|0px 0px 0px 1px inset)/;

function fill(row: Locator) {
  return row.evaluate((element) => getComputedStyle(element).backgroundColor);
}

function renderedFill(row: Locator) {
  return row.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    // Composite translucent utility colours over the actual surface.
    const layers: string[] = [];
    for (let layer: Element | null = element; layer; layer = layer.parentElement) {
      layers.unshift(getComputedStyle(layer).backgroundColor);
    }
    for (const color of layers) {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    }
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return { lightness: 0.2126 * red + 0.7152 * green + 0.0722 * blue, blueTint: blue - red };
  });
}

async function hoverAndSettle(row: Locator) {
  await row.hover();
  await row.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}

async function expectQuieterBlueHover(selected: Locator, neighbour: Locator) {
  const selectedFill = await fill(selected);
  const idle = await renderedFill(neighbour);
  await hoverAndSettle(neighbour);
  const hovered = await renderedFill(neighbour);
  expect(hovered.blueTint).toBeGreaterThan(idle.blueTint);
  expect(hovered.lightness).toBeLessThan((await renderedFill(selected)).lightness);
  await hoverAndSettle(selected);
  await expect(selected).toHaveCSS("background-color", selectedFill);
}

test("pinned pull request keeps its fill while the neighbouring hover is quieter", async ({
  page,
}) => {
  await page.goto("/hover-washes");
  const pinned = page.getByRole("button", { name: /Pinned pull request/ });
  const neighbour = page.getByRole("button", { name: /Neighbouring pull request/ });
  await expect(pinned).toHaveAttribute("aria-current", "true");
  await expectQuieterBlueHover(pinned, neighbour);
  await page.reload();
  await expect(pinned).toHaveAttribute("aria-current", "true");
});

test("a hovered feature is quieter than the selected feature", async ({ page }) => {
  await page.goto("/hover-washes?surface=features");
  const selected = page.getByRole("button", { name: /First feature/ });
  const neighbour = page.getByRole("button", { name: /Second feature/ });
  await selected.click();
  await page.mouse.move(1, 1);
  await expect.poll(() => fill(selected)).not.toBe("rgba(0, 0, 0, 0)");
  await expectQuieterBlueHover(selected, neighbour);
});

test("Linear card hover is quieter than selection and leaves the carried fill intact", async ({
  page,
}) => {
  await page.goto("/linear-board-drag");
  const lane = page.getByRole("region", { name: "Todo lane" });
  const selected = lane.locator('[data-issue-id="card-0"]');
  const neighbour = lane.locator('[data-issue-id="card-1"]');
  await selected.click({ modifiers: ["ControlOrMeta"] });
  await expect(selected).toHaveAttribute("data-selected", "true");
  await page.mouse.move(1, 1);
  await expectQuieterBlueHover(selected, neighbour);

  const source = (await selected.boundingBox())!;
  await page.mouse.move(source.x + 20, source.y + 12);
  await page.mouse.down();
  await page.mouse.move(source.x + 34, source.y + 12);
  await expect(page.getByTestId("linear-board-card-overlay")).toBeVisible();
  await expect(selected).toHaveCSS("border-top-style", "dashed");
  await expect(selected).toHaveCSS("opacity", "0.5");
  await page.keyboard.press("Escape");
  await page.mouse.up();
});

test("subork header and child hover remain visible on the same navy custom background", async ({
  page,
}) => {
  await page.goto("/subork-group");
  // The workspace applies the user's terminal colour to both theme tokens.
  await page.getByTestId("subork-fixture").evaluate((element) => {
    element.style.setProperty("--color-background", "#1a2438");
    element.style.setProperty("--color-card", "#1a2438");
  });
  for (const row of [
    page.getByRole("button", { name: /3 suborks/ }),
    page.getByRole("button", { name: /Council r12: Sol review/ }),
  ]) {
    await expect(row).toHaveCSS("box-shadow", "none");
    const idle = await renderedFill(row);
    await row.hover();
    await expect(row).toHaveCSS("background-color", "rgb(26, 36, 56)");
    expect(await renderedFill(row)).toEqual(idle);
    await expect(row).toHaveCSS("box-shadow", insetHairline);
  }
});

test("file selection and the folder drop target both keep their fills under the pointer", async ({
  page,
}) => {
  await page.goto("/hover-washes?surface=files");
  const selected = page.getByRole("button", { name: "notes.md" });
  const other = page.getByRole("button", { name: "readme.md" });
  const folder = page.getByRole("button", { name: "docs" });
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  const selectedFill = await fill(selected);
  await hoverAndSettle(selected);
  await expect(selected).toHaveCSS("background-color", selectedFill);
  await other.hover();
  await expect(other).toHaveCSS("background-color", "rgb(26, 36, 56)");
  await folder.hover();
  await expect(folder).toHaveCSS("background-color", "rgb(26, 36, 56)");

  const data = await page.evaluateHandle(() => new DataTransfer());
  await other.dispatchEvent("dragstart", { dataTransfer: data });
  await folder.dispatchEvent("dragover", { dataTransfer: data });
  await expect(folder).toHaveCSS("box-shadow", insetHairline);
  await expect(folder).not.toHaveCSS("background-color", "rgb(26, 36, 56)");
  await folder.dispatchEvent("drop", { dataTransfer: data });
  await other.dispatchEvent("dragend", { dataTransfer: data });
  await expect(page.getByText("readme.md → docs")).toBeVisible();
  await expect(folder).toHaveCSS("background-color", "rgb(26, 36, 56)");
});

test("the repository picker only paints enabled results on pointer hover", async ({ page }) => {
  await page.goto("/hover-washes?surface=picker");
  await page.getByRole("button", { name: /fixture/ }).click();
  const enabled = page.getByRole("button", { name: /available/ });
  const disabled = page.getByRole("button", { name: /existing/ });
  await expect(disabled).toBeDisabled();
  await enabled.hover();
  await expect(enabled).toHaveCSS("background-color", "rgb(26, 36, 56)");
  await disabled.hover();
  await expect(disabled).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.getByRole("searchbox").focus();
  await page.keyboard.press("Tab");
  await expect(enabled).toBeFocused();
});
