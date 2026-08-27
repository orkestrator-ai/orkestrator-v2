import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { MultiReviewModelSelection } from "@orkestrator/protocol/multi-review";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { useConfigStore } from "@/stores/configStore";
import {
  DEFAULT_MULTI_REVIEW_FIX_PROMPT,
  MultiReviewFixPromptDialog,
} from "./MultiReviewFixPromptDialog";

const catalog: AgentModelCatalog = {
  claude: [{ id: "opus", name: "Opus", reasoningEfforts: ["high", "xhigh"] }],
  codex: [
    { id: "gpt-5.6", name: "GPT-5.6", reasoningEfforts: ["low", "medium", "high"] },
    { id: "gpt-5.4", name: "GPT-5.4", reasoningEfforts: ["low", "medium", "high"] },
  ],
  opencode: [{ id: "provider/model", name: "OpenCode", reasoningEfforts: [] }],
};

function setFavoritesEmpty() {
  const config = useConfigStore.getState().config;
  useConfigStore.setState({
    config: { ...config, global: { ...config.global, favoriteModels: [] } },
  });
}

function renderDialog(overrides: Partial<Parameters<typeof MultiReviewFixPromptDialog>[0]> = {}) {
  const onSubmit = mock((_selection: MultiReviewModelSelection, _prompt: string) => undefined);
  const props = {
    open: true,
    onOpenChange: () => undefined,
    catalog,
    defaultSelection: {
      agent: "codex" as const,
      model: "gpt-5.6",
      reasoningEffort: "high",
    },
    onSubmit,
    ...overrides,
  };
  return { onSubmit, props, view: render(<MultiReviewFixPromptDialog {...props} />) };
}

afterEach(cleanup);
beforeEach(setFavoritesEmpty);

describe("MultiReviewFixPromptDialog", () => {
  test("submits a cross-provider model and manually selected effort", () => {
    const { onSubmit } = renderDialog();
    const picker = screen.getByRole("combobox", { name: "Custom fix model" });

    fireEvent.pointerDown(picker);
    fireEvent.click(screen.getByRole("button", { name: "claude models" }));
    fireEvent.keyDown(document.body, { key: "Escape" });

    fireEvent.pointerDown(picker);
    const reasoning = within(screen.getByRole("group", { name: "Reasoning" }));
    fireEvent.click(reasoning.getByRole("menuitemradio", { name: "Extra high" }));
    fireEvent.click(screen.getByRole("button", { name: "Start fix" }));

    expect(onSubmit).toHaveBeenCalledWith(
      { agent: "claude", model: "opus", reasoningEffort: "xhigh" },
      DEFAULT_MULTI_REVIEW_FIX_PROMPT,
    );
  });

  test("falls back from a retired model to a catalog model with supported efforts", () => {
    const { onSubmit } = renderDialog({
      defaultSelection: { agent: "codex", model: "retired-model", reasoningEffort: "high" },
    });
    const picker = screen.getByRole("combobox", { name: "Custom fix model" });

    expect(picker.textContent).toContain("GPT-5.6");
    expect(picker.textContent).toContain("high");
    fireEvent.pointerDown(picker);
    expect(
      within(screen.getByRole("group", { name: "Reasoning" })).getByRole("menuitemradio", {
        name: "Low",
      }),
    ).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Start fix" }));
    expect(onSubmit).toHaveBeenCalledWith(
      { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
      DEFAULT_MULTI_REVIEW_FIX_PROMPT,
    );
  });

  test("resets edited prompt and selection whenever the dialog reopens", () => {
    const { props, view } = renderDialog();
    const prompt = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "Only fix the regression" } });

    const picker = screen.getByRole("combobox", { name: "Custom fix model" });
    fireEvent.pointerDown(picker);
    fireEvent.click(screen.getByRole("button", { name: "claude models" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(picker.textContent).toContain("Opus");

    view.rerender(<MultiReviewFixPromptDialog {...props} open={false} />);
    view.rerender(<MultiReviewFixPromptDialog {...props} open />);

    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
      DEFAULT_MULTI_REVIEW_FIX_PROMPT,
    );
    expect(screen.getByRole("combobox", { name: "Custom fix model" }).textContent).toContain(
      "GPT-5.6",
    );
  });

  test("does not submit a blank prompt", () => {
    const { onSubmit } = renderDialog();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "   " } });

    const start = screen.getByRole("button", { name: "Start fix" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.submit(start.closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
