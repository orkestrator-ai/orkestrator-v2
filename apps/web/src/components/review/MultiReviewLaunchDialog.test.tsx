import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentModelRef } from "@orkestrator/protocol/native-agent";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { useConfigStore } from "@/stores/configStore";
import {
  defaultMultiReviewLaunchSelection,
  MultiReviewLaunchDialog,
  type MultiReviewLaunchDefaults,
  type MultiReviewLaunchSelection,
} from "./MultiReviewLaunchDialog";

const catalog: AgentModelCatalog = {
  claude: [{ id: "opus", name: "Opus", reasoningEfforts: ["high"] }],
  codex: [
    { id: "gpt-5.6", name: "GPT-5.6", reasoningEfforts: ["low", "medium", "high"] },
    { id: "gpt-5.5", name: "GPT-5.5", reasoningEfforts: ["low", "medium", "high"] },
  ],
  opencode: [{ id: "provider/model", name: "OpenCode", reasoningEfforts: [] }],
  cursor: [{ id: "grok-4.6", name: "Grok 4.6", reasoningEfforts: [] }],
  pi: [{ id: "anthropic/claude-pi", name: "Claude Pi", reasoningEfforts: ["high"] }],
};

function setFavorites(favoriteModels: AgentModelRef[]) {
  const config = useConfigStore.getState().config;
  useConfigStore.setState({
    config: { ...config, global: { ...config.global, favoriteModels } },
  });
}

afterEach(cleanup);
beforeEach(() => setFavorites([]));

/** Opens `row`'s picker, switches to the favourites view, and picks a model. */
function chooseFavorite(row: string, name: RegExp) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `${row} model` }));
  fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "Models" })).getByRole("menuitemradio", { name }),
  );
}

