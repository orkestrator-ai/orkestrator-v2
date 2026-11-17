import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("Linear board cards show the assignee's avatar, initials when there is no image", async ({
  page,
}, info) => {
  const folder = path.join(process.cwd(), "output/visual-previews");
  await mkdir(folder, { recursive: true });
  await page.goto("/linear-board-assignees");
  const card = (title: string) => page.getByTestId("linear-board-card").filter({ hasText: title });
  const avatar = (title: string) => card(title).getByTestId("linear-assignee-avatar");

  const pictured = avatar("Book calls");
  await expect(pictured).toHaveAttribute("alt", "Assigned to Arkaydeus");
  await expect
    .poll(() => pictured.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(card("Book calls")).not.toContainText("Arkaydeus");

  await expect(avatar("Conduct D&D")).toHaveText("GH");
  await expect(avatar("Conduct D&D")).toHaveCSS("background-color", "rgb(94, 106, 210)");
  // The image fails to load, so the initials take its place.
  await expect(avatar("Broken avatar image")).toHaveText("AL");
  await expect(avatar("Broken avatar image")).toHaveCSS("background-color", "rgb(235, 87, 87)");
  await expect(avatar("Older backend")).toHaveText("L");
  await expect(avatar("Unassigned issue")).toHaveCount(0);

  // The avatar sits in the card's top-right corner, beside the identifier.
  const cardBox = (await card("Book calls").boundingBox())!;
  const avatarBox = (await pictured.boundingBox())!;
  expect(avatarBox.x + avatarBox.width).toBeGreaterThan(cardBox.x + cardBox.width - 24);
  expect(avatarBox.y).toBeLessThan(cardBox.y + 24);

  await page.screenshot({
    path: path.join(folder, `linear-assignees-after-${info.project.name}.png`),
    fullPage: true,
  });
});
