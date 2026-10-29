import { expect, test } from "@playwright/test";

test("multiline paste preserves undo, redo and earlier edits", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/agents-md-approval");
  const entry = page.getByRole("textbox", { name: "Entry 1 text" });
  await expect(page.getByTestId("agents-md-diff")).toBeVisible();
  const original = await entry.inputValue();
  await entry.focus();
  await entry.evaluate((field: HTMLTextAreaElement) =>
    field.setSelectionRange(field.value.length, field.value.length),
  );
  await page.keyboard.insertText(" Earlier edit.");
  const edited = `${original} Earlier edit.`;
  await expect(entry).toHaveValue(edited);
  await page.evaluate(() => navigator.clipboard.writeText("\nPasted\nacross\u2028lines"));
  await entry.press("ControlOrMeta+V");
  await expect(entry).toHaveValue(`${edited} Pasted across lines`);
  await expect(page.getByTestId("agents-md-diff")).toContainText(`${edited} Pasted across lines`);
  await entry.press("ControlOrMeta+Z");
  await expect(entry).toHaveValue(edited);
  await entry.press("ControlOrMeta+Shift+Z");
  await expect(entry).toHaveValue(`${edited} Pasted across lines`);
  await entry.press("ControlOrMeta+Z");
  await entry.press("ControlOrMeta+Z");
  await expect(entry).toHaveValue(original);
});

test("normalized transfers replace the selection, respect the limit and can be undone", async ({
  page,
}) => {
  await page.goto("/agents-md-approval");
  const entry = page.getByRole("textbox", { name: "Entry 1 text" });
  await expect(page.getByTestId("agents-md-diff")).toBeVisible();
  for (const kind of ["paste", "insertFromDrop", "insertText"] as const) {
    await entry.fill("x".repeat(490));
    await entry.evaluate((field: HTMLTextAreaElement) => {
      field.focus();
      field.setSelectionRange(480, 490);
    });
    await entry.evaluate((field, type) => {
      const data = new DataTransfer();
      data.setData("text/plain", "first\nsecond\rthird\u0085fourth");
      field.dispatchEvent(
        type === "paste"
          ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
          : new InputEvent("beforeinput", {
              inputType: type,
              data: data.getData("text/plain"),
              bubbles: true,
              cancelable: true,
            }),
      );
    }, kind);
    await expect(entry).toHaveValue(`${"x".repeat(480)}first second third f`);
    await entry.press("ControlOrMeta+Z");
    await expect(entry).toHaveValue("x".repeat(490));
  }
});

test("wrapped entries grow, stop at eight lines with internal scrolling, and shrink", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/agents-md-approval");
  const entry = page.getByRole("textbox", { name: "Entry 1 text" });
  await expect(page.getByTestId("agents-md-diff")).toBeVisible();
  await page.getByTestId("agents-md-request").evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const metrics = () =>
    entry.evaluate((field) => {
      const style = getComputedStyle(field);
      return {
        height: field.getBoundingClientRect().height,
        client: field.clientHeight,
        scroll: field.scrollHeight,
        cap:
          8 * parseFloat(style.lineHeight) +
          parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom) +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.borderBottomWidth),
      };
    });
  await entry.fill("Short decision.");
  const short = await metrics();
  await entry.fill("Keep the decision readable. ".repeat(4));
  await expect.poll(async () => (await metrics()).height).toBeGreaterThan(short.height);
  const medium = await metrics();
  await entry.fill("Keep this decision readable in full. ".repeat(13));
  await expect.poll(async () => (await metrics()).height).toBeGreaterThan(medium.height);
  const capped = await metrics();
  expect(capped.height).toBeCloseTo(capped.cap, 0);
  expect(capped.scroll).toBeGreaterThan(capped.client);
  await entry.evaluate((field) => (field.scrollTop = field.scrollHeight));
  expect(await entry.evaluate((field) => field.scrollTop)).toBeGreaterThan(0);
  await entry.fill("Short decision.");
  await expect.poll(async () => (await metrics()).height).toBeCloseTo(short.height, 0);
  const shrunk = await metrics();
  expect(shrunk.scroll).toBe(shrunk.client);
});

test("review body scrolls while the header and actions stay visible and reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto("/agents-md-approval?many");
  const dialog = page.getByTestId("agents-md-request");
  const body = page.getByTestId("agents-md-body");
  const header = dialog.getByRole("heading", { name: "Save decisions to AGENTS.md?" });
  const decline = dialog.getByRole("button", { name: "Decline" });
  const approve = dialog.getByRole("button", { name: "Approve and open PR" });
  await expect(page.getByTestId("agents-md-diff")).toBeAttached();
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const before = await Promise.all([
    header.boundingBox(),
    decline.boundingBox(),
    approve.boundingBox(),
  ]);
  // Wheel over the body's padding, outside the textareas' own scroll areas.
  await body.hover({ position: { x: 2, y: 2 } });
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByTestId("agents-md-diff")).toBeInViewport();
  const lastEntry = dialog.getByRole("textbox", { name: "Entry 6 text" });
  await lastEntry.scrollIntoViewIfNeeded();
  await expect(lastEntry).toBeInViewport();
  for (const [index, control] of [header, decline, approve].entries()) {
    await expect(control).toBeInViewport({ ratio: 1 });
    const after = (await control.boundingBox())!;
    expect(after.y).toBeCloseTo(before[index]!.y, 0);
  }
  await approve.focus();
  await expect(approve).toBeFocused();
  await approve.click({ trial: true });
  await decline.click();
  await expect(page.getByTestId("decision")).toContainText('"decision":"reject"');
});

