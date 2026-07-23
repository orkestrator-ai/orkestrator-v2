import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  REVIEW_TAB_OPTIONS,
  ReviewLaunchDialog,
  getReviewAgent,
  type ReviewLaunchSelection,
  type ReviewModelCatalog,
} from "./ReviewLaunchDialog";

afterEach(cleanup);

const catalog: ReviewModelCatalog = {
  claude: [
    { id: "claude-a", name: "Claude A", reasoningEfforts: ["low", "high"] },
    { id: "claude-b", name: "Claude B", reasoningEfforts: ["xhigh"] },
  ],
  codex: [
    { id: "codex-a", name: "Codex A", reasoningEfforts: ["medium", "high"] },
  ],
  opencode: [
    { id: "provider/model-a", name: "OpenCode A", reasoningEfforts: ["fast", "deep"] },
  ],
};

describe("ReviewLaunchDialog", () => {
  test("exposes every launch type and confirms preferred defaults", () => {
    const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude-native"
        catalog={catalog}
        preferredModels={{ claude: "claude-b" }}
        preferredReasoningEfforts={{ claude: "xhigh" }}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Configure code review" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(REVIEW_TAB_OPTIONS.length);
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Claude B");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent).toContain("Extra high");

    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
      model: "claude-b",
      reasoningEffort: "xhigh",
    });
  });

  test("updates dependent model and effort choices when launch type and model change", async () => {
    const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude-cli"
        catalog={catalog}
        preferredModels={{ codex: "codex-a" }}
        preferredReasoningEfforts={{ codex: "high" }}
        onConfirm={onConfirm}
      />,
    );

    const modelSelect = screen.getByRole("combobox", { name: "Model" });
    fireEvent.keyDown(modelSelect, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: /Claude B/ }));
    expect(modelSelect.textContent).toContain("Claude B");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent).toContain("Default");

    fireEvent.click(screen.getByRole("radio", { name: /Codex Native/ }));
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Codex A");
    const effortSelect = screen.getByRole("combobox", { name: "Reasoning effort" });
    fireEvent.keyDown(effortSelect, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    await waitFor(() => expect(effortSelect.textContent).toContain("High"));

    fireEvent.click(screen.getByRole("radio", { name: /OpenCode CLI/ }));
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("OpenCode A");
    expect(
      (screen.getByRole("combobox", { name: "Reasoning effort" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "opencode-cli",
      model: "provider/model-a",
      reasoningEffort: undefined,
    });
  });

  test("resets selections each time it opens and closes from Cancel", () => {
    const onOpenChange = mock((_open: boolean) => undefined);

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Reopen</button>
          <ReviewLaunchDialog
            open={open}
            onOpenChange={(nextOpen) => {
              onOpenChange(nextOpen);
              setOpen(nextOpen);
            }}
            defaultTabType="claude-cli"
            catalog={catalog}
            onConfirm={() => undefined}
          />
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: /Codex CLI/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(screen.getByRole("radio", { name: /^Claude CLI/ }).getAttribute("aria-checked")).toBe("true");
  });

  test("falls back safely when an agent catalog is empty", () => {
    const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="opencode-native"
        catalog={{ ...catalog, opencode: [] }}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "opencode-native",
      model: "default",
      reasoningEffort: undefined,
    });
  });
});

test("getReviewAgent maps every public review tab option", () => {
  for (const option of REVIEW_TAB_OPTIONS) {
    expect(getReviewAgent(option.value)).toBe(option.agent);
  }
});
