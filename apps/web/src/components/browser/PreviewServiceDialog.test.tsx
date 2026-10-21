import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { PreviewServiceDialog } from "./PreviewServiceDialog";

afterEach(cleanup);

describe("PreviewServiceDialog", () => {
  test("retains the mobile viewport cap and applies the md cap only from sm", () => {
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
    expect(dialog.classList.contains("max-w-[calc(100%-1rem)]")).toBe(true);
    expect(dialog.classList.contains("sm:max-w-md")).toBe(true);
    expect(dialog.classList.contains("max-w-md")).toBe(false);
  });
});
