import { expect, test } from "@playwright/test";
import { startChangeTrackingHost } from "./change-tracking-client";

test("real change commands retain history and tool evidence, replay restore, and recover missed live edits", async ({
  page,
}) => {
  const host = await startChangeTrackingHost();
  let lostApply = false;
  try {
    await page.exposeFunction(
      "changesInvoke",
      async (command: string, args: Record<string, unknown>) => {
        const result = await host.invoke(command, args);
        if (command === "changes_apply_restore" && !lostApply) {
          lostApply = true;
          throw new Error("fixture response lost");
        }
        return result;
      },
    );
    await page.goto("/change-tracking");
    await expect(
      page.getByTestId("fixture-tool-changes").getByTestId("change-count-badge"),
    ).toBeVisible();
    await expect(
      page.getByTestId("change-hunks").getByText("+FIRST", { exact: true }),
    ).toBeVisible();
    await page.getByTestId("turn-changes-toggle").click();
    const history = page.getByTestId("turn-changes-history");
    await expect(history.getByTestId("turn-changes-entry")).toHaveCount(1);
    await history.getByTestId("restore-changes-button").click();
    const dialog = page.getByTestId("restore-preview");
    await dialog.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("result is unknown");
    await dialog.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await host.invoke("fixture_content")).toBe("one\ntwo\n");
    await host.invoke("fixture_edit");
    await page.getByRole("button", { name: "Switch away" }).click();
    await host.invoke("fixture_edit", { version: "second" });
    // Both content invalidations were missed while this environment was hidden.
    await page.evaluate(() => window.changesReconnect?.());
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await expect(
      page.getByTestId("change-hunks").getByText("+SECOND", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByTestId("change-hunks").getByText("+SECOND", { exact: true }),
    ).toBeVisible();
    await page.getByTestId("turn-changes-toggle").click();
    await expect(page.getByTestId("turn-changes-entry")).toHaveCount(1);
    await expect(
      page.getByTestId("fixture-tool-changes").getByTestId("change-count-badge"),
    ).toBeVisible();
  } finally {
    await host.close();
  }
});
