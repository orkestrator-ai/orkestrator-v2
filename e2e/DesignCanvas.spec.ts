import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesignService } from "../apps/backend/src/core/design-service";
import { runDesignAction } from "../apps/backend/src/core/design-tools";
import { DESIGN_EVENT } from "@orkestrator/protocol/design-canvas";

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
      html: `<style>body{margin:0;padding:24px;font-family:system-ui}h1{color:rgb(20,30,40);background-color:rgba(10,20,30,.4)}</style><h1 id="title">A better workspace</h1><script>document.body.textContent="EXECUTED"</script><img onerror="document.body.textContent='EXECUTED'" src="https://example.invalid/x"><template id="nested"><script>bad()</script><iframe src="data:text/html,bad"></iframe><frame src="bad"></frame></template><div id="target"></div>`,
    });
    const changeGenerations: Array<string | undefined> = [];
    await page.exposeFunction("designInvoke", (command: string, args: Record<string, unknown>) => {
      if (command === "design_changes") {
        changeGenerations.push(args.generation as string | undefined);
        return service.changes(
          String(args.canvasId),
          "design-fixture",
          args.generation as string | undefined,
          args.after as number,
        );
      }
      if (command === "design_action")
        return runDesignAction(service, "design-fixture", args.action as string, args.input);
      if (command === "design_save") return { filePath: args.filePath, revision: 1 };
      throw new Error("Unexpected fixture command");
    });
    await page.goto(`/design-canvas?canvasId=${canvas.id}`);
    await expect(page.getByRole("button", { name: "title", exact: true })).toBeVisible();
    const hierarchy = page.getByRole("navigation", { name: "Design hierarchy" });
    const divider = page.getByRole("separator", { name: "Resize design hierarchy" });
    const workspace = page.locator(".design-workspace");
    await expect(workspace.locator("header")).toHaveCSS("border-bottom-color", "rgb(34, 38, 45)");
    await expect(workspace.locator("footer")).toHaveCSS("border-top-color", "rgb(34, 38, 45)");
    await expect(divider).toHaveCSS("background-color", "rgb(34, 38, 45)");
    const beforeResize = (await hierarchy.boundingBox())!.width;
    const handle = (await divider.boundingBox())!;
    await page.mouse.move(handle.x, handle.y + 30);
    await page.mouse.down();
    await page.mouse.move(handle.x - 30, handle.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await hierarchy.boundingBox())!.width).toBe(beforeResize - 30);
    await divider.press("ArrowRight");
    await expect.poll(async () => (await hierarchy.boundingBox())!.width).toBe(beforeResize - 20);
    const initialViewport = page.viewportSize()!;
    const resizedForMaximum = Number(await divider.getAttribute("aria-valuemax")) === 400;
    if (resizedForMaximum)
      await page.setViewportSize({ width: 700, height: initialViewport.height });
    await expect
      .poll(async () => Number(await divider.getAttribute("aria-valuemax")))
      .toBeLessThan(400);
    const reachableMaximum = await divider.getAttribute("aria-valuemax");
    await divider.press("End");
    await expect
      .poll(async () => await divider.getAttribute("aria-valuenow"))
      .toBe(reachableMaximum);
    if (resizedForMaximum) await page.setViewportSize(initialViewport);
    await expect
      .poll(
        async () =>
          (await page.getByRole("main", { name: "Canvas viewport" }).boundingBox())!.width,
      )
      .toBeGreaterThan(200);
    await divider.press("Home");
    await expect(divider).toHaveAttribute("aria-valuenow", "120");
    await page.getByRole("button", { name: "Toggle layers" }).click();
    await expect(divider).toBeHidden();
    await page.getByRole("button", { name: "Toggle layers" }).click();
    await expect(divider).toHaveAttribute("aria-valuenow", "120");
    await divider.press("ArrowRight");
    await divider.press("ArrowRight");
    await divider.press("ArrowRight");
    await divider.press("ArrowRight");
    const embedded = page.frameLocator('iframe[title="Homepage"]');
    await expect(embedded.getByRole("heading")).toHaveText("A better workspace");
    await expect(embedded.locator("script")).toHaveCount(0);
    await expect(embedded.locator("img")).not.toHaveAttribute("onerror");
    expect(
      await embedded
        .locator("#nested")
        .evaluate((node) =>
          Array.from(
            (node as HTMLTemplateElement).content.querySelectorAll("script,iframe,frame"),
          ).map((child) => child.tagName),
        ),
    ).toEqual([]);
    const headingBounds = await embedded.getByRole("heading").boundingBox();
    expect(headingBounds).not.toBeNull();
    await page.mouse.click(headingBounds!.x + 8, headingBounds!.y + 8);
    await expect(page.getByRole("complementary", { name: "Element inspector" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Element inspector" })).toHaveCSS(
      "border-left-color",
      "rgb(34, 38, 45)",
    );
    if (page.viewportSize()!.width <= 600) {
      await expect(hierarchy).toBeHidden();
      await expect(divider).toBeHidden();
    }
    await page
      .getByRole("button", { name: "Resize selected element" })
      .dispatchEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
    await page.getByRole("button", { name: "Resize selected element" }).dispatchEvent("pointerup", {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    expect((await service.getFrame(canvas.id, "design-fixture", frame.id)).revision).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("design-inspector.png") });
    const widthField = page.getByRole("textbox", { name: "width", exact: true });
    const heightField = page.getByRole("textbox", { name: "height", exact: true });
    const widthBox = (await widthField.boundingBox())!;
    const heightBox = (await heightField.boundingBox())!;
    expect(widthBox.y).toBe(heightBox.y);
    expect(heightBox.x).toBeGreaterThan(widthBox.x + widthBox.width);
    const inspector = page.getByRole("complementary", { name: "Element inspector" });
    expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await expect(page.getByRole("button", { name: "Apply styles" })).toBeDisabled();
    await page.getByRole("combobox", { name: "position", exact: true }).click();
    await page.getByRole("option", { name: "relative", exact: true }).click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "position", exact: true })).toContainText(
      "static",
    );
    await expect(page.getByRole("button", { name: "Apply styles" })).toBeDisabled();
    await page.getByRole("combobox", { name: "position", exact: true }).click();
    await page.getByRole("option", { name: "relative", exact: true }).click();
    await page.getByRole("combobox", { name: "text-align", exact: true }).click();
    await page.getByRole("option", { name: "center", exact: true }).click();
    await page.getByRole("combobox", { name: "font-weight", exact: true }).click();
    await page.getByRole("option", { name: "Custom…", exact: true }).click();
    await page.getByRole("textbox", { name: "font-weight", exact: true }).fill("450");
    await page.getByLabel("Pick background-color", { exact: true }).fill("#336699");
    await expect(page.getByRole("textbox", { name: "background-color", exact: true })).toHaveValue(
      "rgba(51, 102, 153, 0.4)",
    );
    // Draft controls must not overwrite the frame until explicitly applied.
    expect((await service.getFrame(canvas.id, "design-fixture", frame.id)).revision).toBe(1);
    await page.getByLabel("color", { exact: true }).fill("rgb(240, 10, 20)");
    await page.getByRole("button", { name: "Apply styles" }).click();
    await expect(embedded.getByRole("heading")).toHaveCSS("color", "rgb(240, 10, 20)");
    await expect(embedded.getByRole("heading")).toHaveCSS(
      "background-color",
      "rgba(51, 102, 153, 0.4)",
    );
    await expect(embedded.getByRole("heading")).toHaveCSS("position", "relative");
    await expect(embedded.getByRole("heading")).toHaveCSS("text-align", "center");
    await expect(embedded.getByRole("heading")).toHaveCSS("font-weight", "450");
    expect((await service.getFrame(canvas.id, "design-fixture", frame.id)).revision).toBe(2);
    await page.getByRole("button", { name: "Switch tab" }).click();
    await service.mutate(canvas.id, "design-fixture", frame.id, 2, {
      html: "<h1 id='title'>Changed while away</h1>",
    });
    await page.getByRole("button", { name: "Switch tab" }).click();
    await page.evaluate(
      ({ event, canvasId, revision }) =>
        window.dispatchEvent(
          new CustomEvent(`orkestrator-fixture:${event}`, {
            detail: { canvasId, revision },
          }),
        ),
      { event: DESIGN_EVENT, canvasId: canvas.id, revision: 3 },
    );
    await expect(embedded.getByRole("heading")).toHaveText("Changed while away");
    const undefinedGenerations = changeGenerations.filter((value) => value === undefined).length;
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("orkestrator-fixture:native-event-stream-connected")),
    );
    await expect
      .poll(() => changeGenerations.filter((value) => value === undefined).length)
      .toBeGreaterThan(undefinedGenerations);
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
    await page.getByRole("button", { name: "Save design to repository" }).click();
    await expect(page.getByText("Saved Design-QA.orkdes", { exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download orkdes" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("Design-QA.orkdes");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
