import { expect, test } from "@playwright/test";

for (const key of ["Enter", "Escape"]) {
  test(`${key} in an annotation comment returns to the draft and the next Enter sends`, async ({
    page,
  }) => {
    await page.addInitScript(() => sessionStorage.setItem("held-send-ready", "true"));
    await page.goto("/native-held-send?annotations");
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await composer.fill("Please revise this");

    const source = page.getByText("The header needs more spacing", { exact: true });
    await expect(source).toBeVisible();
    await source.evaluate((element) => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
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
