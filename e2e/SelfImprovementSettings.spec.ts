import { expect, test } from "@playwright/test";

// The progress window portals to the body. Fullscreen settings sit at z-[60], so
// a dialog left on the shadcn default z-50 would open behind it while Radix
// froze the page: the window would "do nothing" when a stage was clicked.
test("a stage opens the progress window above fullscreen settings, and it closes again", async ({
  page,
}) => {
  await page.goto("/self-improvement-settings");
  const stages = page.getByRole("list", { name: "Run stages" });
  await expect(stages).toBeVisible();
  await expect(stages.getByRole("listitem")).toHaveCount(6);
  await expect(page.getByText(/Waiting on 3 model calls/).first()).toBeVisible();

  await stages.getByRole("button", { name: /Reading conversations/ }).click();
  const dialog = page.getByRole("dialog", { name: /Run in progress/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("3,146 history files checked of 3,146")).toBeVisible();

  // Visible is not enough, and neither is a hit test: while a modal is open Radix
  // sets pointer-events: none on the body, which `elementFromPoint` (and so
  // Playwright's click check) skips, so it names a dialog painted *behind* the
  // settings panel as topmost. Both layers are children of the body, so the
  // larger z-index is the one painted on top.
  const stacking = await page.evaluate(() => {
    const zIndexOf = (element: Element | null) =>
      element && element.parentElement === document.body
        ? Number.parseInt(getComputedStyle(element).zIndex, 10)
        : Number.NaN;
    return {
      settings: zIndexOf(document.querySelector('[role="dialog"][aria-label="Fixture settings"]')),
      dialog: zIndexOf(document.querySelector('[data-slot="dialog-content"]')),
      overlay: zIndexOf(document.querySelector('[data-slot="dialog-overlay"]')),
    };
  });
  expect(stacking.settings).toBeGreaterThan(0);
  expect(stacking.dialog).toBeGreaterThan(stacking.settings);
  expect(stacking.overlay).toBeGreaterThan(stacking.settings);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(stages).toBeVisible();
});

test("a run with no sign of life and no model call is flagged as possibly stuck", async ({
  page,
}) => {
  await page.goto("/self-improvement-settings?quiet");
  await expect(
    page.getByText(/Nothing has happened for 5 min .*It may be stuck\./).first(),
  ).toBeVisible();
});

test("a backend with no progress still shows the status line", async ({ page }) => {
  await page.goto("/self-improvement-settings?old");
  await expect(page.getByRole("status").first()).toContainText("Reading conversations");
  await expect(page.getByRole("list", { name: "Run stages" })).toHaveCount(0);
});