test("AGENTS.md approval shows the section diff, takes edits and approves them", async ({
  page,
}) => {
  await page.goto("/agents-md-approval");
  const dialog = page.getByTestId("agents-md-request");
  await expect(dialog.getByRole("heading", { name: "Save decisions to AGENTS.md?" })).toBeVisible();
  await expect(dialog).toContainText("Agreed while planning the release");
  const diff = page.getByTestId("agents-md-diff");
  await expect(diff.locator('[data-diff="remove"]')).toHaveText([
    "- - Never touch ports 34121/34122.",
  ]);
  await expect(diff.locator('[data-diff="add"]')).toHaveText([
    "+ - Never bind ports 34121 or 34122.",
    "+ - Commit flaky-test records in the same change.",
  ]);
  // Unchanged entries stay as context.
  await expect(
    diff.locator('[data-diff="same"]', { hasText: "Use bun, never npm." }),
  ).toBeVisible();

  // An entry that would escape the section is refused before approval.
  const first = dialog.getByRole("textbox", { name: "Entry 1 text" });
  await first.fill("## Injected heading");
  await expect(dialog.getByRole("alert")).toContainText("cannot start with a heading");
  await expect(dialog.getByRole("button", { name: "Approve and open PR" })).toBeDisabled();

  await first.fill("Commit flaky-test records with the fix.");
  await expect(diff.locator('[data-diff="add"]')).toContainText([
    "+ - Commit flaky-test records with the fix.",
  ]);
  await expect(page.getByTestId("decision")).toHaveText("");
  await dialog.getByRole("button", { name: "Approve and open PR" }).click();
  await expect(page.getByTestId("decision")).toContainText('"decision":"approve"');
  await expect(page.getByTestId("decision")).toContainText(
    '"text":"Commit flaky-test records with the fix."',
  );
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("AGENTS.md approval can be declined without approving anything", async ({ page }) => {
  await page.goto("/agents-md-approval");
  const dialog = page.getByTestId("agents-md-request");
  await expect(page.getByTestId("agents-md-diff")).toBeVisible();
  await dialog.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("decision")).toHaveText(
    JSON.stringify({ requestId: "agents-md-fixture", decision: "reject" }),
  );
});

test("approval waits for a successfully rendered preview", async ({ page }) => {
  await page.goto("/agents-md-approval?preview=pending");
  const approve = page.getByRole("button", { name: "Approve and open PR" });
  await expect(approve).toBeDisabled();
  await expect(page.getByRole("button", { name: "Decline" })).toBeEnabled();
  await expect(page.getByTestId("decision")).toHaveText("");
  await expect(page.getByText("Reading AGENTS.md on the base branch…")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("agents-md-preview-ready")));
  await expect(page.getByTestId("agents-md-diff")).toBeVisible();
  await expect(approve).toBeEnabled();
});

test("a failed preview can be retried without approving it", async ({ page }) => {
  await page.goto("/agents-md-approval?preview=error");
  await expect(page.getByText(/The project node is offline/)).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve and open PR" });
  await expect(approve).toBeDisabled();
  await page.getByRole("button", { name: "Retry preview" }).click();
  await expect(page.getByTestId("agents-md-diff")).toBeVisible();
  await expect(approve).toBeEnabled();
  await expect(page.getByTestId("decision")).toHaveText("");
});

test("a merge failure blocks approval and still allows decline", async ({ page }) => {
  await page.goto("/agents-md-approval?preview=invalid");
  await expect(page.getByText(/more than one ## Orkestrator/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and open PR" })).toBeDisabled();
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("decision")).toContainText('"decision":"reject"');
});

test("the approval dialog keeps a capped width and wraps long entries inside it", async ({
  page,
}) => {
  await page.goto("/agents-md-approval");
  const dialog = page.getByTestId("agents-md-request");
  await expect(page.getByTestId("agents-md-diff")).toBeVisible();
  // Visibility precedes the end of DialogContent's opening zoom. Measure only
  // after its animations settle, including when the preview resolves immediately.
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const viewport = page.viewportSize()!;
  const widthBefore = (await dialog.boundingBox())!.width;
  // 3xl is 48rem; narrower windows keep a gutter of 0.5rem per side on phones.
  expect(widthBefore).toBeLessThanOrEqual(Math.min(768, viewport.width - 16));
  expect(widthBefore).toBeGreaterThan(Math.min(700, viewport.width - 40));

  const token = `docs/${"very-long-path-segment-".repeat(18)}end.md`;
  await dialog.getByRole("textbox", { name: "Entry 1 text" }).fill(`Read ${token} first.`);
  await expect(page.getByTestId("agents-md-diff")).toContainText(token);

  expect((await dialog.boundingBox())!.width).toBe(widthBefore);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
