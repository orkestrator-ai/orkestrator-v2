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
  await expect(broken.locator("img")).toHaveCount(0);
  const failedMedia = await broken.locator("span").first().boundingBox();
  const errorBadge = await broken.getByText("preview unavailable").boundingBox();
  const failedCaption = await broken.getByText("broken.png", { exact: true }).boundingBox();
  expect(failedMedia!.height).toBe(192);
  expect(errorBadge!.y + errorBadge!.height).toBeLessThan(failedCaption!.y);
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

test("image previews reserve loading space and restore uncropped geometry on remount", async ({
  page,
}) => {
  let releaseDetail!: () => void;
  const pendingDetail = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  let releaseImage!: () => void;
  const pendingImage = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await page.route("**/fixture-delayed-detail", async (route) => {
    await pendingDetail;
    await route.fulfill({ body: "https://attachment.example/delayed.svg" });
  });
  await page.route("https://attachment.example/delayed.svg", async (route) => {
    await pendingImage;
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="100%" height="100%" fill="blue"/></svg>',
    });
  });
  await page.goto("/native-attachments?geometry");
  const wide = page.getByRole("button", { name: "Open full image: wide.svg" });
  const tall = page.getByRole("button", { name: "Open full image: tall.svg" });
  const delayed = page.getByRole("button", { name: "Open full image: delayed.svg" });
  const wideImage = wide.locator("img");
  const tallImage = tall.locator("img");
  await expect(wideImage).toHaveAttribute("width", "1920");
  await expect(tallImage).toHaveAttribute("height", "1600");

  const wideBox = (await wideImage.boundingBox())!;
  const tallBox = (await tallImage.boundingBox())!;
  expect(wideBox.height).toBeCloseTo((wideBox.width * 1080) / 1920, 0);
  expect(tallBox.height).toBe(384);
  // The portrait's painted width is 96px inside a wider, letterboxed element.
  expect(tallBox.width).toBeGreaterThan((tallBox.height * 400) / 1600);
  await expect(wideImage).toHaveCSS("object-fit", "contain");
  await expect(tallImage).toHaveCSS("object-fit", "contain");
  await expect(wide).not.toContainText("wide.svg");
  await expect(tall).not.toContainText("tall.svg");

  const placeholderHeight = (await delayed.boundingBox())!.height;
  expect(placeholderHeight).toBeGreaterThanOrEqual(192);
  releaseDetail();
  await expect(delayed.locator("img")).toHaveCount(1);
  await expect(delayed.locator("img")).toHaveJSProperty("naturalWidth", 0);
  expect((await delayed.boundingBox())!.height).toBe(placeholderHeight);
  expect((await delayed.locator("img").boundingBox())!.height).toBe(192);
  releaseImage();
  await expect(delayed).not.toContainText("delayed.svg");
  const decodedBox = (await delayed.locator("img").boundingBox())!;
  expect(decodedBox.height).toBeCloseTo((decodedBox.width * 1080) / 1920, 0);

  // Suppress subsequent load handlers to inspect the remounted row's initial
  // geometry, before React receives another decode event.
  await page.evaluate(() =>
    document.addEventListener(
      "load",
      (event) => {
        if (event.target instanceof HTMLImageElement) event.stopImmediatePropagation();
      },
      true,
    ),
  );
  await page.getByRole("button", { name: "Switch transcript" }).click();
  await expect(page.getByText("Other environment")).toBeVisible();
  await page.getByRole("button", { name: "Switch transcript" }).click();
  await expect(wideImage).toHaveAttribute("width", "1920");
  await expect(tallImage).toHaveAttribute("height", "1600");
  expect((await wideImage.boundingBox())!.height).toBe(wideBox.height);
  expect((await tallImage.boundingBox())!.height).toBe(tallBox.height);
  await expect(wide).not.toContainText("wide.svg");
  await expect(tall).not.toContainText("tall.svg");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("snapshot explanations receive pointer hover and pinned notes survive remount", async ({
  page,
}) => {
  const reads = { late: 0, live: 0 };
  await page.route("**/fixture-snapshot-detail?*", async (route) => {
    const live = new URL(route.request().url()).searchParams.get("ref") === "snapshot-live";
    reads[live ? "live" : "late"]++;
    await route.fulfill({
      json: {
        detailRef: live ? "snapshot-live" : "snapshot-late",
        fileDataUrl: image,
        fileSnapshot: {
          status: live ? "live" : "pinned",
          capturedAt: "2026-10-21T12:05:00Z",
          fileModifiedAt: "2026-10-21T12:04:00Z",
          ...(live ? { reason: "quota" } : {}),
        },
      },
    });
  });
  await page.goto("/native-attachments?snapshots");
  for (const [label, description] of [
    [
      "Changed since",
      "The file changed after this message and before it was first shown here, so this may be a newer version than the message showed.",
    ],
    [
      "Current file",
      "This environment's saved image storage is full, so this is the file as it is now.",
    ],
  ]) {
    const badge = page.getByText(label!, { exact: true });
    await expect(badge).toHaveAttribute("title", description!);
    await badge.hover();
    expect(await badge.evaluate((element) => element.matches(":hover"))).toBe(true);
    await expect(badge).toHaveCSS("pointer-events", "auto");
  }
  await page.getByText("Changed since", { exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Image preview: late.svg" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Switch transcript" }).click();
  await expect(page.getByText("Other environment")).toBeVisible();
  await page.getByRole("button", { name: "Switch transcript" }).click();
  await expect(page.getByText("Changed since", { exact: true })).toBeVisible();
  await expect(page.getByText("Current file", { exact: true })).toBeVisible();
  expect(reads).toEqual({ late: 1, live: 2 });
});
