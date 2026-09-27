import { expect, test } from "@playwright/test";
import { MULTI_REVIEW_MAX_REVIEWERS } from "@orkestrator/protocol/multi-review";

test("duplicate warning and work summary render and update in the browser", async ({ page }) => {
  await page.goto("/multi-review-launch");
  const warning = page.getByTestId("multi-review-duplicate-warning");
  const summary = page.getByTestId("multi-review-work-summary");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Reviewers 1 and 2 use the same configuration");
  await expect(summary).toContainText("2 reviewer turns");
  await page.getByRole("button", { name: "Add model" }).click();
  await expect(summary).toContainText("3 reviewer turns");
  await page.getByRole("checkbox", { name: "Auto-fix after consolidation" }).click();
  await expect(summary).toContainText("then 1 fix turn");
  await expect(page.getByRole("button", { name: "Start 3-model review" })).toBeEnabled();
});

test("maximum reviewer rows scroll while initial focus and actions remain usable", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile project only");
  await page.setViewportSize({ width: 390, height: 300 });
  await page.goto("/multi-review-launch");

  const dialog = page.getByRole("dialog", { name: "Configure Multi Review" });
  const configuration = page.getByRole("region", {
    name: "Multi Review model configuration",
  });
  const addButton = page.getByRole("button", { name: "Add model" });
  const cancelButton = page.getByRole("button", { name: "Cancel" });
  const confirmButton = page.getByRole("button", { name: "Start 2-model review" });

  await expect(dialog).toBeVisible();
  await expect(configuration).toBeVisible();
  await expect(addButton).toBeFocused();
  await expect(confirmButton).toBeInViewport();
  expect(await configuration.getAttribute("tabindex")).toBeNull();

  for (let reviewerCount = 2; reviewerCount < MULTI_REVIEW_MAX_REVIEWERS; reviewerCount += 1) {
    await addButton.click();
  }

  await expect(addButton).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Reviewer \d+ model$/ })).toHaveCount(
    MULTI_REVIEW_MAX_REVIEWERS,
  );
  await expect(cancelButton).toBeInViewport();
  await expect(
    page.getByRole("button", { name: `Start ${MULTI_REVIEW_MAX_REVIEWERS}-model review` }),
  ).toBeInViewport();

  const layout = await configuration.evaluate((element) => {
    const region = element as HTMLElement;
    const dialogElement = region.closest('[role="dialog"]') as HTMLElement;
    const footer = dialogElement.querySelector('[data-slot="dialog-footer"]') as HTMLElement;
    const dialogRect = dialogElement.getBoundingClientRect();
    const regionRect = region.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();

    return {
      clientHeight: region.clientHeight,
      scrollHeight: region.scrollHeight,
      dialogTop: dialogRect.top,
      dialogBottom: dialogRect.bottom,
      regionBottom: regionRect.bottom,
      footerTop: footerRect.top,
      footerBottom: footerRect.bottom,
    };
  });

  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.dialogTop).toBeGreaterThanOrEqual(0);
  expect(layout.dialogBottom).toBeLessThanOrEqual(300);
  expect(layout.regionBottom).toBeLessThanOrEqual(layout.footerTop);
  expect(layout.footerBottom).toBeLessThanOrEqual(300);

  const consolidationPicker = page.getByRole("button", {
    name: "Preparation & consolidation model model",
  });
  await consolidationPicker.scrollIntoViewIfNeeded();
  await expect
    .poll(() => configuration.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(consolidationPicker).toBeInViewport();
  await expect(cancelButton).toBeInViewport();
  await expect(
    page.getByRole("button", { name: `Start ${MULTI_REVIEW_MAX_REVIEWERS}-model review` }),
  ).toBeInViewport();
});

test("auto-fix supports keyboard toggling and resets the launch override on reopen", async ({
  page,
}) => {
  await page.goto("/multi-review-launch");
  const autoFix = page.getByRole("checkbox", { name: "Auto-fix after consolidation" });
  await expect(autoFix).not.toBeChecked();
  await autoFix.scrollIntoViewIfNeeded();
  await autoFix.focus();
  await expect(autoFix).toBeFocused();
  await page.keyboard.press("Space");
  await expect(autoFix).toBeChecked();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Reopen Multi Review dialog" }).click();
  await expect(autoFix).not.toBeChecked();
});

test("saved auto-fix flows through launch and opens Fix after consolidation", async ({ page }) => {
  await page.goto("/multi-review-auto-fix");

  await page.getByRole("checkbox", { name: "Auto-fix" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByRole("button", { name: "Configure Multi Review" }).click();

  await expect(page.getByRole("checkbox", { name: "Auto-fix after consolidation" })).toBeChecked();
  await page.getByRole("button", { name: "Start 2-model review" }).click();
  await page.getByRole("button", { name: "Complete consolidation" }).click();
  await expect(page.getByRole("tab", { name: "Fix" })).toBeVisible();
});
