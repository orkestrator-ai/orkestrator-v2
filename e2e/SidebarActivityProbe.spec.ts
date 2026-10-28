import { expect, test } from "@playwright/test";
import { sidebarActivity } from "./agent-testing/sidebar-activity";

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
