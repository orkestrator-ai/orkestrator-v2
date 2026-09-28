import { expect, type Page, type TestInfo } from "@playwright/test";

/**
 * Loads the app and retries once only for the dev server's transient
 * "Failed to fetch dynamically imported module" on the renderer entry
 * (flake 0167, seen under Docker load). A production build serves a bundle,
 * so this cannot hide a user-facing failure; any other startup failure still
 * fails the case. The retry is recorded as an annotation.
 */
export async function loadAppWithDevRetry(
  page: Page,
  testInfo: TestInfo,
  load: () => Promise<unknown>,
): Promise<void> {
  const console: string[] = [];
  const listener = (message: { text(): string }) => {
    const text = message.text();
    if (text.includes("DesktopStartup")) console.push(text.slice(0, 500));
  };
  page.on("console", listener);
  try {
    await load();
    const failed = page.getByText("Orkestrator couldn’t connect");
    const ready = page.getByRole("button", { name: /^(Expand|Collapse) project / }).first();
    await expect(failed.or(ready).first()).toBeVisible({ timeout: 30_000 });
    if (!(await failed.isVisible())) return;
    expect(
      console.some((line) => line.includes("Failed to fetch dynamically imported module")),
      "renderer failed to start for a reason other than 0167",
    ).toBe(true);
    testInfo.annotations.push({ type: "retry", description: "flake 0167: reloaded once" });
    await page.reload({ waitUntil: "domcontentloaded" });
  } finally {
    page.off("console", listener);
  }
}
