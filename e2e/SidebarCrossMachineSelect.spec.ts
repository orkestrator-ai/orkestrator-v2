import { expect, test, type Page } from "@playwright/test";

const row = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^${name}, on `) });

/** The Cmd/Ctrl modifier a real mouse click carries on the browser's platform. */
const toggle = { modifiers: ["ControlOrMeta" as const] };

const writes = async (page: Page) =>
  JSON.parse((await page.getByTestId("sidebar-writes").textContent()) ?? "[]") as Array<{
    args: { nodeId: string; command: string; args: { environmentId: string } };
  }>;

test.describe("multi-select across machines", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/sidebar-drag?cross-machine");
    await expect(row(page, "remote-feature")).toBeVisible();
    await expect(row(page, "spare-feature")).toBeVisible();
    await expect(row(page, "p-env-1")).toBeVisible();
  });

  test("Cmd/Ctrl-click selects rows on any machine without opening them", async ({ page }) => {
    await row(page, "remote-feature").click(toggle);
    await row(page, "p-env-1").click(toggle);
    await row(page, "spare-feature").click(toggle);

    await expect(page.getByText("3 selected")).toBeVisible();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(3);
    // Nothing opened: no other machine's row is marked as the one on show.
    await expect(
      page.locator('[data-testid="federated-environment-row"][data-selected]'),
    ).toHaveCount(0);
  });

  test("Shift-click selects the rows between, across machines", async ({ page }) => {
    await row(page, "p-env-1").click();
    await row(page, "spare-fix").click({ modifiers: ["Shift"] });

    const ids = await page
      .locator("[data-sidebar-scroll] [data-environment-selection-id]")
      .evaluateAll((rows) =>
        rows.map((element) => element.getAttribute("data-environment-selection-id")!),
      );
    const [from, to] = [
      ids.indexOf("p-env-1"),
      ids.indexOf(JSON.stringify(["bk_spare", "environment", "spare-env"])),
    ];
    const count = Math.abs(to - from) + 1;
    expect(count).toBeGreaterThan(1);
    await expect(page.getByText(`${count} selected`)).toBeVisible();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(count);
  });

  test("the same environment ID on two machines is two selections", async ({ page }) => {
    await row(page, "remote-feature").click(toggle);
    await expect(page.getByText("1 selected")).toBeVisible();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(1);
  });

  test("Stop goes to each row's own machine and skips one that is down", async ({ page }) => {
    await row(page, "remote-feature").click(toggle);
    await row(page, "spare-fix").click(toggle);
    await row(page, "down-feature").click(toggle);
    await page.getByTitle("Stop selected").click();

    await expect
      .poll(async () =>
        (await writes(page))
          // Rows also read their details from their machines.
          .filter(({ args }) => args.command === "stop_environment")
          .map(({ args }) => [args.nodeId, args.command, args.args.environmentId]),
      )
      .toEqual([
        ["bk_remote", "stop_environment", "r-env"],
        ["bk_spare", "stop_environment", "spare-env"],
      ]);
  });

  test("the delete confirmation names each machine", async ({ page }) => {
    await row(page, "p-env-1").click(toggle);
    await row(page, "remote-feature").click(toggle);
    await row(page, "down-feature").click(toggle);
    await page.getByTitle("Delete selected").click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("listitem").filter({ hasText: "remote-feature" })).toContainText(
      "on Remote",
    );
    await expect(dialog.getByRole("listitem").filter({ hasText: "down-feature" })).toContainText(
      "(unavailable, skipped)",
    );
  });
});
