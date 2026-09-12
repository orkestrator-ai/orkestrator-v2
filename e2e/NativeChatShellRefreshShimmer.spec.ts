import { expect, test } from "@playwright/test";

test("remounting a cached transcript keeps the visible shimmer until it settles", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "desktop coverage is sufficient for remount shimmer timing",
  );
  await page.goto("/native-refresh-shimmer");

  const shell = page.getByTestId("native-refresh-shimmer-shell");
  const transcriptShimmer = shell.getByTestId("session-refresh-shimmer-transcript");
  await expect(transcriptShimmer).toHaveAttribute("data-active", "true");
  await expect(shell.getByText("Refreshing Codex session…")).toBeVisible();
  await expect(shell.getByTestId("session-refresh-shimmer-pinned")).toHaveCount(0);
  await expect(shell.getByText("Cached answer")).toBeVisible();

  await expect(transcriptShimmer).toHaveAttribute("data-active", "false", { timeout: 2_000 });
  await expect(shell.getByText("Refreshing Codex session…")).toHaveCount(0);

  await page.getByRole("button", { name: "Remount session" }).click();
  await expect(transcriptShimmer).toHaveAttribute("data-active", "true");
  await expect(shell.getByText("Refreshing Codex session…")).toBeVisible();
  await expect(shell.getByText("Cached answer")).toBeVisible();

  await expect(transcriptShimmer).toHaveAttribute("data-active", "false", { timeout: 2_000 });
  await expect(shell.getByText("Refreshing Codex session…")).toHaveCount(0);
});
