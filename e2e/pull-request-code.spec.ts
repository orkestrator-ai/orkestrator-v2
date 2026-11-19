import { expect, test, type Locator } from "@playwright/test";

async function expectWithinViewport(row: Locator, container: Locator) {
  await expect
    .poll(async () => {
      const [bounds, viewport] = await Promise.all([row.boundingBox(), container.boundingBox()]);
      if (!bounds || !viewport) return false;
      return (
        bounds.y >= viewport.y - 1 && bounds.y + bounds.height <= viewport.y + viewport.height + 1
      );
    })
    .toBe(true);
}

test("reveals the selected file and outlines the focused conversation after keyboard navigation", async ({
  page,
}) => {
  await page.goto("/pull-request-code");
  const tree = page.getByRole("navigation", { name: "Changed files" });
  const list = page.getByTestId("pull-request-file-list");
  const narrow = page.viewportSize()!.width < 640;
  if (narrow) await page.getByRole("button", { name: "Show file tree" }).click();
  await expect(tree).toBeVisible();

  const treeBox = (await tree.boundingBox())!;
  const listBox = (await list.boundingBox())!;
  if (narrow) expect(treeBox.y + treeBox.height).toBeLessThanOrEqual(listBox.y + 1);
  else expect(treeBox.x + treeBox.width).toBeLessThanOrEqual(listBox.x + 1);

  await page.getByRole("button", { name: "z-review/deep", exact: true }).click();
  await tree.evaluate((node) => {
    node.scrollTop = 0;
  });
  const target = tree.getByRole("button", { name: /target\.ts/ });
  await expect(target).toHaveCount(0);

  const next = page.getByRole("button", { name: "Next unviewed" });
  await next.focus();
  await next.press("Enter");
  await expect(target).toHaveAttribute("aria-current", "true");
  await expectWithinViewport(target, tree);
  await expectWithinViewport(
    page.getByRole("button", { name: "Collapse z-review/deep/target.ts" }),
    list,
  );

  const guide = tree.getByRole("button", { name: /guide\.md/ });
  await expect(guide).not.toBeInViewport();
  await page.getByRole("button", { name: "Next unresolved conversation" }).press("Enter");
  await expect(guide).toHaveAttribute("aria-current", "true");
  await expectWithinViewport(guide, tree);
  const conversation = page.getByTestId("review-thread");
  await expect(conversation).toBeFocused();
  await expect(conversation).toBeInViewport();
  await expect(conversation).toHaveCSS("outline-style", "solid");
  await expect(conversation).toHaveCSS("outline-width", "1px");
  await expect(conversation).toHaveCSS("outline-offset", "-2px");
  await expect(conversation).toHaveCSS("outline-color", "rgb(59, 130, 246)");
  await expect(page.getByText("No textual changes.")).toBeVisible();
});

test("filtering disables forced-open directories and preserves their saved expansion", async ({
  page,
}) => {
  await page.goto("/pull-request-code");
  if (page.viewportSize()!.width < 640) {
    await page.getByRole("button", { name: "Show file tree" }).click();
  }
  const tree = page.getByRole("navigation", { name: "Changed files" });
  const directory = tree.getByRole("button", { name: /^src\/filler\b/ });
  const match = tree.getByRole("button", { name: /file-58\.ts/ });
  await directory.click();
  await expect(directory).toHaveAttribute("aria-expanded", "false");
  const search = page.getByRole("searchbox", { name: "Filter files by path" });
  await search.fill("file-58.ts");
  await expect(directory).toHaveAttribute("aria-expanded", "true");
  await expect(directory).toBeDisabled();
  await expect(match).toBeInViewport();
  await directory.evaluate((button: HTMLButtonElement) => button.click());
  await search.press("Escape");
  await expect(search).toBeFocused();
  await expect(directory).toHaveAttribute("aria-expanded", "false");
  await expect(directory).toBeEnabled();
  await expect(match).toHaveCount(0);
});
