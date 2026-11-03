import type { Page } from "@playwright/test";

/**
 * Close the "Docker containers can't reach Orkestrator" dialog whenever it
 * appears. It is host-specific (a firewall dropping Docker's connection to the
 * agent tools port), can open after login on top of any surface, and is modal,
 * so a local-worktree journey that leaves it up finds nothing else on the page.
 */
export async function closeDockerReachabilityNotice(page: Page): Promise<void> {
  const notice = page.getByRole("dialog", {
    name: "Docker containers can't reach Orkestrator",
    exact: true,
  });
  await page.addLocatorHandler(notice, async () => {
    await notice.getByRole("button", { name: "Close", exact: true }).last().click();
  });
}
