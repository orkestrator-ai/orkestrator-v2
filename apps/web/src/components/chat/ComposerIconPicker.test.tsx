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

  test("names a mode that skips asking in words, and only that one", () => {
    const options = [
      approvalModeIconOption({ id: "default", label: "Ask", kind: "ask" }),
      approvalModeIconOption({ id: "bypassPermissions", label: "Bypass", kind: "auto-approve" }),
    ];
    const { rerender } = render(
      <ComposerIconPicker
        label="Approvals"
        options={options}
        value="default"
        onValueChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Approvals: Ask" }).textContent).toBe("");

    rerender(
      <ComposerIconPicker
        label="Approvals"
        options={options}
        value="bypassPermissions"
        onValueChange={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Approvals: Bypass" });
    expect(trigger.textContent).toBe("Bypass");
    expect(trigger.querySelector("svg")?.getAttribute("class")).toContain("text-red-500");
  });

  test("states the shortcut that cycles it", () => {
    render(
      <ComposerIconPicker
        label="Mode"
        shortcut="Shift+Tab"
        options={[conversationModeIconOption("build", "Build")]}
        value="build"
        onValueChange={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Mode: Build" });
    expect(trigger.getAttribute("aria-keyshortcuts")).toBe("Shift+Tab");
    expect(trigger.getAttribute("title")).toContain("Shift+Tab");
  });
});
