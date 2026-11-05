import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
});
