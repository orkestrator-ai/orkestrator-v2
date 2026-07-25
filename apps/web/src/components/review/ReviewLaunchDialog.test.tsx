import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import {
  REVIEW_TAB_OPTIONS,
  ReviewLaunchDialog,
  getReviewAgent,
  type ReviewLaunchSelection,
  type ReviewModelCatalog,
  type ReviewTabType,
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

const describedCatalog: ReviewModelCatalog = {
  ...catalog,
  claude: [
    {
      id: "claude-a",
      name: "Claude A",
      description: "Fast general-purpose reviews",
      reasoningEfforts: ["low", "high"],
    },
    {
      id: "claude-b",
      name: "Claude B",
      description: "Extended reasoning for complex changes",
      reasoningEfforts: ["xhigh"],
    },
    {
      id: "claude-c",
      name: "Claude C",
      reasoningEfforts: [],
    },
  ],
};

describe("ReviewLaunchDialog", () => {
  test("separates providers from their modes and confirms preferred defaults", () => {
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
    expect(
      within(screen.getByRole("radiogroup", { name: "Review provider" })).getAllByRole("radio"),
    ).toHaveLength(3);
    expect(
      within(screen.getByRole("radiogroup", { name: "Claude mode" })).getAllByRole("radio"),
    ).toHaveLength(3);
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

    fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Codex A");
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Codex mode" })).getByRole("radio", {
        name: /^Native/,
      }),
    );
    const effortSelect = screen.getByRole("combobox", { name: "Reasoning effort" });
    fireEvent.keyDown(effortSelect, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    await waitFor(() => expect(effortSelect.textContent).toContain("High"));

    fireEvent.click(screen.getByRole("radio", { name: "OpenCode" }));
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "OpenCode mode" })).getByRole("radio", {
        name: /^CLI/,
      }),
    );
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
    fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    const claudeRadio = screen.getByRole("radio", { name: "Claude" }) as HTMLInputElement;
    const cliRadio =
      within(screen.getByRole("radiogroup", { name: "Claude mode" }))
        .getByRole("radio", { name: /^CLI/ }) as HTMLInputElement;
    expect(claudeRadio.checked).toBe(true);
    expect(cliRadio.checked).toBe(true);
  });

  test("uses roving focus and arrow-key selection in the provider and mode radio groups", () => {
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude-cli"
        catalog={catalog}
        onConfirm={() => undefined}
      />,
    );

    const providerGroup = screen.getByRole("radiogroup", { name: "Review provider" });
    const claudeRadio = within(providerGroup).getByRole("radio", { name: "Claude" });
    const codexRadio = within(providerGroup).getByRole("radio", { name: "Codex" });
    const openCodeRadio = within(providerGroup).getByRole("radio", { name: "OpenCode" });
    expect(claudeRadio.tabIndex).toBe(0);
    expect(codexRadio.tabIndex).toBe(-1);

    claudeRadio.focus();
    fireEvent.keyDown(claudeRadio, { key: "ArrowDown" });

    expect(document.activeElement).toBe(codexRadio);
    expect((codexRadio as HTMLInputElement).checked).toBe(true);
    expect(codexRadio.tabIndex).toBe(0);
    expect(claudeRadio.tabIndex).toBe(-1);

    fireEvent.keyDown(codexRadio, { key: "End" });
    expect(document.activeElement).toBe(openCodeRadio);
    expect((openCodeRadio as HTMLInputElement).checked).toBe(true);

    fireEvent.keyDown(openCodeRadio, { key: "Home" });
    expect(document.activeElement).toBe(claudeRadio);
    expect((claudeRadio as HTMLInputElement).checked).toBe(true);

    fireEvent.keyDown(claudeRadio, { key: "ArrowUp" });
    expect(document.activeElement).toBe(openCodeRadio);
    fireEvent.keyDown(openCodeRadio, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(codexRadio);
    expect((codexRadio as HTMLInputElement).checked).toBe(true);

    const modeGroup = screen.getByRole("radiogroup", { name: "Codex mode" });
    const cliRadio = within(modeGroup).getByRole("radio", { name: /^CLI/ });
    const nativeRadio = within(modeGroup).getByRole("radio", { name: /^Native/ });
    cliRadio.focus();
    fireEvent.keyDown(cliRadio, { key: "ArrowRight" });

    expect(document.activeElement).toBe(nativeRadio);
    expect((nativeRadio as HTMLInputElement).checked).toBe(true);
    expect(nativeRadio.tabIndex).toBe(0);
    expect(cliRadio.tabIndex).toBe(-1);
  });

  test("keeps a compatible mode when the provider changes and falls back when needed", () => {
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude-native"
        catalog={catalog}
        onConfirm={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(screen.getByText("Codex Native · Codex A · default effort")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Claude" }));
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Claude mode" })).getByRole("radio", {
        name: /^Tmux/,
      }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "OpenCode" }));
    expect(screen.getByText("OpenCode CLI · OpenCode A · default effort")).toBeTruthy();
  });

  test("keeps the configuration scrollable within the viewport with actions outside the scroll region", () => {
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude-cli"
        catalog={catalog}
        onConfirm={() => undefined}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Configure code review" });
    const scrollRegion = screen.getByRole("region", { name: "Review configuration" });
    const providerModeGroup = screen.getByRole("group", { name: "Provider and mode" });

    expect(dialog.className).toContain("max-h-[calc(100dvh-1rem)]");
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(providerModeGroup.className).toContain("grid-cols-[");
    expect(scrollRegion.contains(screen.getByRole("button", { name: "OK" }))).toBe(false);
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

  test("shows model descriptions in the trigger and menu and omits them when absent", () => {
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude-cli"
        catalog={describedCatalog}
        onConfirm={() => undefined}
      />,
    );

    const modelSelect = screen.getByRole("combobox", { name: "Model" });
    expect(modelSelect.textContent).toContain("Claude A");
    expect(modelSelect.textContent).toContain("Fast general-purpose reviews");

    fireEvent.keyDown(modelSelect, { key: "Enter" });
    const describedOption = screen.getByRole("option", { name: /Claude B/ });
    expect(describedOption.textContent).toContain("Extended reasoning for complex changes");
    fireEvent.click(describedOption);
    expect(modelSelect.textContent).toContain("Claude B");
    expect(modelSelect.textContent).toContain("Extended reasoning for complex changes");
    expect(modelSelect.textContent).not.toContain("Fast general-purpose reviews");

    fireEvent.keyDown(modelSelect, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Claude C" }));
    expect(modelSelect.textContent).toBe("Claude C");
  });

  test("ignores stale preferred model and effort values and submits default effort as undefined", () => {
    const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude-native"
        catalog={catalog}
        preferredModels={{ claude: "retired-model" }}
        preferredReasoningEfforts={{ claude: "unsupported-effort" }}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Claude A");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent).toContain("Default");

    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
      model: "claude-a",
      reasoningEffort: undefined,
    });
  });

  test("reconciles the model and effort when the open dialog receives a new catalog", async () => {
    const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
    const props = {
      open: true,
      onOpenChange: () => undefined,
      defaultTabType: "claude-cli" as const,
      onConfirm,
    };
    const { rerender } = render(<ReviewLaunchDialog {...props} catalog={catalog} />);

    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Claude A");
    const effortSelect = screen.getByRole("combobox", { name: "Reasoning effort" });
    fireEvent.keyDown(effortSelect, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    await waitFor(() => expect(effortSelect.textContent).toContain("High"));

    const updatedCatalog: ReviewModelCatalog = {
      ...catalog,
      claude: [
        {
          id: "claude-new",
          name: "Claude New",
          description: "Current catalog model",
          reasoningEfforts: ["medium"],
        },
      ],
    };
    rerender(<ReviewLaunchDialog {...props} catalog={updatedCatalog} />);

    const modelSelect = screen.getByRole("combobox", { name: "Model" });
    await waitFor(() => {
      expect(modelSelect.textContent).toContain("Claude New");
      expect(modelSelect.textContent).toContain("Current catalog model");
      expect(effortSelect.textContent).toContain("Default");
    });
    expect(screen.getByText("Claude CLI · Claude New · default effort")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-cli",
      model: "claude-new",
      reasoningEffort: undefined,
    });
  });

  test("disables reasoning and explains the default for a model without effort options", () => {
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude-cli"
        catalog={{
          ...catalog,
          claude: [{ id: "claude-simple", name: "Claude Simple", reasoningEfforts: [] }],
        }}
        onConfirm={() => undefined}
      />,
    );

    expect(
      (screen.getByRole("combobox", { name: "Reasoning effort" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("This model uses its default reasoning setting.")).toBeTruthy();
    expect(screen.getByText("Claude CLI · Claude Simple · default effort")).toBeTruthy();
  });

  test("updates the launch summary after model, effort, and tab changes", async () => {
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude-cli"
        catalog={catalog}
        onConfirm={() => undefined}
      />,
    );

    expect(screen.getByText("Claude CLI · Claude A · default effort")).toBeTruthy();

    const modelSelect = screen.getByRole("combobox", { name: "Model" });
    fireEvent.keyDown(modelSelect, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Claude B" }));
    expect(screen.getByText("Claude CLI · Claude B · default effort")).toBeTruthy();

    const effortSelect = screen.getByRole("combobox", { name: "Reasoning effort" });
    fireEvent.keyDown(effortSelect, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Extra high" }));
    await waitFor(() =>
      expect(screen.getByText("Claude CLI · Claude B · xhigh effort")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("radio", { name: "OpenCode" }));
    expect(screen.getByText("OpenCode CLI · OpenCode A · default effort")).toBeTruthy();
  });
});

test("getReviewAgent maps every public review tab option", () => {
  for (const option of REVIEW_TAB_OPTIONS) {
    expect(getReviewAgent(option.value)).toBe(option.agent);
  }

  expect(getReviewAgent("invalid-review-tab" as ReviewTabType)).toBe("claude");
});
