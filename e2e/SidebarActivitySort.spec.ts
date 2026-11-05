import { expect, test, type Page } from "@playwright/test";

const ORDERS = {
  priority: [
    "unread",
    "waiting",
    "idle-recent",
    "idle-old",
    "working-recent",
    "working-old",
    "merged-unread",
    "merged-recent",
    "merged-working",
  ],
  newest: [
    "idle-recent",
    "unread",
    "waiting",
    "idle-old",
    "working-recent",
    "working-old",
    "merged-recent",
    "merged-unread",
    "merged-working",
  ],
  oldest: [
    "idle-old",
    "waiting",
    "unread",
    "idle-recent",
    "working-old",
    "working-recent",
    "merged-unread",
    "merged-recent",
    "merged-working",
  ],
};

/** The row names from top to bottom, as the browser laid them out. */
async function renderedOrder(page: Page, names: readonly string[]) {
  const rows = page.getByTestId("activity-environment-rows");
  const tops = await Promise.all(
    names.map(async (name) => ({
      name,
      top: (await rows.getByText(name, { exact: true }).boundingBox())!.y,
    })),
  );
  return tops.sort((left, right) => left.top - right.top).map(({ name }) => name);
}

for (const [order, expected] of Object.entries(ORDERS)) {
  test(`${order}: merged rows sit below unmerged rows, and working rows below the others`, async ({
    page,
  }) => {
    await page.goto(`/sidebar-drag?activity-sort&order=${order}`);
    await expect(
      page.getByTestId("activity-environment-rows").getByText(expected[0]!, { exact: true }),
    ).toBeVisible();
    await expect.poll(() => renderedOrder(page, expected)).toEqual(expected);
  });
}
