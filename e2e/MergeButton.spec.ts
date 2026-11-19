import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

/**
 * The action bar's single Merge PR button in a real browser
 * (`e2e/fixture/AutoMergeErrorFixture.tsx`): green when GitHub reports the PR
 * mergeable, green with a spinner while it is still checking, red for
 * conflicts, and one dialog holding merge, resolve and Auto-merge & Cleanup.
 * Screenshots land in `output/visual-previews/`.
 */

async function preview(target: Page | Locator, testInfo: TestInfo, name: string) {
  const dir = path.resolve("output/visual-previews");
  await mkdir(dir, { recursive: true });
  await target.screenshot({
    path: path.join(dir, `merge-button-${name}-${testInfo.project.name}.png`),
  });
}

function mergeButton(page: Page) {
  return page.locator("[data-mobile-toolbar]").getByRole("button", { name: "Merge PR" });
}

const STATES = [
  { mergeable: "yes", state: "mergeable" },
  { mergeable: "checking", state: "checking" },
  { mergeable: "conflicts", state: "conflicts" },
] as const;

for (const { mergeable, state } of STATES) {
  test(`one Merge PR button shows the ${state} state and opens every option`, async ({
    page,
  }, testInfo) => {
    const grid = testInfo.project.name === "mobile-chromium";
    await page.goto(
      `/auto-merge-error?message=none&autoMerge=off&mergeable=${mergeable}${grid ? "&presentation=grid" : ""}`,
    );
    const button = mergeButton(page);
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("data-mergeability", state);
    await expect(button.getByTestId("merge-pr-checking")).toHaveCount(state === "checking" ? 1 : 0);
    // Only one merge-ish control: no separate Resolve, Checking or Integrate button.
    const bar = page.locator("[data-mobile-toolbar]");
    await expect(bar.getByRole("button", { name: /^Resolve$|Checking|Integrate/ })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "Auto-merge" })).toBeVisible();
    await preview(page.locator("[data-mobile-toolbar]").first(), testInfo, `${state}-bar`);

    await button.click();
    const options = page.getByRole("group", { name: "Merge options" });
    await expect(options).toBeVisible();
    await expect(options.getByRole("button", { name: "Merge PR" })).toBeEnabled({
      enabled: state === "mergeable",
    });
    await expect(options.getByRole("button", { name: "Resolve" })).toBeEnabled({
      enabled: state !== "mergeable",
    });
    await expect(options.getByRole("button", { name: "Auto-merge & Cleanup" })).toBeEnabled();
    await preview(page, testInfo, `${state}-dialog`);
  });
}

test("focuses Cancel after a keyboard merge request into a non-target branch", async ({
  page,
}, testInfo) => {
  const presentation = testInfo.project.name === "mobile-chromium" ? "&presentation=grid" : "";
  await page.goto(`/auto-merge-error?message=none&autoMerge=off&base=release${presentation}`);
  await mergeButton(page).click();
  const options = page.getByRole("group", { name: "Merge options" });
  await options.getByRole("button", { name: "Merge PR" }).press("Enter");
  const warning = page.getByRole("alertdialog", { name: "Merge into non-target branch?" });
  await expect(warning).toContainText("pull request #7 into release");
  const cancel = warning.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await preview(page, testInfo, "review-confirmation");
  await cancel.press("Enter");
  await expect(options).toBeVisible();
});

test("describes an unknown base and withholds merge actions", async ({ page }, testInfo) => {
  await page.goto("/auto-merge-error?message=none&autoMerge=off&unknownBase");
  await mergeButton(page).click();
  const dialog = page.getByRole("alertdialog", { name: "Merge pull request" });
  await expect(dialog).toContainText("Waiting for GitHub to report the destination branch.");
  await expect(dialog.getByRole("button", { name: "Merge PR" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Auto-merge & Cleanup" })).toBeDisabled();
  await preview(page, testInfo, "review-unknown-base");
});
