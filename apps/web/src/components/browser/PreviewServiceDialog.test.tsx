import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { PreviewServiceDialog } from "./PreviewServiceDialog";

afterEach(cleanup);

describe("PreviewServiceDialog", () => {
  test("caps the dialog at md inside the viewport gutter", () => {
    render(
      <PreviewServiceDialog
        open
        onOpenChange={() => {}}
        environmentId="env-1"
        environmentType="local"
        onSaved={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Register preview service" });
    expect(dialog.classList.contains("max-w-(--modal-limit)")).toBe(true);
    expect(dialog.classList.contains("[--modal-max-width:28rem]")).toBe(true);
    expect(dialog.classList.contains("[--modal-limit:calc(100%-1rem)]")).toBe(true);
  });
});
