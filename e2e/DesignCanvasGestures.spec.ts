import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDesignServiceHost } from "./design-service-client";

const previewDir = join(import.meta.dirname, "../output/visual-previews");
async function point(locator: Locator, x = 0.5, y = 0.5) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width * x, y: box.y + box.height * y };
}
async function geometry(section: Locator) {
  return section.evaluate((node: HTMLElement) => ({
    x: Number.parseFloat(node.style.left),
    y: Number.parseFloat(node.style.top),
    width: Number.parseFloat(node.style.width),
    height: Number.parseFloat(node.style.height),
  }));
}
async function drag(page: Page, source: Locator, dx: number, dy: number) {
  // Keep the press inside the handle when snapped edges overlap a later frame.
  const start = await point(source, 0.25, 0.25);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 5 });
}

test("real pointer capture preserves body and placeholder marquees; handles snap, bypass and cancel", async ({
  page,
}, testInfo) => {
  const dir = await mkdtemp(join(tmpdir(), "ork-design-gestures-"));
  const worktree = join(dir, "worktree");
  await mkdir(worktree);
  const service = startDesignServiceHost(dir, worktree);
  try {
    const canvas = await service.create("design-fixture", "Gesture QA");
    const { frame: a } = await service.createFrame(canvas.id, "design-fixture", 1, {
      name: "A",
      x: 13,
      y: 7,
      width: 200,
      height: 160,
      html: "<style>body{margin:0}h1{margin:0;padding:10px;font:20px sans-serif}</style><h1>Inspect me</h1>",
    });
    const { frame: b } = await service.createFrame(canvas.id, "design-fixture", 2, {
      name: "B",
      x: 350,
      y: 207,
      width: 200,
      height: 160,
      html: "<p>Companion</p>",
    });
    await service.createFrame(canvas.id, "design-fixture", 3, {
      name: "Tiny",
      x: 260,
      y: 87,
      width: 32,
      height: 32,
      html: "<p>Tiny</p>",
    });
    await page.exposeFunction("designInvoke", (command: string, args: Record<string, unknown>) =>
      service.invoke(command, args),
    );
    await page.goto(`/design-canvas?canvasId=${canvas.id}`);
    await page.getByRole("button", { name: "Toggle layers", exact: true }).click();
    await page.getByRole("button", { name: "Fit all frames", exact: true }).click();
    const viewport = page.getByRole("main", { name: "Canvas viewport" });
    const sectionA = page.locator(`section[data-frame-id="${a.id}"]`);
    const sectionB = page.locator(`section[data-frame-id="${b.id}"]`);
    const titleA = page.getByRole("button", { name: "Move frame A", exact: true });
    const bodyA = page.getByRole("button", { name: "Select element in A", exact: true });
    const placeholder = page.getByRole("button", { name: "Show Tiny", exact: true });
    await expect(bodyA).toBeVisible();
    await expect(placeholder).toBeVisible();
    await expect(page.frameLocator('iframe[title="A"]').getByRole("heading")).toBeVisible();
    await mkdir(previewDir, { recursive: true });
    await page.screenshot({
      path: join(previewDir, `gesture-fixed-idle-${testInfo.project.name}.png`),
    });

    // A Shift-click remains an inspect click; no marquee capture should consume it.
    const inspect = await point(bodyA, 0.25, 0.1);
    await page.keyboard.down("Shift");
    await page.mouse.click(inspect.x, inspect.y);
    await page.keyboard.up("Shift");
    await expect(page.getByLabel("Fill", { exact: true })).toBeVisible();
    // Dismiss the narrow inspector drawer before interacting with the canvas again.
    await page.keyboard.press("Escape");

    const scale = (await sectionA.boundingBox())!.width / 200;
    // A jittery click on an off-grid frame cannot write geometry.
    await drag(page, titleA, 1, 0);
    await page.mouse.up();
    expect((await service.getFrame(canvas.id, "design-fixture", a.id)).revision).toBe(1);
    expect((await geometry(sectionA)).x).toBe(13);

    // Start inside a live body. Capture transfers to the viewport only after activation.
    const begin = await point(bodyA, 0.8, 0.8);
    const finish = await point(sectionB, 0.6, 0.6);
    await page.keyboard.down("Shift");
    await page.mouse.move(begin.x, begin.y);
    await page.mouse.down();
    await page.mouse.move(finish.x, finish.y, { steps: 6 });
    await expect(page.getByTestId("design-marquee")).toBeVisible();
    expect(await viewport.evaluate((node) => node.hasPointerCapture(1))).toBe(true);
    await page.screenshot({
      path: join(previewDir, `gesture-fixed-marquee-${testInfo.project.name}.png`),
    });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(sectionA).toHaveAttribute("data-selected", "true");
    await expect(sectionB).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("design-marquee")).toHaveCount(0);
    // The retargeted click must not inspect an element and clear the board selection.
    await expect(page.getByRole("button", { name: "Move frame B", exact: true })).toBeFocused();

    // The placeholder starts a box too; its click must not fit the frame afterwards.
    const beforePlaceholder = await sectionA.boundingBox();
    const fromPlaceholder = await point(placeholder);
    await page.keyboard.down("Shift");
    await page.mouse.move(fromPlaceholder.x, fromPlaceholder.y);
    await page.mouse.down();
    await page.mouse.move(finish.x, finish.y, { steps: 5 });
    await expect(page.getByTestId("design-marquee")).toBeVisible();
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(sectionB).toHaveAttribute("data-selected", "true");
    expect(await sectionA.boundingBox()).toEqual(beforePlaceholder);

    // Cancel from a live body, release while still captured, preserve earlier selection.
    await titleA.click();
    await page.keyboard.down("Shift");
    await page.mouse.move(begin.x, begin.y);
    await page.mouse.down();
    await page.mouse.move(finish.x, finish.y, { steps: 5 });
    await expect(sectionB).toHaveAttribute("data-selected", "true");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(sectionA).toHaveAttribute("data-selected", "true");
    await expect(sectionB).not.toHaveAttribute("data-selected");

    // Pointer cancellation from a placeholder also restores the earlier selection.
    await page.keyboard.down("Shift");
    await page.mouse.move(fromPlaceholder.x, fromPlaceholder.y);
    await page.mouse.down();
    await page.mouse.move(finish.x, finish.y, { steps: 5 });
    await expect(sectionB).toHaveAttribute("data-selected", "true");
    await viewport.dispatchEvent("pointercancel", { pointerId: 1, bubbles: true });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(sectionA).toHaveAttribute("data-selected", "true");
    await expect(sectionB).not.toHaveAttribute("data-selected");

    // A group preview is abandoned on Escape, including the companion offset.
    await page
      .getByRole("button", { name: "Move frame B", exact: true })
      .click({ modifiers: ["Shift"] });
    await drag(page, titleA, 20 * scale, 0);
    await expect.poll(async () => (await geometry(sectionB)).x).toBe(367);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(async () => (await geometry(sectionB)).x).toBe(350);
    expect((await service.getFrame(canvas.id, "design-fixture", b.id)).revision).toBe(1);

    // The real resize handle snaps its right/bottom to B's left/top edges.
    const resize = page.getByRole("button", { name: "Resize frame A", exact: true });
    await resize.focus();
    await drag(page, resize, 134 * scale, 39 * scale);
    await expect.poll(async () => (await geometry(sectionA)).width).toBe(337);
    await expect.poll(async () => (await geometry(sectionA)).height).toBe(200);
    await expect(page.getByTestId("design-snap-guide")).toHaveCount(2);
    await page.screenshot({
      path: join(previewDir, `gesture-fixed-resize-guides-${testInfo.project.name}.png`),
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await service.getFrame(canvas.id, "design-fixture", a.id)).width)
      .toBe(337);

    // Alt bypass through the same handle, then grid fallback away from neighbours.
    await page.keyboard.down("Alt");
    await drag(page, resize, -17 * scale, -13 * scale);
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await expect
      .poll(async () => (await service.getFrame(canvas.id, "design-fixture", a.id)).width)
      .toBe(320);
    await drag(page, resize, -100 * scale, -30 * scale);
    await page.mouse.up();
    await expect
      .poll(async () => (await service.getFrame(canvas.id, "design-fixture", a.id)).width)
      .toBe(217);
    const committed = await service.getFrame(canvas.id, "design-fixture", a.id);
    expect(committed.height).toBe(153);
    await resize.focus();
    await drag(page, resize, 20 * scale, 20 * scale);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(async () => (await geometry(sectionA)).width).toBe(committed.width);
    expect((await service.getFrame(canvas.id, "design-fixture", a.id)).revision).toBe(
      committed.revision,
    );

    // Hide the initiating tree, then return and reload authoritative geometry.
    await page.getByRole("button", { name: "Switch tab" }).click();
    await page.getByRole("button", { name: "Switch tab" }).click();
    await page.reload();
    await expect.poll(async () => (await geometry(sectionA)).width).toBe(committed.width);
    await expect.poll(async () => (await geometry(sectionA)).height).toBe(committed.height);
    await page.screenshot({
      path: join(previewDir, `gesture-fixed-after-${testInfo.project.name}.png`),
    });
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
