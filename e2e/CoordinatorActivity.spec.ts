import { expect, test, type Locator } from "@playwright/test";

/** Whether the ring's own spinner animation is running. */
const spinning = (ring: Locator) =>
  ring.evaluate((element) =>
    element.getAnimations().some((animation) => animation.playState === "running"),
  );

test("a coordinator's icons carry the environment rows' activity ring", async ({ page }) => {
  await page.goto("/coordinator-activity");
  const tab = page.getByRole("tab", { name: "Coordinator", exact: true });
  const tabRing = tab.getByTestId("coordinator-activity-icon");
  const sidebar = page.getByTestId("fixture-sidebar");
  const heading = (name: string) => sidebar.getByRole("button", { name, exact: true });

  // Working: the toolbar tab and the project heading both spin.
  await expect(tabRing).toHaveAttribute("data-state", "working");
  await expect(tabRing.getByTestId("coordinator-activity-ring")).toHaveClass(
    /environment-working-spinner/,
  );
  expect(await spinning(tabRing.getByTestId("coordinator-activity-ring"))).toBe(true);
  const working = heading("orkestrator").getByTestId("coordinator-activity-icon");
  await expect(working).toHaveAttribute("data-state", "working");
  await expect(heading("orkestrator")).toHaveAccessibleDescription(/Coordinator working/);

  // Waiting and idle around a project's own leading icon.
  await expect(heading("website").getByTestId("coordinator-activity-icon")).toHaveAttribute(
    "data-state",
    "waiting",
  );
  const idle = heading("docs").getByTestId("coordinator-activity-icon");
  await expect(idle).toHaveAttribute("data-state", "idle");
  await expect(idle.getByTestId("coordinator-activity-ring")).toBeHidden();

  // The ring never moves the icon: the tab is the same width either way.
  const workingWidth = (await tab.boundingBox())!.width;
  await page.getByRole("button", { name: "Coordinator idle" }).click();
  await expect(tabRing).toHaveAttribute("data-state", "idle");
  expect((await tab.boundingBox())!.width).toBe(workingWidth);
  // A project with no icon of its own shows the coordinator's only while active.
  await expect(heading("orkestrator").getByTestId("coordinator-activity-icon")).toHaveCount(0);

  await page.getByRole("button", { name: "Coordinator waiting" }).click();
  await expect(tabRing).toHaveAttribute("data-state", "waiting");
  await expect(heading("orkestrator")).toHaveAccessibleDescription(/Coordinator waiting for you/);
});
