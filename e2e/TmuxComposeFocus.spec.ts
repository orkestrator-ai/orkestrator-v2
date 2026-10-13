import { expect, test } from "@playwright/test";

for (const sendWith of ["mouse", "Enter"] as const) {
  for (const success of [true, false]) {
    test(`tmux keeps focus after ${sendWith} send ${success ? "succeeds" : "fails"}`, async ({
      page,
    }) => {
      await page.goto("/tmux-compose-focus");
      const input = page.getByPlaceholder(/Ask Claude anything/);
      await input.fill("first prompt");
      if (sendWith === "mouse") await page.getByTitle("Send (↵)").click();
      else await page.keyboard.press("Enter");
      await expect(input).toHaveAttribute("aria-busy", "true");
      await expect(input).toBeFocused();
      await expect(input).toBeEnabled();
      await page.keyboard.type("must not change draft");
      await expect(input).toHaveValue("first prompt");
      await page.evaluate((result) => window.finishTmuxSend!(result), success);
      await expect(page.getByTestId("completed-sends")).toHaveText("1");
      await expect(input).toHaveAttribute("aria-busy", "false");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(success ? "" : "first prompt");
      // Do not use fill/press on the locator: they would refocus the input and
      // conceal the regression. This typing must use the focus left by send.
      await page.keyboard.type("next prompt");
      await expect(input).toHaveValue(success ? "next prompt" : "first promptnext prompt");
      await page.reload();
      await expect(input).toBeEditable();
      await input.fill("after reload");
      await page.keyboard.press("Enter");
      await expect(input).toBeFocused();
      await page.evaluate(() => window.finishTmuxSend!(true));
      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
    });
  }
}
