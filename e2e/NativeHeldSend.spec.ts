import { expect, test } from "@playwright/test";

test("a device code survives browser-open failure, environment switching and renderer reload without another login", async ({
  page,
}) => {
  await page.goto("/native-held-send");
  await page.getByRole("button", { name: "Require sign in" }).click();
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  const code = page.getByText("SAME-CODE", { exact: true });
  const link = page.getByRole("link", { name: "Open sign-in link" });
  await expect(code).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://auth.example.test/device");
  await page.getByRole("button", { name: "Switch environment" }).click();
  await expect(code).toHaveCount(0);
  await page.getByRole("button", { name: "Return to conversation" }).click();
  await expect(code).toBeVisible();
  await page.reload();
  await expect(code).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://auth.example.test/device");
  expect(await page.evaluate(() => sessionStorage.getItem("held-sign-in-count"))).toBe("1");
  // Account status continues to report the refused API key as signed in.
  // Polling must keep the replacement cancellable and the composer locked.
  const reads = Number(await page.evaluate(() => sessionStorage.getItem("held-auth-reads")));
  await expect
    .poll(async () => Number(await page.evaluate(() => sessionStorage.getItem("held-auth-reads"))))
    .toBeGreaterThan(reads);
  await expect(code).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in to Codex before sending", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(code).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("held-sign-in-cancelled"))).toBe("true");
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  await expect(code).toBeVisible();
  await page.getByRole("button", { name: "Complete sign in" }).click();
  await expect(code).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in to Codex", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message Codex" }).fill("Recovered draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("a held send survives switching environments, dispatches once on return and stays settled after reload", async ({
  page,
}) => {
  await page.goto("/native-held-send");
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await composer.fill("Send after reconnecting");
  await composer.press("Enter");
  await expect(page.getByText(/Connecting to Codex… your message sends/)).toBeVisible();
  await page.getByRole("button", { name: "Switch environment" }).click();
  await page.getByRole("button", { name: "Release session state" }).click();
  await page.getByRole("button", { name: "Return to conversation" }).click();
  await expect(composer).toBeEmpty();
  await expect(page.getByText(/your message sends as soon as the session is ready/)).toHaveCount(0);
  await page.getByRole("button", { name: "Read dispatch count" }).click();
  await expect(page.getByRole("status", { name: "Dispatch count" })).toHaveText("1");
  await page.reload();
  await expect(composer).toBeEmpty();
  await expect(page.getByRole("status", { name: "Dispatch count" })).toHaveText("1");
});

test("a held send refused by authentication retains its text and unsent feedback across remount", async ({
  page,
}) => {
  await page.goto("/native-held-send");
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await composer.fill("Keep this draft");
  await composer.press("Enter");
  await expect(page.getByText(/Connecting to Codex… your message sends/)).toBeVisible();
  await page.getByRole("button", { name: "Require sign in" }).click();
  await expect(page.getByText("Sign in to Codex before sending. Nothing was sent.")).toBeVisible();
  await page.getByRole("button", { name: "Switch environment" }).click();
  await page.getByRole("button", { name: "Return to conversation" }).click();
  await expect(page.getByText("Sign in to Codex before sending. Nothing was sent.")).toBeVisible();
  await expect(composer).toHaveText("Keep this draft");
  await expect(page.getByText(/your message sends as soon as the session is ready/)).toHaveCount(0);
  await page.getByRole("button", { name: "Read dispatch count" }).click();
  await expect(page.getByRole("status", { name: "Dispatch count" })).toHaveText("0");
});
