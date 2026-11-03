import type { Page, TestInfo } from "@playwright/test";

/** Dismiss the host connectivity notice so it cannot obscure a test journey. */
export async function acknowledgeDockerReachabilityWarning(page: Page, testInfo?: TestInfo) {
  await page.addLocatorHandler(
    page.getByRole("dialog", {
      name: "Docker containers can't reach Orkestrator",
      exact: true,
    }),
    async (dialog) => {
      testInfo?.annotations.push({
        type: "environment",
        description:
          "Acknowledged container-to-host connectivity warning; overlays use docker exec.",
      });
      await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    },
  );
}
