import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesignService } from "../apps/backend/src/core/design-service";
import { runDesignAction } from "../apps/backend/src/core/design-tools";

test("canvas edits, script isolation, missed events, conflict and reload", async ({
  page,
}, testInfo) => {
  const dir = await mkdtemp(join(tmpdir(), "ork-design-browser-"));
  const service = new DesignService(dir, () => {});
  try {
    const canvas = await service.create("design-fixture", "Design QA");
    const { frame } = await service.createFrame(canvas.id, "design-fixture", 1, {
      name: "Homepage",
      x: 0,
      y: 0,
      width: 480,
      height: 400,
      html: `<style>body{margin:0;padding:24px;font-family:system-ui}h1{color:rgb(20,30,40)}</style><h1 id="title">A better workspace</h1><script>document.body.textContent="EXECUTED"</script><img onerror="document.body.textContent='EXECUTED'" src="https://example.invalid/x"><div id="target"></div>`,
    });
    await page.exposeFunction("designInvoke", (command: string, args: Record<string, unknown>) => {
      if (command === "design_changes")
        return service.changes(
          String(args.canvasId),
          "design-fixture",
          args.generation as string | undefined,
          args.after as number,
        );
      if (command === "design_action")
        return runDesignAction(service, "design-fixture", args.action as string, args.input);
      throw new Error("Unexpected fixture command");
    });
    await page.goto(`/design-canvas?canvasId=${canvas.id}`);
    await expect(page.getByRole("button", { name: "title", exact: true })).toBeVisible();
    const embedded = page.frameLocator('iframe[title="Homepage"]');
    await expect(embedded.getByRole("heading")).toHaveText("A better workspace");
    await expect(embedded.locator("script")).toHaveCount(0);
    await expect(embedded.locator("img")).not.toHaveAttribute("onerror");
    const headingBounds = await embedded.getByRole("heading").boundingBox();
    expect(headingBounds).not.toBeNull();
    await page.mouse.click(headingBounds!.x + 8, headingBounds!.y + 8);
    await expect(page.getByRole("complementary", { name: "Element inspector" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("design-inspector.png") });
    await page.getByLabel("color", { exact: true }).fill("rgb(240, 10, 20)");
    await page.getByRole("button", { name: "Apply styles" }).click();
    await expect(embedded.getByRole("heading")).toHaveCSS("color", "rgb(240, 10, 20)");
    expect((await service.getFrame(canvas.id, "design-fixture", frame.id)).revision).toBe(2);
    await page.getByRole("button", { name: "Switch tab" }).click();
    await service.mutate(canvas.id, "design-fixture", frame.id, 2, {
      html: "<h1 id='title'>Changed while away</h1>",
    });
    await page.getByRole("button", { name: "Switch tab" }).click();
    await expect(embedded.getByRole("heading")).toHaveText("Changed while away");
    await page.reload();
    await expect(embedded.getByRole("heading")).toHaveText("Changed while away");
    await page.getByRole("button", { name: "title", exact: true }).click();
    await page.getByLabel("color", { exact: true }).fill("blue");
    await service.mutate(canvas.id, "design-fixture", frame.id, 3, {
      html: "<h1 id='title'>Agent's newer edit</h1>",
    });
    await page.getByRole("button", { name: "Apply styles" }).click();
    await expect(page.getByRole("alert")).toContainText("Design revision conflict:");
    expect((await service.getFrame(canvas.id, "design-fixture", frame.id)).html).toContain(
      "Agent's newer edit",
    );
    // Headless capture/DOM operations still work with the canvas unmounted.
    await page.getByRole("button", { name: "Switch tab" }).click();
    const captured = (await runDesignAction(service, "design-fixture", "capture_frame", {
      canvasId: canvas.id,
      frameId: frame.id,
    })) as { data: string };
    expect(Buffer.from(captured.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    const edit = (action: string, expectedRevision: number, input: Record<string, unknown>) =>
      runDesignAction(service, "design-fixture", action, {
        canvasId: canvas.id,
        frameId: frame.id,
        expectedRevision,
        ...input,
      });
    await edit("append_frame_html", 4, {
      html: "<section id='parent'></section><p id='move'>Move me</p>",
    });
    await edit("move_element", 5, { selector: "#move", parentSelector: "#parent" });
    await edit("replace_element_html", 6, {
      selector: "#move",
      html: "<strong id='replacement'>Replaced</strong>",
    });
    const inspected = await runDesignAction(service, "design-fixture", "inspect_element", {
      canvasId: canvas.id,
      frameId: frame.id,
      selector: "#parent > #replacement",
    });
    expect(inspected).toMatchObject({ revision: 7, element: { tag: "strong", text: "Replaced" } });
    await page.getByRole("button", { name: "Switch tab" }).click();
    await page.getByRole("button", { name: "Close inspector" }).click();
    await page.getByRole("button", { name: "replacement", exact: true }).click();
    await page.getByRole("button", { name: "Resize selected element" }).press("ArrowRight");
    await expect
      .poll(async () => (await service.getFrame(canvas.id, "design-fixture", frame.id)).revision)
      .toBe(8);
    await expect(embedded.locator("#replacement")).toHaveCSS("display", "inline-block");
    expect((await service.getFrame(canvas.id, "design-fixture", frame.id)).html).toContain(
      "box-sizing: border-box",
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
