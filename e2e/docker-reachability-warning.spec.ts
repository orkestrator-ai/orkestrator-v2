import { expect, test } from "@playwright/test";
import { acknowledgeDockerReachabilityWarning } from "./docker-reachability-warning";

test("overlay recovery dismisses the host diagnostic and continues the pending action", async ({
  page,
}, testInfo) => {
  await acknowledgeDockerReachabilityWarning(page, testInfo);
  await page.setContent(`
    <button onclick="this.textContent='Settings opened'">Global settings</button>
    <div role="dialog" aria-label="Unrelated warning"><button>Close</button></div>
    <div role="dialog" aria-label="Docker containers can't reach Orkestrator"
      style="position:fixed;inset:0;background:white;z-index:10">
      <button aria-label="Close" onclick="this.parentElement.remove()">×</button>
      <button onclick="this.parentElement.remove()">Close</button>
    </div>
  `);
  await page.getByRole("button", { name: "Global settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings opened" })).toBeVisible();
  await expect(
    page.getByRole("dialog", {
      name: "Docker containers can't reach Orkestrator",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Unrelated warning" })).toBeVisible();
  expect(testInfo.annotations.filter((item) => item.type === "environment")).toHaveLength(1);
});
