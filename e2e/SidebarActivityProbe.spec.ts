import { expect, test } from "@playwright/test";
import { sidebarActivity } from "./agent-testing/sidebar-activity";

test("Copy Environment ID writes the selected row's ID to the browser clipboard and shows a toast", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Clipboard permissions require Chromium");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/sidebar-activity-probe");
  const sidebar = page.getByRole("complementary", { name: "Projects and environments" });

  // Neither clipboard.writeText nor the toast is mocked: exercise the real
  // responsive menu, native browser clipboard and production Toaster together.
  for (const [name, id] of [
    ["probe-environment", "sidebar-probe"],
    ["probe-neighbour", "sidebar-probe-neighbour"],
  ]) {
    const row = sidebar.getByText(name, { exact: true });
    if (page.viewportSize()!.width < 768) {
      await sidebar
        .locator(".group")
        .filter({ has: page.getByText(name, { exact: true }) })
        .getByRole("button", { name: "Environment actions" })
        .click();
    } else {
      await row.click({ button: "right" });
    }
    await page.getByRole("menuitem", { name: "Copy Environment ID", exact: true }).click();
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: id });
    await expect(toast.getByText("Copied environment ID", { exact: true })).toBeVisible();
    await expect(toast.getByText(id, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
    await toast.click();
    await expect(toast).toBeHidden();
  }
});

// The live agent-testing specs read sidebar activity through this probe. It is
// serialised into the page. Exercise the responsive row in both viewport
// projects, including store-driven activity changes and a markerless row.
test("the live specs' sidebar probe reads a real environment row in the browser", async ({
  page,
}) => {
  await page.goto("/sidebar-activity-probe");
  const sidebar = page.getByRole("complementary", { name: "Projects and environments" });
  await expect(sidebar.getByTestId("environment-status-marker")).toHaveCount(2);
  await expect(sidebar.getByText("probe-environment", { exact: true })).toBeVisible();

  await expect.poll(() => sidebarActivity(page, "probe-environment")).toBe("idle");
  for (const state of ["working", "waiting", "idle", "stopped", "stopping", "working", "idle"]) {
    await page.getByRole("button", { name: `Set ${state}`, exact: true }).click();
    await expect
      .poll(() => sidebarActivity(page, "probe-environment"))
      .toBe(state === "stopping" ? "unknown" : state);
    expect(await sidebarActivity(page, "probe-neighbour")).toBe("working");
  }
  expect(await sidebarActivity(page, "no-such-environment")).toBe("unknown");
});
