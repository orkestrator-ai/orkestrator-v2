import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

/**
 * The ticket view's Ticket and Notes tabs in a real browser
 * (`e2e/fixture/TicketViewFixture.tsx`): the tab a ticket opens on, each
 * tab's action bar staying in view while its column scrolls, and Merge
 * enabled only for a ready pull request. Screenshots land in
 * `output/visual-previews/`.
 */

async function preview(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = path.resolve("output/visual-previews");
  await mkdir(dir, { recursive: true });
  await page.screenshot({
    path: path.join(dir, `ticket-view-${name}-${testInfo.project.name}.png`),
  });
}

test.describe("the ticket view", () => {
  test("opens on the Ticket tab, indexes its sections and keeps its bar while scrolling", async ({
    page,
  }, testInfo) => {
    await page.goto("/ticket-view?column=in-progress");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("tab", { name: "Ticket" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const bar = dialog.getByRole("toolbar", { name: "Ticket actions" });
    await expect(bar.getByRole("button", { name: "Build…" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Edit" })).toBeEnabled();
    await preview(page, testInfo, "ticket-tab");

    const index = dialog.getByRole("navigation", { name: "Ticket sections" });
    if (await index.isVisible()) {
      await index.getByRole("link", { name: "Comments and activity" }).click();
      await expect(dialog.getByRole("region", { name: "Comments and activity" })).toBeInViewport();
    } else {
      await dialog.getByTestId("ticket-view-scroll").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
    }
    await expect(bar).toBeInViewport();
    await preview(page, testInfo, "ticket-tab-scrolled");
  });

  test("a Review ticket with Notes opens on Notes, whose bar shows the PR and gates merging", async ({
    page,
  }, testInfo) => {
    await page.goto("/ticket-view?column=review");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("tab", { name: "Notes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const bar = dialog.getByRole("toolbar", { name: "Pull request actions" });
    await expect(bar.getByTestId("ticket-pr-state")).toHaveText("Checks running");
    await expect(bar.getByRole("button", { name: "Auto-merge" })).toBeEnabled();
    await preview(page, testInfo, "notes-tab-review");

    await dialog.getByTestId("ticket-notes-scroll").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(bar).toBeInViewport();
    await preview(page, testInfo, "notes-tab-scrolled");

    // Merge opens the options while checks run: merging waits, Auto-merge &
    // Cleanup is offered.
    await bar.getByRole("button", { name: "Merge", exact: true }).click();
    const options = page
      .getByRole("alertdialog", { name: "Merge Pull Request" })
      .getByRole("group", { name: "Merge options" });
    await expect(options.getByRole("button", { name: "Merge PR" })).toBeDisabled();
    await expect(options.getByRole("button", { name: "Auto-merge & Cleanup" })).toBeEnabled();
    await expect(options.getByRole("button", { name: "Resolve" })).toHaveCount(0);
    await preview(page, testInfo, "notes-tab-merge-options");
  });

  test("Merge is enabled when the pull request is ready, and opens the options before merging", async ({
    page,
  }, testInfo) => {
    await page.goto("/ticket-view?column=review&ready");
    const bar = page.getByRole("toolbar", { name: "Pull request actions" });
    await expect(bar.getByTestId("ticket-pr-state")).toHaveText("Ready to merge");
    await expect(bar.getByRole("button", { name: "Merge", exact: true })).toBeEnabled();
    await preview(page, testInfo, "notes-tab-ready");
    await bar.getByRole("button", { name: "Merge", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "Merge Pull Request" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Merge PR" })).toBeEnabled();
  });

  test("a ticket with no build has Notes disabled with the reason", async ({ page }, testInfo) => {
    await page.goto("/ticket-view?column=review&nonotes");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("tab", { name: "Notes" })).toBeDisabled();
    await expect(dialog.getByTestId("ticket-notes-unavailable")).toHaveText(
      "No build has run for this ticket yet.",
    );
    await expect(dialog.getByRole("tab", { name: "Ticket" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await preview(page, testInfo, "no-notes");
  });
});
