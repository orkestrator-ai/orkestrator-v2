# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: AgentLaunchDialog.spec.ts >> selects a native branch suggestion with the keyboard and confirms
- Location: e2e/AgentLaunchDialog.spec.ts:18:1

# Error details

```
Error: expect(locator).toHaveValue(expected) failed

Locator:  getByLabel('Target branch')
Expected: "release/2.0"
Received: "rel"
Timeout:  5000ms

Call log:
  - Expect "toHaveValue" getByLabel('Target branch') with timeout 5000ms
  - waiting for getByLabel('Target branch')
    14 × locator resolved to <input value="rel" data-slot="input" spellcheck="false" autocomplete="off" placeholder="main" aria-invalid="false" autocapitalize="none" id="create-pr-model-target-branch" list="create-pr-model-target-branches" class="file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-border/70 bg-input-surface h-9 w-full min-w-0 rounded-md border px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:bo…/>
       - unexpected value "rel"

```

```yaml
- combobox "Target branch": rel
```

# Test source

```ts
  1  | import { expect, test } from "@playwright/test";
  2  |
  3  | // Use the full Chrome browser: bundled Chromium does not expose the native
  4  | // datalist popup through automation on macOS. Install with `bunx playwright install chrome`.
  5  | // Do not pass a Chrome channel to an alternate engine, even for skipped tests.
  6  | test.use({
  7  |   channel:
  8  |     process.env.ORKESTRATOR_E2E_BROWSER && process.env.ORKESTRATOR_E2E_BROWSER !== "chromium"
  9  |       ? undefined
  10 |       : "chrome",
  11 |   headless: false,
  12 | });
  13 | test.skip(
  14 |   ({ browserName }) => browserName !== "chromium",
  15 |   "Requires Chrome's native datalist and CDP",
  16 | );
  17 |
  18 | test("selects a native branch suggestion with the keyboard and confirms", async ({ page }) => {
  19 |   await page.goto("/agent-launch");
  20 |   const dialog = page.getByRole("dialog", { name: "Configure pull request" });
  21 |   const branch = page.getByLabel("Target branch");
  22 |   await expect(dialog).toBeVisible();
  23 |   await expect(branch).toHaveValue("main");
  24 |   await expect(branch).toHaveAttribute("list", "create-pr-model-target-branches");
  25 |   expect(
  26 |     await page
  27 |       .locator("datalist option")
  28 |       .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
  29 |   ).toEqual(["main", "release/2.0", "develop"]);
  30 |   await branch.click();
  31 |   await branch.press("ControlOrMeta+A");
  32 |   await branch.press("Backspace");
  33 |   await branch.pressSequentially("rel", { delay: 100 });
  34 |   // The browser-owned popup has no DOM locator to await.
  35 |   await page.waitForTimeout(500);
  36 |   const cdp = await page.context().newCDPSession(page);
  37 |   // Playwright's macOS editing commands target the text editor. Native key codes
  38 |   // without those commands let Chrome's own datalist popup handle navigation.
  39 |   for (const [key, windowsVirtualKeyCode, nativeVirtualKeyCode] of [
  40 |     ["ArrowDown", 40, 125],
  41 |     ["Enter", 13, 36],
  42 |   ] as const) {
  43 |     await cdp.send("Input.dispatchKeyEvent", {
  44 |       type: "rawKeyDown",
  45 |       key,
  46 |       code: key,
  47 |       windowsVirtualKeyCode,
  48 |       ...(process.platform === "darwin" ? { nativeVirtualKeyCode } : {}),
  49 |     });
  50 |     await cdp.send("Input.dispatchKeyEvent", {
  51 |       type: "keyUp",
  52 |       key,
  53 |       code: key,
  54 |       windowsVirtualKeyCode,
  55 |       ...(process.platform === "darwin" ? { nativeVirtualKeyCode } : {}),
  56 |     });
  57 |     await page.waitForTimeout(500);
  58 |   }
  59 |   await cdp.detach();
> 60 |   await expect(branch).toHaveValue("release/2.0");
     |                        ^ Error: expect(locator).toHaveValue(expected) failed
  61 |   await expect(dialog).toBeVisible();
  62 |   const confirm = page.getByRole("button", { name: "Create pull request" });
  63 |   await expect(confirm).toBeInViewport();
  64 |   const bounds = await dialog.boundingBox();
  65 |   expect(bounds).not.toBeNull();
  66 |   expect(bounds!.x).toBeGreaterThanOrEqual(0);
  67 |   expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  68 |   await confirm.focus();
  69 |   await page.keyboard.press("Enter");
  70 |   await expect(dialog).toBeHidden();
  71 |   await expect(page.getByTestId("pr-launch-selection")).toHaveText("release/2.0");
  72 | });
  73 |
  74 | test("allows a manually entered branch and resets it on reopen", async ({ page }) => {
  75 |   await page.goto("/agent-launch");
  76 |   const branch = page.getByLabel("Target branch");
  77 |   await branch.fill("main; unsafe");
  78 |   await expect(branch).toHaveAttribute("aria-invalid", "true");
  79 |   await expect(page.getByRole("button", { name: "Create pull request" })).toBeDisabled();
  80 |   await branch.fill("manual/base");
  81 |   await page.getByRole("button", { name: "Create pull request" }).click();
  82 |   await expect(page.getByTestId("pr-launch-selection")).toHaveText("manual/base");
  83 |   await page.getByRole("button", { name: "Reopen PR dialog" }).click();
  84 |   await expect(branch).toHaveValue("main");
  85 | });
  86 |
```
