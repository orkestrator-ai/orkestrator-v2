import { expect, test } from "@playwright/test";

test("fenced code loses the inline chip while inline code keeps it", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "desktop coverage is sufficient for editor styles",
  );

  await page.goto("/markdown-editor");
  const editor = page.getByTestId("tiptap-markdown-editor");
  const inlineCode = editor.locator("p code");
  const fencedCode = editor.locator("pre code");

  await expect(inlineCode).toHaveText("chip");
  await expect(fencedCode).toHaveText("mise install\nmise run dev");

  await expect(inlineCode).toHaveCSS("padding-left", "4px");
  await expect(inlineCode).toHaveCSS("padding-right", "4px");
  await expect(inlineCode).toHaveCSS("padding-top", "2px");
  await expect(inlineCode).toHaveCSS("padding-bottom", "2px");
  await expect(inlineCode).toHaveCSS("border-radius", "4px");
  await expect(inlineCode).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await expect(fencedCode).toHaveCSS("padding-left", "0px");
  await expect(fencedCode).toHaveCSS("padding-right", "0px");
  await expect(fencedCode).toHaveCSS("padding-top", "0px");
  await expect(fencedCode).toHaveCSS("padding-bottom", "0px");
  await expect(fencedCode).toHaveCSS("border-radius", "0px");
  await expect(fencedCode).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});
