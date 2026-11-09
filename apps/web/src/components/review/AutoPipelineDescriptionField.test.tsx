import { afterEach, expect, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { cleanupNodeScopes, renderInNodeScope } from "@/test/render-in-node-scope";
import { AutoPipelineDescriptionField } from "./AutoPipelineDescriptionField";

afterEach(cleanupNodeScopes);

for (const key of ["Enter", " "]) {
  test(`description preview activates with ${JSON.stringify(key)}`, async () => {
    renderInNodeScope(
      <AutoPipelineDescriptionField value="**Draft**" onChange={() => undefined} />,
    );
    const preview = screen.getByRole("button", { name: /^Description, rendered/ });
    preview.focus();
    fireEvent.keyDown(preview, { key });
    const editor = screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("**Draft**");
    expect(document.activeElement === editor).toBe(true);
    fireEvent.blur(editor);
    expect((await screen.findByText("Draft")).tagName).toBe("STRONG");
  });
}

test("disabled description cannot enter edit mode with pointer or keyboard", () => {
  renderInNodeScope(
    <AutoPipelineDescriptionField value="Draft" disabled onChange={() => undefined} />,
  );
  const preview = screen.getByRole("button", { name: /^Description, rendered/ });
  expect(preview.getAttribute("aria-disabled")).toBe("true");
  expect(preview.tabIndex).toBe(-1);
  fireEvent.click(preview);
  fireEvent.keyDown(preview, { key: "Enter" });
  fireEvent.keyDown(preview, { key: " " });
  expect(screen.queryByRole("textbox", { name: "Description" }) === null).toBe(true);
});

test("rendered Markdown links do not activate the description editor", async () => {
  renderInNodeScope(
    <AutoPipelineDescriptionField
      value="Read [the guide](https://example.com/guide)."
      onChange={() => undefined}
    />,
  );
  const link = await screen.findByRole("link", { name: "the guide" });
  expect(link.getAttribute("href")).toBe("https://example.com/guide");
  fireEvent.click(link);
  fireEvent.keyDown(link, { key: "Enter" });
  expect(screen.queryByRole("textbox", { name: "Description" }) === null).toBe(true);
  expect(screen.getByRole("button", { name: /^Description, rendered/ })).toBeTruthy();
});
