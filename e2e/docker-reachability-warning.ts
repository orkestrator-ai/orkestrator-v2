import type { Page, TestInfo } from "@playwright/test";

/** Overlay tests use docker exec even when container-to-host networking is blocked. */
export async function acknowledgeDockerReachabilityWarning(page: Page, testInfo: TestInfo) {
  await page.addLocatorHandler(
    page.getByRole("dialog", {
      name: "Docker containers can't reach Orkestrator",
      exact: true,
    }),
    async (dialog) => {
      testInfo.annotations.push({
        type: "environment",
        description:
          "Acknowledged container-to-host connectivity warning; overlays use docker exec.",
      });
      await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    },
  );
}
