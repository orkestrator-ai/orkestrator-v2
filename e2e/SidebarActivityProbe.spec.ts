import { expect, test } from "@playwright/test";
import { sidebarActivity } from "./agent-testing/sidebar-activity";

// The live agent-testing specs read sidebar activity through this probe. It is
// serialised into the page, so it is checked here against a real rendered row
// rather than only under the unit-test DOM.
test("the live specs' sidebar probe reads a real environment row in the browser", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "the fixture's row is in the phone drawer",
  );
  await page.goto("/environment-settings-drawer");
  await expect(page.getByRole("dialog", { name: "Projects and environments" })).toBeVisible();

  // A running local environment with no agent activity is idle.
  expect(await sidebarActivity(page, "drawer-environment")).toBe("idle");
  expect(await sidebarActivity(page, "no-such-environment")).toBe("unknown");
});
