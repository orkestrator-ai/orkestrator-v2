import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { InfoHint } from "./info-hint";

describe("InfoHint", () => {
  afterEach(() => {
    cleanup();
  });

  test("shows nothing until clicked, then keeps it open until clicked again", async () => {
    render(
      <InfoHint label="About this setting">
        <p>What the setting does.</p>
      </InfoHint>,
    );
    const button = screen.getByRole("button", { name: "About this setting" });
    expect(screen.queryByRole("tooltip") === null).toBe(true);

    fireEvent.click(button);
    expect((await screen.findByRole("tooltip")).textContent).toContain("What the setting does.");
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
  });
  function mount() {
    render(<InfoHint label="About this setting">Explanation</InfoHint>);
    return screen.getByRole("button", { name: "About this setting" });
  }

  async function pointerClick(target: HTMLElement, pointerType = "mouse") {
    fireEvent.pointerDown(target, { pointerType });
    // DismissableLayer observes document pointerdown separately from click.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    fireEvent.pointerUp(target, { pointerType });
    fireEvent.click(target);
  }

  test.each(["mouse", "touch"])("a full %s sequence toggles a pinned hint off", async (type) => {
    const button = mount();
    await pointerClick(button, type);
    await screen.findByRole("tooltip");
    await pointerClick(button, type);
    await waitFor(() => expect(button.getAttribute("aria-expanded")).toBe("false"));
    expect(screen.queryByRole("tooltip") === null).toBe(true);
  });

  test("Escape dismisses a focused hint until focus leaves", async () => {
    const button = mount();
    fireEvent.focus(button);
    await screen.findByRole("tooltip");
    fireEvent.keyDown(button, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.blur(button);
    fireEvent.focus(button);
    await screen.findByRole("tooltip");
  });

  test("click-again and Escape dismiss while hovered, then hover can reopen", async () => {
    const button = mount();
    fireEvent.pointerMove(button, { pointerType: "mouse" });
    await screen.findByRole("tooltip");
    await pointerClick(button);
    await pointerClick(button);
    expect(screen.queryByRole("tooltip") === null).toBe(true);
    fireEvent.pointerMove(button, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip") === null).toBe(true);
    fireEvent.pointerLeave(button);
    fireEvent.pointerMove(button, { pointerType: "mouse" });
    await screen.findByRole("tooltip");
    fireEvent.keyDown(button, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
  });

  test("an outside pointer dismisses even while focus stays on the trigger", async () => {
    const button = mount();
    fireEvent.focus(button);
    await screen.findByRole("tooltip");
    await pointerClick(button);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await pointerClick(document.body);
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
    expect(button.className).toContain("focus-hairline");
  });
});
