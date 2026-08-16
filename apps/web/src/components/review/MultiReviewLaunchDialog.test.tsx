import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentModelRef } from "@orkestrator/protocol/native-agent";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { useConfigStore } from "@/stores/configStore";
import { MultiReviewLaunchDialog, type MultiReviewLaunchSelection } from "./MultiReviewLaunchDialog";

const catalog: AgentModelCatalog = {
  claude: [{ id: "opus", name: "Opus", reasoningEfforts: ["high"] }],
  codex: [{ id: "gpt-5.6", name: "GPT-5.6", reasoningEfforts: ["medium", "high"] }],
  opencode: [{ id: "provider/model", name: "OpenCode", reasoningEfforts: [] }],
  cursor: [{ id: "grok-4.6", name: "Grok 4.6", reasoningEfforts: [] }],
};

function setFavorites(favoriteModels: AgentModelRef[]) {
  const config = useConfigStore.getState().config;
  useConfigStore.setState({
    config: { ...config, global: { ...config.global, favoriteModels } },
  });
}

afterEach(cleanup);
beforeEach(() => setFavorites([]));

describe("MultiReviewLaunchDialog", () => {
  test("adds and removes reviewer model rows while retaining at least one", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(<MultiReviewLaunchDialog
      open
      onOpenChange={() => undefined}
      defaultAgent="claude"
      catalog={catalog}
      onConfirm={onConfirm}
    />);

    expect(screen.getByLabelText("Reviewer 1 model")).toBeTruthy();
    expect(screen.getByLabelText("Reviewer 2 model")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    expect(screen.getByLabelText("Reviewer 3 model")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove reviewer 2" }));
    expect(screen.queryByLabelText("Reviewer 3 model") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({
      reviewers: [
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "opus" },
      ],
      fixModel: { agent: "claude", model: "opus" },
    });
  });

  /**
   * The favourites view mixes every platform's models into one list, so a row
   * chosen there routinely belongs to a platform other than the row's current
   * one. Each reviewer has to adopt that platform, or the launch sends a Codex
   * or Cursor model id to Claude and the session fails on start.
   */
  test("adopts the platform of a favourite chosen from another provider", () => {
    setFavorites([
      { platform: "codex", modelId: "gpt-5.6" },
      { platform: "cursor", modelId: "grok-4.6" },
    ]);
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(<MultiReviewLaunchDialog
      open
      onOpenChange={() => undefined}
      defaultAgent="claude"
      catalog={catalog}
      preferredReasoningEfforts={{ codex: "high", cursor: "high" }}
      onConfirm={onConfirm}
    />);

    const chooseFavorite = (row: string, name: RegExp) => {
      fireEvent.pointerDown(screen.getByRole("button", { name: `${row} model` }));
      fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
      fireEvent.click(
        within(screen.getByRole("group", { name: "Models" })).getByRole("menuitemradio", { name }),
      );
    };
    chooseFavorite("Reviewer 1", /GPT-5\.6/);
    chooseFavorite("Reviewer 2", /Grok 4\.6/);

    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    expect(onConfirm.mock.calls[0]?.[0]).toEqual({
      reviewers: [
        { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
        { agent: "cursor", model: "grok-4.6" },
      ],
      fixModel: { agent: "claude", model: "opus" },
    });
  });
});
