import { expect, test } from "@playwright/test";

const installCommand =
  "curl -fsSL https://orkestrator.dev/install.sh | bash -s -- --tailscale-serve --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev";

test("landing loads the connection screen only after keyboard login", async ({ page }) => {
  const connectionChunks: string[] = [];
  page.on("request", (request) => {
    if (/\/PublicApp-[^/]+\.js$/.test(request.url())) connectionChunks.push(request.url());
  });
  let releaseChunk = () => {};
  const chunkGate = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });
  await page.route(/\/PublicApp-[^/]+\.js$/, async (route) => {
    await chunkGate;
    await route.continue();
  });

  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Isolation is the default/ })).toBeVisible();
    await expect(page.getByLabel("Backend address")).toHaveCount(0);
    expect(connectionChunks).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    const login = page.getByRole("link", { name: "Log in", exact: true });
    await login.focus();
    await expect(login).toBeFocused();
    await login.press("Enter");
    await expect(page).toHaveURL(/\/connect$/);
    await expect(page.locator(".public-app-loading")).toBeVisible();
    releaseChunk();
    await expect(page.getByLabel("Backend address")).toBeVisible();
    await expect(page.getByLabel("Gateway token", { exact: true })).toBeVisible();
    await expect(page).toHaveTitle("Orkestrator · Connect");
    expect(connectionChunks).toHaveLength(1);

    await page.getByRole("link", { name: "Orkestrator home" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: "Copy install command" })).toBeVisible();
    await expect(page).toHaveTitle("Orkestrator · Contained, graph-based agentic development");
  } finally {
    releaseChunk();
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const pathname of ["/connect", "/connect/"]) {
  test(`direct load and reload of ${pathname} shows the connection form`, async ({ page }) => {
    await page.goto(pathname);
    await expect(page.getByLabel("Backend address")).toBeVisible();
    await expect(page).toHaveTitle("Orkestrator · Connect");
    await page.reload();
    await expect(page.getByLabel("Backend address")).toBeVisible();
    await expect(page.getByLabel("Gateway token", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect directly" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Orkestrator home" })).toHaveAttribute("href", "/");
    await expect(page).toHaveTitle("Orkestrator · Connect");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("copies the displayed install command and resets its confirmation", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.locator(".install-command code")).toHaveText(`$ ${installCommand}`);
  await page.getByRole("button", { name: "Copy install command" }).click();
  await expect(page.getByRole("button", { name: "Install command copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(installCommand);
  await expect(page.getByRole("button", { name: "Copy install command" })).toBeVisible();
});
