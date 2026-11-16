import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("Linear board renders full label overflow and safe empty/invalid states after reload", async ({
  page,
}, info) => {
  const folder = path.join(process.cwd(), "output/visual-previews");
  await mkdir(folder, { recursive: true });
  await page.goto("/linear-board-labels?before");
  await expect(page.getByTestId("linear-card-labels-more")).toHaveText("+21");
  await page.screenshot({
    path: path.join(folder, `linear-labels-before-${info.project.name}.png`),
    fullPage: true,
  });
  await page.goto("/linear-board-labels");
  const more = page.getByTestId("linear-card-labels-more");
  await expect(more).toHaveText("+26");
  await expect(more).toHaveAttribute(
    "title",
    Array.from({ length: 26 }, (_, n) => `Label ${n + 5}`).join(", "),
  );
  const labelled = page.getByTestId("linear-board-card").filter({ hasText: "Bug and frontend" });
  await expect(labelled.getByTestId("linear-card-label")).toHaveText(["Bug", "Frontend"]);
  await expect(labelled.getByTestId("linear-card-label-dot").first()).toHaveCSS(
    "background-color",
    "rgb(235, 87, 87)",
  );
  for (const title of ["No labels", "Older backend"]) {
    await expect(
      page
        .getByTestId("linear-board-card")
        .filter({ hasText: title })
        .getByTestId("linear-card-label"),
    ).toHaveCount(0);
  }
  const neutral = page
    .getByTestId("linear-board-card")
    .filter({ hasText: "Invalid colour" })
    .getByTestId("linear-card-label-dot");
  await expect(neutral).toHaveClass(/bg-muted-foreground/);
  await page.reload();
  await expect(more).toHaveText("+26");
  await page.screenshot({
    path: path.join(folder, `linear-labels-after-${info.project.name}.png`),
    fullPage: true,
  });
});
