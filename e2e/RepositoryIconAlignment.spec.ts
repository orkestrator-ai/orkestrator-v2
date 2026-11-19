import { expect, test, type Locator, type Page } from "@playwright/test";

// The repository list's headings (design EL01) in `/sidebar-drag?alignment`:
// acme/source (this machine's p with a project image, p2 with a long name, and
// Remote's copy), acme/target (no image), and solo, a project with no
// repository and an image of its own. Remote's name is long too.
const URL = "/sidebar-drag?groups=1&merged=1&alignment=1";

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("Expected a visible element");
  return bounds;
}

const heading = (page: Page, label: string) =>
  page.getByRole("button", { name: new RegExp(`^Open ${label} on `) });

async function open(page: Page) {
  await page.goto(URL);
  await expect(heading(page, "acme/source")).toBeVisible();
  await expect(heading(page, "solo")).toBeVisible();
}

test("every heading's icon leads it in one column", async ({ page }) => {
  await open(page);
  // A project image shows in its repository's heading, from this machine.
  await expect(
    heading(page, "acme/source").getByTestId("command-node-home-icon").getByTestId("project-icon"),
  ).toBeVisible();
  // With none, the heading shows the home.
  await expect(
    heading(page, "acme/target").getByTestId("command-node-home-icon").getByTestId("project-icon"),
  ).toHaveCount(0);
  const lefts: number[] = [];
  for (const label of ["acme/source", "acme/target", "solo"]) {
    const button = heading(page, label);
    const icon = await box(button.getByTestId("command-node-home-icon"));
    expect(icon.x - (await box(button)).x, label).toBe(8);
    lefts.push(icon.x);
    // The icon spans the heading's two lines, centred on them.
    const lines = await box(button.locator("span.flex-col"));
    expect(Math.abs(icon.y + icon.height / 2 - (lines.y + lines.height / 2))).toBeLessThanOrEqual(
      1,
    );
  }
  expect(new Set(lefts).size).toBe(1);
});

test("a project with no repository is a heading of its own with its image", async ({ page }) => {
  await open(page);
  const solo = heading(page, "solo");
  await expect(solo).toHaveAccessibleName("Open solo on Self");
  await expect(solo.getByTestId("project-icon")).toBeVisible();
  await expect(solo).toContainText("1 machine · 3 environments");
  await expect(
    page.locator("[data-project-folder]").filter({ has: solo }).getByText("solo-env-1"),
  ).toBeVisible();
});

test("headings and rows fit the minimum sidebar width", async ({ page }) => {
  await open(page);
  await page.addStyleTag({ content: "main { width: 280px; max-width: 280px; }" });
  const main = await box(page.locator("main"));
  // Headings, rows, grips, menus and + buttons: every control stays in the column.
  const controls = page.locator("[data-project-folder]").getByRole("button");
  expect(await controls.count()).toBeGreaterThan(20);
  for (const control of await controls.all()) {
    if (!(await control.isVisible())) continue;
    const bounds = await box(control);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(main.x + main.width + 0.5);
  }
  const pageFits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(pageFits).toBe(true);
});
