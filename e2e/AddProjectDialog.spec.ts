import { expect, test, type Locator } from "@playwright/test";

async function expectContainedInDialog(element: Locator) {
  await expect(element).toBeVisible();
  await expect
    .poll(() =>
      element.evaluate((node) => {
        const dialog = node.closest('[role="dialog"]');
        if (!dialog) throw new Error("Missing add-project dialog");
        const box = node.getBoundingClientRect();
        const dialogBox = dialog.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.left >= dialogBox.left &&
          box.right <= dialogBox.right &&
          dialogBox.left >= 0 &&
          dialogBox.right <= window.innerWidth &&
          dialog.scrollWidth <= dialog.clientWidth + 1
        );
      }),
    )
    .toBe(true);
}

async function expectEllipsis(element: Locator) {
  await expectContainedInDialog(element);
  await expect
    .poll(() =>
      element.evaluate((node) => {
        if (!(node instanceof HTMLElement)) throw new Error("Expected repository text");
        const style = getComputedStyle(node);
        return {
          clipped: node.scrollWidth > node.clientWidth,
          textOverflow: style.textOverflow,
          overflowX: style.overflowX,
          whiteSpace: style.whiteSpace,
        };
      }),
    )
    .toEqual({
      clipped: true,
      textOverflow: "ellipsis",
      overflowX: "hidden",
      whiteSpace: "nowrap",
    });
}

// The configured Chromium projects run this at 390px and 1024px viewport widths
// with the real DialogContent grid and the application's Tailwind stylesheet.
test("long GitHub repository text ellipsizes inside the add-project dialog", async ({ page }) => {
  await page.goto("/add-project");
  await page.getByRole("button", { name: "From GitHub" }).click();
  await expectContainedInDialog(page.getByRole("list", { name: "organizations" }));
  await page.getByRole("button", { name: /^acme/ }).click();

  const list = page.getByRole("list", { name: "repositories" });
  const row = list.getByRole("button");
  await expectContainedInDialog(list);
  await expectContainedInDialog(row);
  const name = row.getByText(/^a_very_long_repository_name/);
  const description = row.getByText(/^A very long repository description/);
  for (const text of [name, description]) {
    await expectEllipsis(text);
    const fullText = await text.textContent();
    expect(fullText!.length).toBeGreaterThanOrEqual(100);
    await expect(text).toHaveAttribute("title", fullText!);
  }
  for (const label of ["Private", "Fork", "Archived"]) {
    await expect(row.getByLabel(label)).toBeVisible();
  }

  const fullName = `acme/${await name.textContent()}`;
  await row.click();
  await expectContainedInDialog(page.getByLabel(/Local path/));
  await expectEllipsis(
    page.locator("span").filter({ hasText: /^acme\/a_very_long_repository_name/ }),
  );
  const helper = page.locator("p").filter({ hasText: /^acme\/a_very_long_repository_name/ });
  await expectContainedInDialog(helper);
  await expect(helper).toHaveText(
    `${fullName} is cloned into this folder, then added as a project.`,
  );
  await expect
    .poll(() =>
      helper.evaluate((node) => ({
        overflowWrap: getComputedStyle(node).overflowWrap,
        contained: node.scrollWidth <= node.clientWidth + 1,
      })),
    )
    .toEqual({ overflowWrap: "anywhere", contained: true });
});
