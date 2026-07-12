import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { NativeComposeDock } from "./NativeComposeDock";

describe("NativeComposeDock", () => {
  afterEach(() => cleanup());

  test("centers the compose dock with visible title and actions", () => {
    const { container } = render(
      <NativeComposeDock
        centered={true}
        title="Ready"
        actions={<button type="button">Resume</button>}
      >
        <textarea aria-label="Prompt" />
      </NativeComposeDock>,
    );

    const dock = container.firstElementChild as HTMLElement;
    expect(dock.className).toContain("top-1/2");
    expect(dock.className).toContain("-translate-y-1/2");
    expect(screen.getByRole("heading", { name: "Ready" }).parentElement?.className).toContain("opacity-100");
    expect(screen.getByRole("button", { name: "Resume" }).parentElement?.className).toContain("opacity-100");
  });

  test("docks at the bottom and hides title and actions when not centered", () => {
    const { container } = render(
      <NativeComposeDock centered={false} actions={<button type="button">Resume</button>}>
        <textarea aria-label="Prompt" />
      </NativeComposeDock>,
    );

    const dock = container.firstElementChild as HTMLElement;
    expect(dock.className).toContain("top-full");
    expect(dock.className).toContain("-translate-y-full");
    expect(screen.getByRole("heading", { name: "Ready to build!" }).parentElement?.className).toContain("opacity-0");
    expect(screen.getByRole("button", { name: "Resume" }).parentElement?.className).toContain("max-h-0");
  });

  test("shows the top accessory only when bottom docked", () => {
    const { rerender } = render(
      <NativeComposeDock
        centered={false}
        topAccessory={<button type="button">Scroll down</button>}
      >
        <textarea aria-label="Prompt" />
      </NativeComposeDock>,
    );

    expect(screen.getByRole("button", { name: "Scroll down" })).toBeTruthy();

    rerender(
      <NativeComposeDock
        centered={true}
        topAccessory={<button type="button">Scroll down</button>}
      >
        <textarea aria-label="Prompt" />
      </NativeComposeDock>,
    );

    expect(screen.queryByRole("button", { name: "Scroll down" })).toBeNull();
  });
});
