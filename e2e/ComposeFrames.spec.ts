import { expect, test, type Locator } from "@playwright/test";

const previewDir = "output/visual-previews";

function inputHeight(input: Locator) {
  return input.evaluate((element) => element.clientHeight);
}

test("a capped Features draft leaves the final response above the dock fade", async ({
  page,
}, testInfo) => {
  await page.goto("/features-compose");
  const scroller = page.locator("[data-virtuoso-scroller]");
  const lastResponse = page.getByText("Final response in the Features transcript.", {
    exact: true,
  });
  await expect(lastResponse).toBeInViewport();

  const input = page.getByPlaceholder("Describe the feature");
  await input.fill(Array.from({ length: 24 }, (_, index) => `Draft line ${index + 1}`).join("\n"));
  await expect.poll(() => inputHeight(input)).toBe(256);

  const dock = page.getByTestId("compose-dock");
  await expect
    .poll(async () => {
      await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight));
      const responseBox = await lastResponse.boundingBox();
      const dockBox = await dock.boundingBox();
      if (!responseBox || !dockBox) return -1;
      return dockBox.y - (responseBox.y + responseBox.height);
    })
    .toBeGreaterThanOrEqual(32);
  await expect(lastResponse).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: `${previewDir}/features-capped-after-${testInfo.project.name}.png`,
  });
});

test("terminal soft wraps grow and then scroll inside the dock at the mobile offset", async ({
  page,
}) => {
  await page.goto("/terminal-compose");
  const input = page.getByRole("textbox");
  const dock = page.locator("[data-compose-bar]");
  await expect(input).toBeFocused();
  const initialHeight = await inputHeight(input);
  await input.fill("Soft wrapped terminal input ".repeat(15));
  await expect.poll(() => inputHeight(input)).toBeGreaterThan(initialHeight);
  expect(await inputHeight(input)).toBeLessThan(256);

  await input.fill("Soft wrapped terminal input ".repeat(150));
  await expect.poll(() => inputHeight(input)).toBe(256);
  await input.evaluate((element) => (element.scrollTop = element.scrollHeight));
  await expect.poll(() => input.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(input).toHaveAttribute("rows", "1");
  await expect(dock).toHaveCSS("bottom", "56px");
});

for (const [name, route, inputSelector] of [
  ["native", "/native-compose", ".native-compose-input"],
  [
    "pipeline",
    "/pipeline-flow?scenario=building",
    'textarea[aria-label="Send a message to the agent"]',
  ],
  ["tmux", "/tmux-compose-focus", 'textarea[placeholder^="Ask Claude anything"]'],
  ["Features", "/features-compose", "textarea"],
  ["terminal", "/terminal-compose", "[data-compose-bar] textarea"],
]) {
  test(`${name} uses the shared frame and changes its border on input focus`, async ({
    page,
  }, testInfo) => {
    await page.goto(route);
    const input = page.locator(inputSelector);
    const frame = input.locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' bg-compose-surface ')][1]",
    );
    const column = frame.locator(
      "xpath=ancestor-or-self::*[contains(@class, 'w-[calc(100%_-_0.75rem)]')][1]",
    );
    await expect(input).toBeEditable();
    await input.blur();
    await expect(frame).toHaveCSS("border-radius", "12px");
    await expect(column).toHaveClass(/sm:w-\[min\(calc\(100%_-_2rem\),56rem\)\]/);
    const [unfocusedBorder, focusBorder] = await frame.evaluate((element) => {
      const reference = document.createElement("div");
      reference.hidden = true;
      reference.className = "border-border/70";
      element.append(reference);
      const unfocused = getComputedStyle(reference).borderColor;
      reference.style.borderColor = "var(--color-zinc-700)";
      const focused = getComputedStyle(reference).borderColor;
      reference.remove();
      return [unfocused, focused];
    });
    expect(focusBorder).not.toBe(unfocusedBorder);
    await expect(frame).toHaveCSS("border-color", unfocusedBorder);
    await input.focus();
    await expect(frame).toHaveCSS("border-color", focusBorder);
    if (name === "native") {
      await frame.screenshot({
        path: `${previewDir}/native-focused-after-${testInfo.project.name}.png`,
      });
    }
    await input.blur();
    await expect(frame).toHaveCSS("border-color", unfocusedBorder);
  });
}
