import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  approvalModeIconOption,
  ComposerIconPicker,
  conversationModeIconOption,
} from "./ComposerIconPicker";

describe("ComposerIconPicker", () => {
  afterEach(cleanup);

  test("shows only the selected icon until opened, then every choice with its name", async () => {
    const onValueChange = mock((_id: string) => {});
    render(
      <ComposerIconPicker
        label="Mode"
        options={[
          conversationModeIconOption("build", "Build"),
          conversationModeIconOption("plan", "Plan"),
        ]}
        value="plan"
        onValueChange={onValueChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Mode: Plan" });
    expect(trigger.textContent).toBe("");
    expect(trigger.querySelector("svg")?.getAttribute("class")).toContain("text-green-500");

    fireEvent.pointerDown(trigger);
    const build = await screen.findByRole("menuitemradio", { name: "Build" });
    expect(build.querySelector("svg")?.getAttribute("class")).toContain("text-yellow-500");
    expect(screen.getByRole("menuitemradio", { name: "Plan" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(build);
    expect(onValueChange).toHaveBeenCalledWith("build");
  });

  test("lists approval modes the policy disallows as disabled", async () => {
    render(
      <ComposerIconPicker
        label="Approvals"
        options={[
          approvalModeIconOption({
            id: "default",
            label: "Ask",
            description: "Ask first",
            kind: "ask",
          }),
          approvalModeIconOption({
            id: "bypassPermissions",
            label: "Bypass",
            description: "Approve everything",
            kind: "auto-approve",
            disabled: true,
          }),
        ]}
        value="default"
        onValueChange={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Approvals: Ask" }));
    const bypass = await screen.findByRole("menuitemradio", { name: "Bypass" });
    expect(bypass.getAttribute("aria-disabled")).toBe("true");
  });
});