describe("MultiReviewLaunchDialog", () => {
  test("adds and removes reviewer model rows while retaining at least one", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        onConfirm={onConfirm}
      />,
    );

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

  test("keeps added models and consolidation controls in the scroll region outside the footer", () => {
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        onConfirm={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add model" }));

    const scrollRegion = screen.getByRole("region", {
      name: "Multi Review model configuration",
    });
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(scrollRegion.contains(screen.getByLabelText("Reviewer 3 model"))).toBe(true);
    expect(scrollRegion.contains(screen.getByLabelText("Consolidation & fix model model"))).toBe(
      true,
    );
    expect(
      scrollRegion.contains(screen.getByRole("button", { name: "Start 3-model review" })),
    ).toBe(false);
    expect(scrollRegion.getAttribute("tabindex")).toBeNull();
  });

  test("lays reviewers out in two columns without dark wrapper cards", () => {
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        onConfirm={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add model" }));

    const grid = screen.getByRole("group", { name: "Reviewer models" });
    expect(grid.className).toContain("sm:grid-cols-2");

    const rows = Array.from(grid.querySelectorAll<HTMLElement>("[data-reviewer-model-row]"));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.contains(screen.getByLabelText("Reviewer 1 model"))).toBe(true);
    expect(rows[1]?.contains(screen.getByLabelText("Reviewer 2 model"))).toBe(true);
    expect(rows[2]?.contains(screen.getByLabelText("Reviewer 3 model"))).toBe(true);
    for (const row of rows) {
      expect(row.className).not.toContain("bg-zinc-950");
      expect(row.className).not.toContain("rounded-xl");
      expect(row.className).not.toContain("border-zinc-800");
    }

    const reviewerPicker = screen.getByLabelText("Reviewer 1 model");
    expect(reviewerPicker.className).toContain("md:max-w-none");
    expect(reviewerPicker.className).toContain("w-full");
  });

  test("disables every model control and guards dismissal and submission while busy", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(
      <MultiReviewLaunchDialog
        open
        busy
        onOpenChange={onOpenChange}
        defaultAgent="claude"
        catalog={catalog}
        onConfirm={onConfirm}
      />,
    );

    for (const name of [
      "Reviewer 1 model",
      "Reviewer 2 model",
      "Consolidation & fix model model",
    ]) {
      expect(screen.getByLabelText(name).closest("fieldset")?.disabled).toBe(true);
    }

    const startButton = screen.getByRole("button", { name: "Starting Multi Review…" });
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const form = startButton.closest("form")!;
    expect((startButton as HTMLButtonElement).disabled).toBe(true);
    expect((cancelButton as HTMLButtonElement).disabled).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");

    fireEvent.submit(form);
    fireEvent.click(cancelButton);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
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
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        preferredReasoningEfforts={{ codex: "high", cursor: "high" }}
        onConfirm={onConfirm}
      />,
    );

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

  test("seeds reviewer 2 and the fix model from their independent defaults", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        preferredModels={{ claude: "opus" }}
        preferredReasoningEfforts={{ claude: "high" }}
        secondReviewerDefaults={{
          defaultAgent: "codex",
          preferredModels: { codex: "gpt-5.6" },
          preferredReasoningEfforts: { codex: "medium" },
        }}
        fixModelDefaults={{
          defaultAgent: "opencode",
          preferredModels: { opencode: "provider/model" },
        }}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    expect(onConfirm.mock.calls[0]?.[0]).toEqual({
      reviewers: [
        { agent: "claude", model: "opus", reasoningEffort: "high" },
        { agent: "codex", model: "gpt-5.6", reasoningEffort: "medium" },
      ],
      fixModel: { agent: "opencode", model: "provider/model" },
    });
  });

  test("submits the same initial selection as the direct-launch helper", () => {
    const defaults: MultiReviewLaunchDefaults = {
      defaultAgent: "claude",
      catalog,
      preferredModels: { claude: "opus" },
      preferredReasoningEfforts: { claude: "high" },
      secondReviewerDefaults: {
        defaultAgent: "codex",
        preferredModels: { codex: "gpt-5.5" },
        preferredReasoningEfforts: { codex: "medium" },
      },
      fixModelDefaults: {
        defaultAgent: "opencode",
        preferredModels: { opencode: "provider/model" },
      },
    };
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        {...defaults}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));

    expect(onConfirm.mock.calls[0]?.[0]).toEqual(defaultMultiReviewLaunchSelection(defaults));
  });

  test("keeps each role's effort preferences when its model changes", () => {
    setFavorites([{ platform: "codex", modelId: "gpt-5.6" }]);
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        preferredReasoningEfforts={{ codex: "high" }}
        secondReviewerDefaults={{
          defaultAgent: "codex",
          preferredModels: { codex: "gpt-5.5" },
          preferredReasoningEfforts: { codex: "medium" },
        }}
        fixModelDefaults={{
          defaultAgent: "codex",
          preferredModels: { codex: "gpt-5.5" },
          preferredReasoningEfforts: { codex: "low" },
        }}
        onConfirm={onConfirm}
      />,
    );

    chooseFavorite("Reviewer 2", /GPT-5\.6/);
    chooseFavorite("Consolidation & fix model", /GPT-5\.6/);
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));

    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({
      reviewers: [
        { agent: "claude", model: "opus" },
        { agent: "codex", model: "gpt-5.6", reasoningEffort: "medium" },
      ],
      fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "low" },
    });
  });

  test("uses Review defaults for added rows and preserves them when rows are renumbered", () => {
    setFavorites([{ platform: "codex", modelId: "gpt-5.6" }]);
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        preferredReasoningEfforts={{ codex: "high" }}
        secondReviewerDefaults={{
          defaultAgent: "codex",
          preferredModels: { codex: "gpt-5.5" },
          preferredReasoningEfforts: { codex: "medium" },
        }}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove reviewer 1" }));
    // The added row is now Reviewer 2, but it remains a Review-default row.
    chooseFavorite("Reviewer 1", /GPT-5\.6/);
    chooseFavorite("Reviewer 2", /GPT-5\.6/);
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));

    expect(onConfirm.mock.calls[0]?.[0].reviewers).toEqual([
      { agent: "codex", model: "gpt-5.6", reasoningEffort: "medium" },
      { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
    ]);
  });

  test("includes Pi models in the cross-provider favourites catalog", () => {
    setFavorites([{ platform: "pi", modelId: "anthropic/claude-pi" }]);
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        preferredReasoningEfforts={{ pi: "high" }}
        onConfirm={onConfirm}
      />,
    );

    chooseFavorite("Reviewer 1", /Claude Pi/);
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));

    expect(onConfirm.mock.calls[0]?.[0].reviewers[0]).toEqual({
      agent: "pi",
      model: "anthropic/claude-pi",
      reasoningEffort: "high",
    });
  });

  /**
   * The consolidation row runs the deduplication turn and stays attached as the
   * interactive fix session, so a favourite from another provider strands the
   * whole workflow there — not just one reviewer's report — if the row keeps its
   * old agent.
   */
  test("adopts the platform of a favourite chosen for the consolidation row", () => {
    setFavorites([{ platform: "codex", modelId: "gpt-5.6" }]);
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        preferredReasoningEfforts={{ codex: "medium" }}
        onConfirm={onConfirm}
      />,
    );

    chooseFavorite("Consolidation & fix model", /GPT-5\.6/);

    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    expect(onConfirm.mock.calls[0]?.[0]).toEqual({
      reviewers: [
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "opus" },
      ],
      fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "medium" },
    });
  });

  /**
   * Switching provider on the rail used to clear the effort to `undefined`,
   * which silently dropped the configured Codex effort that `initialRow` would
   * have applied had the dialog opened on Codex. Both entry points must agree.
   */
  test("applies the configured effort when the provider rail switches platform", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    render(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        preferredReasoningEfforts={{ codex: "high" }}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Reviewer 1 model" }));
    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    // Picking a provider only switches the catalog view, so the menu stays open
    // and keeps the rest of the dialog `aria-hidden`. Dismiss it before
    // submitting.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    expect(onConfirm.mock.calls[0]?.[0]).toEqual({
      reviewers: [
        { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
        { agent: "claude", model: "opus" },
      ],
      fixModel: { agent: "claude", model: "opus" },
    });
  });
});
