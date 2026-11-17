import { expect, test, type Download, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDesignServiceHost } from "./design-service-client";

const slide = (title: string, color: string) =>
  `<style>body{margin:0;height:100vh;display:grid;place-content:center;font-family:system-ui;background:${color};color:#fff}h1{font-size:48px}</style><h1>${title}</h1>`;

async function saved(page: Page, act: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent("download"), act()]);
  return {
    name: (download as Download).suggestedFilename(),
    bytes: await readFile((await (download as Download).path())!),
  };
}

test("selected frames download as PNG, WEBP, a multi-page PDF and a ZIP", async ({
  page,
}, testInfo) => {
  // Shift-click selection is a pointer gesture; the phone project has touch only.
  test.skip(testInfo.project.name === "mobile-chromium", "desktop pointer gesture");
  const dir = await mkdtemp(join(tmpdir(), "ork-design-download-"));
  const worktree = join(dir, "worktree");
  await mkdir(worktree);
  // Real design service and renderer: every file holds a real Chromium capture.
  const service = startDesignServiceHost(dir, worktree);
  try {
    const canvas = await service.create("design-fixture", "Pitch deck");
    const first = await service.createFrame(canvas.id, "design-fixture", 1, {
      name: "Intro slide",
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      html: slide("Intro", "#1d4ed8"),
    });
    await service.createFrame(canvas.id, "design-fixture", first.canvasRevision, {
      name: "Outro slide",
      x: 360,
      y: 0,
      width: 320,
      height: 180,
      html: slide("Outro", "#047857"),
    });
    let failCapture = false;
    let rejectCapture: ((error: Error) => void) | undefined;
    await page.exposeFunction("designInvoke", (command: string, args: Record<string, unknown>) => {
      if (command === "design_capture" && failCapture) {
        failCapture = false;
        return new Promise((_, reject) => {
          rejectCapture = reject;
        });
      }
      return service.invoke(command, args);
    });
    await page.goto(`/design-canvas?canvasId=${canvas.id}`);
    const intro = page.getByRole("button", { name: "Move frame Intro slide" });
    const outro = page.getByRole("button", { name: "Move frame Outro slide" });
    await expect(intro).toBeVisible();
    await expect(page.getByRole("button", { name: "Download Intro slide" })).toHaveCount(0);

    await intro.click();
    await expect(page.getByRole("button", { name: "Download Intro slide" })).toBeVisible();
    await outro.click({ modifiers: ["Shift"] });
    await expect(intro).toHaveAttribute("aria-pressed", "true");
    await expect(outro).toHaveAttribute("aria-pressed", "true");
    const download = page.getByRole("button", { name: "Download Outro slide" });
    // The same blue as the selection outline it sits above.
    const outline = page.getByTestId("frame-selection-outline").last();
    await expect(download).toHaveCSS(
      "color",
      await outline.evaluate((node) => getComputedStyle(node).borderTopColor),
    );

    await outro.press("Delete");
    await expect(
      page.getByRole("status").filter({ hasText: "Select a single frame to delete" }),
    ).toBeAttached();
    const menu = page.getByRole("menu");
    const choose = async (group: string, item: string) => {
      await download.click();
      await menu.getByRole("group", { name: group }).getByRole("menuitem", { name: item }).click();
    };

    // A rejected capture reaches the canvas error banner, releases busy state,
    // saves no file, and the next selection of the same action can succeed.
    const downloads: Download[] = [];
    page.on("download", (value) => downloads.push(value));
    failCapture = true;
    await choose("This frame", "PNG image");
    await expect(download).toBeDisabled();
    await expect.poll(() => Boolean(rejectCapture)).toBe(true);
    rejectCapture!(new Error("Capture temporarily unavailable"));
    await expect(page.getByRole("alert")).toContainText("Capture temporarily unavailable");
    await expect(download).toBeEnabled();
    expect(downloads).toHaveLength(0);
    await mkdir("output/visual-previews", { recursive: true });
    await page.screenshot({
      path: "output/visual-previews/frame-download-capture-error-after.png",
    });

    const png = await saved(page, () => choose("This frame", "PNG image"));
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(png.name).toBe("Outro-slide.png");
    expect(png.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.bytes.readUInt32BE(16)).toBe(320);
    expect(png.bytes.readUInt32BE(20)).toBe(180);

    const webp = await saved(page, () => choose("This frame", "WEBP image"));
    expect(webp.name).toBe("Outro-slide.webp");
    expect(webp.bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(webp.bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");

    const pdf = await saved(page, () => choose("Selected frames (2)", "PDF (one page per frame)"));
    expect(pdf.name).toBe("Pitch-deck-selected.pdf");
    const pdfText = pdf.bytes.toString("latin1");
    expect(pdfText.startsWith("%PDF-1.4")).toBe(true);
    expect(pdfText).toContain("/Count 2");
    expect(pdfText.match(/\/MediaBox \[0 0 240 135\]/g)).toHaveLength(2);

    const zip = await saved(page, () => choose("All frames (2)", "WEBP images (.zip)"));
    expect(zip.name).toBe("Pitch-deck.zip");
    expect(zip.bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    const zipText = zip.bytes.toString("latin1");
    expect(zipText).toContain("01-Intro-slide.webp");
    expect(zipText).toContain("02-Outro-slide.webp");

    // An agent removes one selected frame while this view is inactive. On
    // return the current backend snapshot must repair both count and Delete.
    await page.getByRole("button", { name: "Switch tab" }).click();
    const current = await service.get(canvas.id, "design-fixture");
    const removed = await service.action("submit_operation", {
      canvasId: canvas.id,
      input: { kind: "delete_frame", frameId: first.frame.id },
      preconditions: { canvasRevision: current.revision, frameRevision: first.frame.revision },
      correlationId: "download-external-removal",
    });
    expect(removed).toMatchObject({ state: "committed" });
    await page.getByRole("button", { name: "Switch tab" }).click();
    await expect(intro).toHaveCount(0);
    await expect(outro).toHaveAttribute("aria-pressed", "true");
    await download.click();
    await expect(menu.getByRole("group")).toHaveCount(1);
    await expect(menu.getByRole("group", { name: "This frame" })).toBeVisible();
    await page.screenshot({
      path: "output/visual-previews/frame-download-external-removal-after.png",
    });
    await page.keyboard.press("Escape");
    await outro.press("Delete");
    await expect(outro).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: /Move frame/ })).toHaveCount(0);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
