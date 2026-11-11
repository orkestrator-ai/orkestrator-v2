import { expect, test, type Page } from "@playwright/test";

/**
 * The Ask agent dialog's closed design links, rendered by the real component
 * against fixed backend answers (`fixture/DesignAgentLinksFixture.tsx`):
 * a resumable conversation, one the agent archived (to-do 0038) and one that
 * never started.
 */

async function resumeRequests(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __designLinkRequests: { resume: Array<Record<string, unknown>> } })
        .__designLinkRequests.resume,
  );
}

function linkRow(page: Page, id: string) {
  return page.getByTestId(`design-link-${id}`);
}

test("an archived conversation reads as archived and offers Unarchive and resume", async ({
  page,
}) => {
  await page.goto("/design-agent-links");
  const dialog = page.getByRole("dialog", { name: "Ask agent about this design" });
  await expect(dialog).toBeVisible();

  await expect(linkRow(page, "resumable")).toContainText("Closed — can be resumed");
  await expect(linkRow(page, "archived")).toContainText("Closed — archived by the agent");
  await expect(linkRow(page, "missing")).toContainText("Closed — no conversation to resume");

  const archived = linkRow(page, "archived");
  await expect(
    archived.getByRole("button", { name: "Unarchive and resume Pricing copy" }),
  ).toBeVisible();
  await expect(archived.getByRole("button", { name: "Remove link to Pricing copy" })).toBeVisible();
  await expect(
    archived.getByRole("button", { name: "Resume Pricing copy", exact: true }),
  ).toHaveCount(0);
  // The resumable conversation, not the archived one, is the default destination.
  await expect(dialog.getByRole("button", { name: "Resume and add to composer" })).toBeVisible();

  await archived.getByRole("radio", { name: "Send to Pricing copy" }).check();
  await expect(
    dialog.getByRole("button", { name: "Unarchive, resume and add to composer" }),
  ).toBeVisible();
});

test("Unarchive and resume asks the backend to restore the conversation first", async ({
  page,
}) => {
  await page.goto("/design-agent-links");
  await page.getByRole("button", { name: "Unarchive and resume Pricing copy" }).click();
  await expect(page.getByRole("dialog", { name: "Ask agent about this design" })).toBeHidden();

  const requests = await resumeRequests(page);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    linkId: "archived",
    expectedTabId: "closed-archived",
    restoreArchived: true,
  });
});

test("a plain Resume never asks to unarchive", async ({ page }) => {
  await page.goto("/design-agent-links");
  await page.getByRole("button", { name: "Resume Hero layout", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Ask agent about this design" })).toBeHidden();

  const requests = await resumeRequests(page);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ linkId: "resumable" });
  expect(requests[0]).not.toHaveProperty("restoreArchived");
});
