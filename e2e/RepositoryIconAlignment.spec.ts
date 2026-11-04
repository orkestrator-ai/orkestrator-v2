import { expect, test, type Locator, type Page } from "@playwright/test";

const REPOSITORY_URL = "/sidebar-drag?groups=1&merged=1&repository=1&alignment=1";
const MEMBER_ICON =
  '[data-testid="project-icon"], [data-testid="machine-home-icon"], .lucide-messages-square';

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("Expected a visible element");
  return bounds;
}

const centreX = async (locator: Locator) => {
  const bounds = await box(locator);
  return bounds.x + bounds.width / 2;
};

const group = (page: Page, repository: string) =>
  page.locator(`[data-project-folder="github.com/acme/${repository}"]`);

const member = (page: Page, repository: string, name: RegExp) =>
  group(page, repository)
    .locator("[data-project-folder-content]")
    .locator("button")
    .filter({ hasText: name })
    .first();

const memberIcon = (row: Locator) => row.locator(MEMBER_ICON).first();

/** The large icon's centre, measured on the small icon in each listed row. */
async function expectCentred(page: Page, repository: string, rows: RegExp[]) {
  const large = await centreX(group(page, repository).getByTestId("command-node-home-icon"));
  for (const name of rows) {
    const small = await centreX(memberIcon(member(page, repository, name)));
    expect(Math.abs(small - large), `${name} under acme/${repository}`).toBeLessThanOrEqual(1);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto(REPOSITORY_URL);
  await expect(group(page, "source")).toBeVisible();
  await expect(group(page, "house")).toBeVisible();
});

test("a member's project image and home centre under the repository's icon", async ({ page }) => {
  // A project image under a large image, from this machine and from another.
  await expect(
    group(page, "source").getByTestId("command-node-home-icon").getByTestId("project-icon"),
  ).toBeVisible();
  await expectCentred(page, "source", [/^Self · p\s*\d*$/, /^a-machine-or-checkout/]);
  // The home, under a large home.
  await expect(group(page, "house").getByTestId("machine-home-icon")).toBeVisible();
  await expectCentred(page, "house", [/^Self$/]);
});

test("the activity ring moves neither the icon nor its label, and stays centred", async ({
  page,
}) => {
  const imageRow = member(page, "source", /^Self · p\s*\d*$/);
  const houseRow = member(page, "house", /^Self$/);
  const iconlessRow = member(page, "target", /^Self · q\s*\d*$/);
  const measure = async (row: Locator, label: string) => ({
    icon: (await box(memberIcon(row))).x,
    label: (await box(row.getByText(label, { exact: true }))).x,
  });
  const idleImage = await measure(imageRow, "Self · p");
  const idleHouse = await measure(houseRow, "Self");
  const idleIconlessLabel = (await box(iconlessRow.getByText("Self · q", { exact: true }))).x;
  await expect(iconlessRow.locator(MEMBER_ICON)).toHaveCount(0);

  for (const state of ["working", "waiting"]) {
    await page.getByRole("button", { name: `Coordinators ${state}` }).click();
    await expect(imageRow.getByTestId("coordinator-activity-icon")).toHaveAttribute(
      "data-state",
      state,
    );
    expect(await measure(imageRow, "Self · p")).toEqual(idleImage);
    expect(await measure(houseRow, "Self")).toEqual(idleHouse);
    // A member with no icon shows the coordinator's while it is active.
    expect((await box(iconlessRow.getByText("Self · q", { exact: true }))).x).toBe(
      idleIconlessLabel,
    );
    await expectCentred(page, "source", [/^Self · p\s*\d*$/]);
    await expectCentred(page, "target", [/^Self · q\s*\d*$/]);
    await expectCentred(page, "house", [/^Self$/]);
  }

  await page.getByRole("button", { name: "Coordinators idle" }).click();
  await expect(iconlessRow.locator(MEMBER_ICON)).toHaveCount(0);
  expect(await measure(imageRow, "Self · p")).toEqual(idleImage);
  expect((await box(iconlessRow.getByText("Self · q", { exact: true }))).x).toBe(idleIconlessLabel);
});

test("a member's label keeps the 8 px gap after its icon", async ({ page }) => {
  for (const [repository, name, label] of [
    ["source", /^Self · p\s*\d*$/, "Self · p"],
    ["house", /^Self$/, "Self"],
  ] as const) {
    const row = member(page, repository, name);
    const icon = await box(memberIcon(row));
    const text = await box(row.getByText(label, { exact: true }));
    expect(text.x - (icon.x + icon.width)).toBeCloseTo(8, 0);
    expect(Math.abs(icon.y + icon.height / 2 - (text.y + text.height / 2))).toBeLessThanOrEqual(1);
  }
});

test("long names and badges truncate without overflow at the minimum width", async ({ page }) => {
  await page.addStyleTag({ content: "main { width: 280px; max-width: 280px; }" });
  const main = await box(page.locator("main"));
  const longMember = group(page, "source").locator("[data-project-folder-content]");
  const rows = [
    member(page, "source", /^a-machine-or-checkout.*120|^a-machine-or-checkout.*99\+/),
    member(page, "source", /^Self · a-machine-or-checkout/),
  ];
  await expect(longMember).toBeVisible();

  for (const row of rows) {
    const text = row.locator(".truncate").first();
    const fits = await row.evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(fits).toBe(true);
    const truncated = await text.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(truncated).toBe(true);
    const rowBox = await box(row);
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(main.x + main.width);
    // Every chip sits on the label's centre line, inside the row.
    const label = await box(text);
    for (const chip of await row.locator(":scope > span.shrink-0").all()) {
      const bounds = await box(chip);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
      expect(
        Math.abs(bounds.y + bounds.height / 2 - (label.y + label.height / 2)),
      ).toBeLessThanOrEqual(1);
    }
  }
  await expect(rows[0]!.getByText("99+", { exact: true })).toBeVisible();
  await expectCentred(page, "source", [/^a-machine-or-checkout/]);
  const pageFits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(pageFits).toBe(true);
});

test("a project outside any repository group keeps its leading position", async ({ page }) => {
  const row = page.getByRole("button", { name: /^Self · solo|^solo/ }).first();
  await expect(row).toBeVisible();
  const icon = await box(row.getByTestId("project-icon"));
  const rowBox = await box(row);
  expect(icon.x - rowBox.x).toBe(8);
  const large = await centreX(group(page, "source").getByTestId("command-node-home-icon"));
  expect(large - (icon.x + icon.width / 2)).toBe(9);
});

for (const [name, url] of [
  ["project", "/sidebar-drag?groups=1&merged=1&alignment=1"],
  ["machine", "/sidebar-drag?groups=1&machines=1&alignment=1"],
] as const) {
  test(`${name} grouping keeps the icon at the row's leading edge`, async ({ page }) => {
    await page.goto(url);
    const icon = page.getByTestId("machine-home-icon").first();
    await expect(icon).toBeVisible();
    const row = icon.locator("xpath=ancestor::button[1]");
    expect((await box(icon)).x - (await box(row)).x).toBe(8);
  });
}
