import { expect, test, type Locator } from "@playwright/test";

async function selectSource(source: Locator) {
  await expect(source).toBeVisible();
  await source.evaluate((element) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function pinColors(pin: Locator) {
  return pin.evaluate((element) => {
    const style = getComputedStyle(element);
    const tailStyle = getComputedStyle(element, "::after");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    const pixel = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const primary = style.getPropertyValue("--color-primary-fill");
    const background = style.getPropertyValue("--color-background");
    return {
      fill: pixel(style.backgroundColor),
      tail: pixel(tailStyle.backgroundColor),
      ring: pixel(style.borderBottomColor),
      foreground: pixel(style.color),
      primary: pixel(primary),
      primaryForeground: pixel(style.getPropertyValue("--color-primary-foreground")),
      hover: pixel(`color-mix(in srgb, ${primary} 85%, ${background})`),
    };
  });
}

for (const key of ["Enter", "Escape"]) {
  test(`${key} in an annotation comment returns to the draft and the next Enter sends`, async ({
    page,
  }) => {
    await page.addInitScript(() => sessionStorage.setItem("held-send-ready", "true"));
    await page.goto("/native-held-send?annotations");
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await composer.fill("Please revise this");

    await selectSource(page.getByText("The header needs more spacing", { exact: true }));
    await page.getByRole("button", { name: "Add to chat", exact: true }).click();
    const comment = page.getByRole("textbox", { name: "Optional comment for annotation 1" });
    await comment.fill("Keep the wording");

    // The handoff must use the current draft, including edits made after capture.
    await composer.fill("Please revise this header");
    // Leave the caret inside the draft so merely restoring focus cannot pass.
    await composer.press("ArrowLeft");
    await comment.focus();
    await comment.press(key);

    await expect(comment).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText("Please revise this header");
    const caret = await composer.evaluate((element) => {
      const selection = window.getSelection()!;
      const range = selection.getRangeAt(0).cloneRange();
      range.selectNodeContents(element);
      range.setEnd(selection.focusNode!, selection.focusOffset);
      return { collapsed: selection.isCollapsed, offset: range.toString().length };
    });
    expect(caret).toEqual({ collapsed: true, offset: "Please revise this header".length });
    await expect(page.getByTestId("compose-annotation-count")).toContainText("1 annotation");
    expect(await page.evaluate(() => sessionStorage.getItem("held-send-count"))).toBeNull();

    // Reopening proves dismissal retained the comment as well as the reference.
    await page.getByRole("button", { name: "Edit comment for transcript reference 1" }).click();
    await expect(comment).toHaveValue("Keep the wording");
    await comment.press(key);
    await expect(composer).toBeFocused();
    expect(await page.evaluate(() => sessionStorage.getItem("held-send-count"))).toBeNull();

    await page.keyboard.press("Enter");
    await expect(composer).toBeEmpty();
    expect(await page.evaluate(() => sessionStorage.getItem("held-send-count"))).toBe("1");
    const prompt = await page.evaluate(() => sessionStorage.getItem("held-send-prompt"));
    expect(prompt).toContain("Please revise this header");
    expect(prompt).toContain('"selectedText": "The header needs more spacing"');
    expect(prompt).toContain('"userComment": "Keep the wording"');
    await expect(page.getByTestId("compose-annotation-count")).toHaveCount(0);
  });
}

test("annotation pins use the primary colors and keep an opaque tail on hover", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => sessionStorage.setItem("held-send-ready", "true"));
  await page.goto("/native-held-send?annotations");
  await selectSource(page.getByText("The header needs more spacing", { exact: true }));
  await page.getByRole("button", { name: "Add to chat", exact: true }).click();

  const editorPin = page.getByLabel("Transcript reference 1", { exact: true });
  const { primary, primaryForeground, hover } = await pinColors(editorPin);
  const ring = [255, 255, 255, 255];
  await expect
    .poll(() => pinColors(editorPin))
    .toMatchObject({
      fill: primary,
      tail: primary,
      ring,
      foreground: primaryForeground,
    });
  await page.getByRole("textbox", { name: "Optional comment for annotation 1" }).press("Escape");
  await page.mouse.move(0, 0);

  const marker = page.getByRole("button", { name: "Edit comment for transcript reference 1" });
  await expect
    .poll(() => pinColors(marker))
    .toMatchObject({
      fill: primary,
      tail: primary,
      ring,
      foreground: primaryForeground,
    });
  if (!testInfo.project.use.hasTouch) {
    await marker.hover();
    expect(hover).not.toEqual(primary);
    expect(hover[3]).toBe(255);
    await expect.poll(() => pinColors(marker)).toMatchObject({ fill: hover, tail: hover, ring });
  }
});
