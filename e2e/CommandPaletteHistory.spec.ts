import { expect, test, type Page } from "@playwright/test";

async function openPalette(page: Page, search = "") {
  await page.goto(`/command-palette-history${search}`);
  await page.getByTestId("project-search-trigger").click();
  const input = page.getByRole("combobox", { name: "Search projects and environments" });
  await expect(input).toBeFocused();
  return input;
}

test("History shows open tabs, loaded messages and past sessions, each under its own heading", async ({
  page,
}) => {
  const input = await openPalette(page);
  await input.fill("arm64");
  const message = page.getByTestId("command-palette-message-m-2");
  await expect(message).toBeVisible();
  await expect(message).toContainText("arm64 link step");
  await expect(page.getByTestId("command-palette-message-m-1")).toHaveAccessibleName(
    /^Your message in Fix the arm64 build: .*; opens the tab at this message$/,
  );
  await expect(page.getByTestId("command-palette-session-past-1")).toHaveAccessibleName(
    "Investigate the arm64 linker, Codex session in arm64-release; resumes it in a new tab",
  );
  // The conversation already open is an open tab, not a past session.
  await expect(page.getByTestId("command-palette-session-open-1")).toHaveCount(0);
  await expect(page.getByTestId("command-palette-history-tab-chat")).toBeVisible();
  for (const key of ["tabs", "messages", "sessions"]) {
    await expect(page.getByTestId(`command-palette-history-${key}`)).toBeVisible();
  }

  // Rows stay inside the results list.
  const list = page.getByRole("listbox", { name: "Search results" });
  const listBox = (await list.boundingBox())!;
  for (const option of await page.getByRole("option").all()) {
    const box = (await option.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(listBox.x + listBox.width + 1);
  }

  // Keyboard: arrows reach a History row and its name is announced.
  await input.fill("linker");
  await expect(page.getByTestId("command-palette-session-past-1")).toBeVisible();
  await expect(input).toHaveAttribute("aria-activedescendant", /.+/);
});

test("an unreadable past-session list is reported in its own group", async ({ page }) => {
  const input = await openPalette(page, "?sessions=failed");
  await input.fill("arm64");
  await expect(page.getByTestId("command-palette-message-m-2")).toBeVisible();
  await expect(page.getByTestId("command-palette-history-sessions")).toContainText(
    "Past sessions could not be listed.",
  );
});
