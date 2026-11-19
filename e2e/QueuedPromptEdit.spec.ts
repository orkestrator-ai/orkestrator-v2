import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const shot = (page: Page, name: string, project: string) =>
  page.getByTestId("queued-prompt-edit-fixture").screenshot({
    path: path.resolve(`output/visual-previews/queue-edit-repaired-${name}-${project}.png`),
  });

const draft = (page: Page) => page.getByRole("textbox", { name: "Send a message" });
const order = (page: Page) => page.getByTestId("queued-order");

test("the second of three queued prompts is edited in place, keeping the draft and the order", async ({
  page,
}, testInfo) => {
  const project = testInfo.project.name;
  await page.goto("/queued-prompt-edit");
  await expect(draft(page)).toContainText("Desktop draft: refactor the auth middleware");
  await shot(page, "before", project);

  await page.getByRole("button", { name: "Edit queued prompt 2 of 3", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Queued prompt 2 text" });
  await expect(editor).toBeFocused();
  // The attachment's path block is transport, so the editor shows only the words.
  await expect(editor).toHaveValue("Match the header spacing in this screenshot");
  await expect(
    page.getByRole("button", { name: "Remove attachment header-spacing.png" }),
  ).toBeVisible();
  const held = page.locator('[data-queued-prompt-id="queued-2"]');
  await expect(held.getByTestId("compose-queue-item-edit-state")).toHaveText("Editing");
  await editor.fill("Match the header spacing and the footer padding in this screenshot");
  await shot(page, "editing", project);

  await editor.press("ControlOrMeta+Enter");
  await expect(editor).toHaveCount(0);
  await expect(order(page)).toHaveText("queued-1,queued-2,queued-3");
  await expect(page.getByTestId("queued-texts")).toContainText(
    "Match the header spacing and the footer padding in this screenshot",
  );
  await expect(draft(page)).toContainText("Desktop draft: refactor the auth middleware");
  await expect(held.getByTestId("compose-queue-item-edit-state")).toHaveCount(0);
  await shot(page, "saved", project);
});

test("cancelling with Escape leaves the prompt, the order and the draft as they were", async ({
  page,
}) => {
  await page.goto("/queued-prompt-edit");
  await page.getByRole("button", { name: "Edit queued prompt 2 of 3", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Queued prompt 2 text" });
  await editor.fill("Something else entirely");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId("queued-texts")).not.toContainText("Something else entirely");
  await expect(order(page)).toHaveText("queued-1,queued-2,queued-3");
  await expect(draft(page)).toContainText("Desktop draft");
});

test("rows held by another device or an unfinished edit say so", async ({ page }, testInfo) => {
  await page.goto("/queued-prompt-edit?elsewhere&review");
  await expect(
    page.locator('[data-queued-prompt-id="queued-3"]').getByTestId("compose-queue-item-edit-state"),
  ).toHaveText("Editing elsewhere");
  await expect(
    page.locator('[data-queued-prompt-id="queued-1"]').getByTestId("compose-queue-item-edit-state"),
  ).toHaveText("Edit unfinished");
  await expect(
    page.getByRole("button", { name: "Release queued prompt 1 of 3 unchanged" }),
  ).toBeVisible();
  await shot(page, "held-states", testInfo.project.name);
});

test("a save that finds the prompt changed elsewhere keeps the text and explains", async ({
  page,
}, testInfo) => {
  await page.goto("/queued-prompt-edit?conflict");
  await page.getByRole("button", { name: "Edit queued prompt 2 of 3", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Queued prompt 2 text" });
  await editor.fill("My version of the prompt");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  await expect(editor).toHaveValue("My version of the prompt");
  await expect(page.getByRole("button", { name: "Use mine" })).toBeVisible();
  // The edit is still this client's, so the row does not claim another device has it.
  await expect(
    page.locator('[data-queued-prompt-id="queued-2"]').getByTestId("compose-queue-item-edit-state"),
  ).toHaveText("Editing");
  await shot(page, "conflict", testInfo.project.name);
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(
    page.locator('[data-queued-prompt-id="queued-2"]').getByTestId("compose-queue-item-edit-state"),
  ).toHaveCount(0);
});

test("the release action appears when the remote lease expires without a new projection", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await page.goto("/queued-prompt-edit?expiring");
  const badge = page
    .locator('[data-queued-prompt-id="queued-3"]')
    .getByTestId("compose-queue-item-edit-state");
  const release = page.getByRole("button", { name: "Release queued prompt 3 of 3 unchanged" });
  await expect(badge).toHaveText("Editing elsewhere");
  await expect(release).toHaveCount(0);
  await page.clock.fastForward(5_000);
  await expect(badge).toHaveText("Edit unfinished");
  await expect(release).toBeVisible();
  await shot(page, "expired", testInfo.project.name);
  await release.click();
  await expect(badge).toHaveCount(0);
});

test("removing the last row keeps the unsaved editor visible", async ({ page }, testInfo) => {
  await page.goto("/queued-prompt-edit?single");
  await page.getByRole("button", { name: "Edit queued prompt 1 of 1", exact: true }).click();
  await page.getByRole("textbox", { name: "Queued prompt 1 text" }).fill("Text to keep");
  await page.getByRole("button", { name: "Remove queued prompt 1 of 1", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Queued prompt text" })).toHaveValue(
    "Text to keep",
  );
  await expect(page.getByRole("alert")).toContainText("removed from the queue");
  await shot(page, "last-row-removed", testInfo.project.name);
  await page.getByRole("button", { name: "Discard mine" }).click();
  await expect(page.getByTestId("compose-queue-strip")).toHaveCount(0);
  await expect(draft(page)).toContainText("Desktop draft");
});

test("workspace files can be added and replaced independently of the composer", async ({
  page,
}, testInfo) => {
  await page.goto("/queued-prompt-edit");
  const attach = async (filename: string) => {
    await page.getByRole("button", { name: "Attach file", exact: true }).click();
    await page.getByRole("textbox", { name: "Search workspace files" }).fill(filename);
    await page.getByRole("button", { name: new RegExp(filename, "i") }).click();
    await expect(page.getByRole("button", { name: `Remove attachment ${filename}` })).toBeVisible();
  };
  await page.getByRole("button", { name: "Edit queued prompt 1 of 3", exact: true }).click();
  await attach("details.txt");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("queued-texts")).toContainText("/workspace/docs/details.txt");

  await page.getByRole("button", { name: "Edit queued prompt 2 of 3", exact: true }).click();
  await page.getByRole("button", { name: "Remove attachment header-spacing.png" }).click();
  await attach("updated.png");
  await shot(page, "replaced-file", testInfo.project.name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("queued-texts")).toContainText("/workspace/updated.png");
  await expect(page.getByTestId("queued-texts")).not.toContainText("/header-spacing.png");
  await expect(order(page)).toHaveText("queued-1,queued-2,queued-3");
  await expect(draft(page)).toContainText("Desktop draft");
});
