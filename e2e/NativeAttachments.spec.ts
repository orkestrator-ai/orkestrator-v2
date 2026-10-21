import { expect, test } from "@playwright/test";

const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test("attachments retain names until decoded, wrap, and survive remount and reload", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/fixture-attachment-detail", async (route) => {
    await pending;
    await route.fulfill({ body: image });
  });
  let remoteRequests = 0;
  await page.route("https://attachment.example/remote.png", async (route) => {
    remoteRequests++;
    await route.fulfill({
      body: Buffer.from(image.split(",")[1]!, "base64"),
      contentType: "image/png",
    });
  });
  await page.goto("/native-attachments");
  const region = page.getByRole("region", { name: "Attachments" });
  const loading = region.getByRole("button", { name: "Open full image: loading.png" });
  const broken = region.getByRole("button", { name: "Open full image: broken.png" });
  const remote = region.getByRole("button", { name: "Open full image: remote.png" });
  await expect(loading).toContainText("loading.png");
  await expect(loading).toHaveAttribute("aria-busy", "true");
  await expect(broken).toContainText("broken.png");
  await expect(broken).toContainText("preview unavailable");
  await expect(remote).toContainText("remote.png");
  expect(remoteRequests).toBe(0);
  await expect(region.getByRole("button", { name: /Preview file: notes.md/ })).toBeVisible();
  await expect(region).not.toContainText("orkestrator-attachment-paths");
  await expect(region).not.toContainText("Attached files have been saved");
  await expect(region).not.toContainText("/workspace/");
  const firstBox = await loading.boundingBox();
  const secondBox = await broken.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  const flow = region.locator('[data-message-attachment-flow="true"]');
  const flowWidth = (await flow.boundingBox())!.width;
  if (firstBox!.width + secondBox!.width + 12 > flowWidth) {
    expect(secondBox!.y).toBeGreaterThan(firstBox!.y);
  } else {
    expect(secondBox!.y).toBe(firstBox!.y);
  }
  release();
  await expect(loading).not.toContainText("loading.png");
  await loading.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Image preview: loading.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await remote.click();
  await expect(page.getByRole("dialog", { name: "Image preview: remote.png" })).toBeVisible();
  expect(remoteRequests).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(remote).not.toContainText("remote.png");
  await page.getByRole("button", { name: "Switch transcript" }).click();
  await expect(page.getByText("Other environment")).toBeVisible();
  await page.getByRole("button", { name: "Switch transcript" }).click();
  await expect(loading).not.toContainText("loading.png");
  await expect(broken).toContainText("broken.png");
  await page.reload();
  await expect(loading).not.toContainText("loading.png");
  await expect(broken).toContainText("preview unavailable");
  await expect(remote).toContainText("remote.png");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
