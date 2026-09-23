import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { MultiReviewModelSelection } from "@orkestrator/protocol/multi-review";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { useConfigStore } from "@/stores/configStore";
import { MultiReviewRestartDialog } from "./MultiReviewRestartDialog";

const catalog: AgentModelCatalog = {
  claude: [{ id: "opus", name: "Opus", reasoningEfforts: ["high", "xhigh"] }],
  codex: [
    {
      id: "gpt-5.6",
      name: "GPT-5.6",
      reasoningEfforts: ["low", "medium", "high"],
      supportsSpeed: true,
    },
  ],
  opencode: [],
};

beforeEach(() => {
  const config = useConfigStore.getState().config;
  useConfigStore.setState({
    config: { ...config, global: { ...config.global, favoriteModels: [] } },
  });
});
afterEach(cleanup);

describe("MultiReviewRestartDialog", () => {
  test("selects a different provider, model, and effort for the restart", () => {
    const onSubmit = mock((_selection: MultiReviewModelSelection) => undefined);
    render(
      <MultiReviewRestartDialog
        open
        onOpenChange={() => undefined}
        kind="consolidate"
        catalog={catalog}
        defaultSelection={{ agent: "codex", model: "gpt-5.6", reasoningEffort: "high" }}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole("heading", { name: "Restart Consolidation" })).toBeTruthy();
    const picker = screen.getByRole("combobox", { name: "Restart consolidation model" });
    fireEvent.pointerDown(picker);
    fireEvent.click(screen.getByRole("button", { name: "claude models" }));
    fireEvent.keyDown(document.body, { key: "Escape" });

    fireEvent.pointerDown(picker);
    fireEvent.click(
      within(screen.getByRole("group", { name: "Reasoning" })).getByRole("menuitemradio", {
        name: "Extra high",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart Consolidation" }));

    expect(onSubmit).toHaveBeenCalledWith({
      agent: "claude",
      model: "opus",
      reasoningEffort: "xhigh",
    });
  });

  test("shows backend errors without dismissing the dialog", () => {
    render(
      <MultiReviewRestartDialog
        open
        onOpenChange={() => undefined}
        kind="fix"
        catalog={catalog}
        defaultSelection={{ agent: "codex", model: "gpt-5.6" }}
        error="The selected model is unavailable"
        onSubmit={() => undefined}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("The selected model is unavailable");
    expect(screen.getByRole("heading", { name: "Restart Fix" })).toBeTruthy();
  });
});
