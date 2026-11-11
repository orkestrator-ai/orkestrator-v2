import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { AgentModelRef } from "@orkestrator/protocol/native-agent";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { configStore } from "@/stores/configStore";
import type { GlobalConfig } from "@/types";
import { SHIPPED_REVIEW_LENS_PRESETS } from "@orkestrator/protocol/review-lens";
import {
  defaultMultiReviewLaunchSelection,
  flatCatalog,
  MultiReviewLaunchDialog,
  type MultiReviewLaunchDefaults,
  type MultiReviewLaunchSelection,
} from "./MultiReviewLaunchDialog";
import { appCommandStore } from "@/test/app-command-store";

const catalog: AgentModelCatalog = {
  claude: [{ id: "opus", name: "Opus", reasoningEfforts: ["high"] }],
  codex: [
    { id: "gpt-5.6", name: "GPT-5.6", reasoningEfforts: ["low", "medium", "high"] },
    { id: "gpt-5.5", name: "GPT-5.5", reasoningEfforts: ["low", "medium", "high"] },
  ],
  opencode: [
    {
      id: "provider/model",
      name: "OpenCode",
      providerLabel: "Provider Cloud",
      reasoningEfforts: [],
    },
  ],
  cursor: [{ id: "grok-4.6", name: "Grok 4.6", reasoningEfforts: [] }],
  pi: [{ id: "anthropic/claude-pi", name: "Claude Pi", reasoningEfforts: ["high"] }],
};

/** Opus carries a speed axis; the OpenCode entry's platform owns none. */
const speedCatalog: AgentModelCatalog = {
  ...catalog,
  claude: [{ id: "opus", name: "Opus", reasoningEfforts: ["high"], supportsSpeed: true }],
};

function setFavorites(favoriteModels: AgentModelRef[]) {
  const config = appCommandStore(configStore).getState().config;
  appCommandStore(configStore).setState({
    config: { ...config, global: { ...config.global, favoriteModels } },
  });
}

afterEach(cleanup);
beforeEach(() => setFavorites([]));

/** The picker stays open after a choice, so helpers dismiss it explicitly. */
function closePicker() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

/** Opens `row`'s picker, switches to the favourites view, and picks a model. */
function chooseFavorite(row: string, name: RegExp) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `${row} model` }));
  fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "Models" })).getByRole("menuitemradio", { name }),
  );
  closePicker();
}

/** Opens `row`'s picker and chooses a Fast/Normal option. */
function chooseSpeed(row: string, name: RegExp) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `${row} model` }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "Speed mode" })).getByRole("menuitemradio", { name }),
  );
  closePicker();
}

describe("MultiReviewLaunchDialog speed", () => {
  test("carries each row's Fast choice independently into the launch", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={speedCatalog}
        onConfirm={onConfirm}
      />,
    );

    chooseSpeed("Reviewer 1", /Fast/);
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));

    const selection = onConfirm.mock.calls[0]![0];
    expect(selection.reviewers[0]).toMatchObject({ agent: "claude", fastMode: true });
    // Reviewer 2 was never touched, so it must not inherit the choice.
    expect(selection.reviewers[1]).not.toHaveProperty("fastMode");
  });

  test("seeds every row, including the Address Findings model, from the configured speed", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={speedCatalog}
        preferredFastModes={{ claude: true }}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));

    const selection = onConfirm.mock.calls[0]![0];
    expect(selection.reviewers.every((reviewer) => reviewer.fastMode === true)).toBe(true);
    expect(selection.reviewModel.fastMode).toBe(true);
    expect(selection.fixModel.fastMode).toBe(true);
  });

  test("omits speed from the opening selection when nothing configures it", () => {
    const defaults: MultiReviewLaunchDefaults = {
      defaultAgent: "claude",
      catalog: speedCatalog,
    };

    expect(defaultMultiReviewLaunchSelection(defaults).reviewers[0]).not.toHaveProperty("fastMode");
  });

  test("omits speed on a platform that owns no speed surface", () => {
    expect(
      defaultMultiReviewLaunchSelection({
        defaultAgent: "opencode",
        catalog: speedCatalog,
        preferredFastModes: { opencode: true },
      }).reviewers[0],
    ).not.toHaveProperty("fastMode");
  });
});

describe("MultiReviewLaunchDialog", () => {
  test("preserves and renders OpenCode provider captions", () => {
    expect(
      flatCatalog(catalog).find(
        (model) => model.platform === "opencode" && model.id === "provider/model",
      )?.providerLabel,
    ).toBe("Provider Cloud");

    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="opencode"
        catalog={catalog}
        onConfirm={() => undefined}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Reviewer 1 model" }));
    const row = within(screen.getByRole("group", { name: "Models" })).getByRole("menuitemradio", {
      name: /OpenCode/,
    });
    expect(row.textContent).toContain("Provider Cloud");
  });

  test("does not offer Auto-pipeline: turning a tab into a pipeline is the toolbar's To pipeline button", () => {
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        onConfirm={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Auto-pipeline" }) === null).toBe(true);
    expect(screen.queryByRole("combobox", { name: "Build transcript" }) === null).toBe(true);
  });

  test("adds and removes reviewer model rows while retaining at least one", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
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
      reviewModel: { agent: "claude", model: "opus" },
      fixModel: { agent: "claude", model: "opus" },
    });
  });

  test("keeps added models and consolidation controls in the scroll region outside the footer", () => {
    renderInAppCommandScope(
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
    expect(
      scrollRegion.contains(screen.getByLabelText("Preparation & consolidation model model")),
    ).toBe(true);
    expect(scrollRegion.contains(screen.getByLabelText("Address Findings model model"))).toBe(true);
    expect(
      scrollRegion.contains(screen.getByRole("button", { name: "Start 3-model review" })),
    ).toBe(false);
    expect(scrollRegion.getAttribute("tabindex")).toBeNull();
  });

  test("lays reviewers out in two columns without dark wrapper cards", () => {
    renderInAppCommandScope(
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
    renderInAppCommandScope(
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
      "Preparation & consolidation model model",
      "Address Findings model model",
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
    renderInAppCommandScope(
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
      autoFix: false,
      autoPr: false,
      reviewers: [
        { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
        { agent: "cursor", model: "grok-4.6" },
      ],
      reviewModel: { agent: "claude", model: "opus" },
      fixModel: { agent: "claude", model: "opus" },
    });
  });

  test("seeds reviewer 2, review preparation, and fix from independent defaults", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
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
        reviewModelDefaults={{
          defaultAgent: "codex",
          preferredModels: { codex: "gpt-5.5" },
          preferredReasoningEfforts: { codex: "low" },
        }}
        addressFindingsModelDefaults={{
          defaultAgent: "opencode",
          preferredModels: { opencode: "provider/model" },
        }}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    expect(onConfirm.mock.calls[0]?.[0]).toEqual({
      autoFix: false,
      autoPr: false,
      reviewers: [
        { agent: "claude", model: "opus", reasoningEffort: "high" },
        { agent: "codex", model: "gpt-5.6", reasoningEffort: "medium" },
      ],
      reviewModel: { agent: "codex", model: "gpt-5.5", reasoningEffort: "low" },
      fixModel: { agent: "opencode", model: "provider/model" },
    });
  });

  test("uses the full configured reviewer list for direct and configured launches", () => {
    const defaults: MultiReviewLaunchDefaults = {
      defaultAgent: "claude",
      catalog,
      reviewerDefaults: [
        { defaultAgent: "claude", preferredModels: { claude: "opus" } },
        { defaultAgent: "codex", preferredModels: { codex: "gpt-5.6" } },
        {
          defaultAgent: "codex",
          preferredModels: { codex: "gpt-5.5" },
          preferredReasoningEfforts: { codex: "high" },
        },
      ],
    };
    const expected = defaultMultiReviewLaunchSelection(defaults);
    expect(expected.reviewers).toEqual([
      { agent: "claude", model: "opus" },
      { agent: "codex", model: "gpt-5.6" },
      { agent: "codex", model: "gpt-5.5", reasoningEffort: "high" },
    ]);

    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        {...defaults}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByLabelText("Reviewer 3 model").textContent).toContain("GPT-5.5");
    fireEvent.click(screen.getByRole("button", { name: "Start 3-model review" }));
    expect(onConfirm.mock.calls[0]?.[0]).toEqual(expected);
  });

  test("treats a supplied reviewer list as exact at the one and empty boundaries", () => {
    expect(
      defaultMultiReviewLaunchSelection({
        defaultAgent: "claude",
        catalog,
        reviewerDefaults: [{ defaultAgent: "codex", preferredModels: { codex: "gpt-5.6" } }],
      }).reviewers,
    ).toEqual([{ agent: "codex", model: "gpt-5.6" }]);

    expect(
      defaultMultiReviewLaunchSelection({
        defaultAgent: "claude",
        catalog,
        reviewerDefaults: [],
      }).reviewers,
    ).toEqual([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "opus" },
    ]);
  });

  test("synthesizes a configured OpenCode model for an additional reviewer", () => {
    const selection = defaultMultiReviewLaunchSelection({
      defaultAgent: "claude",
      catalog: {
        ...catalog,
        opencode: [{ id: "default", name: "Default", reasoningEfforts: [] }],
      },
      reviewerDefaults: [
        { defaultAgent: "claude", preferredModels: { claude: "opus" } },
        { defaultAgent: "codex", preferredModels: { codex: "gpt-5.6" } },
        {
          defaultAgent: "opencode",
          preferredModels: { opencode: "provider/repository-cached-reviewer-3" },
          preferredReasoningEfforts: { opencode: "high" },
        },
      ],
    });

    expect(selection.reviewers[2]).toEqual({
      agent: "opencode",
      model: "provider/repository-cached-reviewer-3",
      reasoningEffort: "high",
    });
  });

  test("pins Fast independently on consolidation and each reviewer", () => {
    const selection = defaultMultiReviewLaunchSelection({
      defaultAgent: "claude",
      catalog: speedCatalog,
      preferredFastModes: { claude: true },
      reviewerDefaults: [
        {
          defaultAgent: "claude",
          preferredModels: { claude: "opus" },
          preferredFastModes: { claude: true },
        },
        {
          defaultAgent: "claude",
          preferredModels: { claude: "opus" },
          preferredFastModes: { claude: false },
        },
      ],
      reviewModelDefaults: {
        defaultAgent: "claude",
        preferredModels: { claude: "opus" },
        preferredFastModes: { claude: false },
      },
      addressFindingsModelDefaults: {
        defaultAgent: "claude",
        preferredModels: { claude: "opus" },
        preferredFastModes: { claude: true },
      },
    });

    expect(selection.reviewers[0]).toMatchObject({ agent: "claude", fastMode: true });
    expect(selection.reviewers[1]).toMatchObject({ agent: "claude", fastMode: false });
    expect(selection.reviewModel).toMatchObject({ agent: "claude", fastMode: false });
    expect(selection.fixModel).toMatchObject({ agent: "claude", fastMode: true });
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
      addressFindingsModelDefaults: {
        defaultAgent: "opencode",
        preferredModels: { opencode: "provider/model" },
      },
    };
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
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
    renderInAppCommandScope(
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
        addressFindingsModelDefaults={{
          defaultAgent: "codex",
          preferredModels: { codex: "gpt-5.5" },
          preferredReasoningEfforts: { codex: "low" },
        }}
        onConfirm={onConfirm}
      />,
    );

    chooseFavorite("Reviewer 2", /GPT-5\.6/);
    chooseFavorite("Address Findings model", /GPT-5\.6/);
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));

    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({
      reviewers: [
        { agent: "claude", model: "opus" },
        { agent: "codex", model: "gpt-5.6", reasoningEffort: "medium" },
      ],
      reviewModel: { agent: "claude", model: "opus" },
      fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "low" },
    });
  });

  test("uses Review defaults for added rows and preserves them when rows are renumbered", () => {
    setFavorites([{ platform: "codex", modelId: "gpt-5.6" }]);
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
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
    renderInAppCommandScope(
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

  /** The coordinator row owns both package preparation and consolidation. */
  test("adopts the platform of a favourite chosen for the consolidation row", () => {
    setFavorites([{ platform: "codex", modelId: "gpt-5.6" }]);
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        preferredReasoningEfforts={{ codex: "medium" }}
        onConfirm={onConfirm}
      />,
    );

    chooseFavorite("Preparation & consolidation model", /GPT-5\.6/);

    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    expect(onConfirm.mock.calls[0]?.[0]).toEqual({
      autoFix: false,
      autoPr: false,
      reviewers: [
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "opus" },
      ],
      reviewModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "medium" },
      fixModel: { agent: "claude", model: "opus" },
    });
  });

  /**
   * Switching provider on the rail used to clear the effort to `undefined`,
   * which silently dropped the configured Codex effort that `initialRow` would
   * have applied had the dialog opened on Codex. Both entry points must agree.
   */
  test("applies the configured effort when the provider rail switches platform", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
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
      autoFix: false,
      autoPr: false,
      reviewers: [
        { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
        { agent: "claude", model: "opus" },
      ],
      reviewModel: { agent: "claude", model: "opus" },
      fixModel: { agent: "claude", model: "opus" },
    });
  });
});

describe("MultiReviewLaunchDialog auto-fix", () => {
  test("plain launch uses the saved default and defaults off for old settings", () => {
    expect(defaultMultiReviewLaunchSelection({ defaultAgent: "claude", catalog }).autoFix).toBe(
      false,
    );
    expect(
      defaultMultiReviewLaunchSelection({
        defaultAgent: "claude",
        catalog,
        defaultAutoAddressFindings: true,
      }).autoFix,
    ).toBe(true);
  });

  test.each([true, false])(
    "can override saved auto-fix %s for one launch and resets on reopen",
    (defaultAutoAddressFindings) => {
      const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
      const props = {
        defaultAgent: "claude" as const,
        catalog,
        defaultAutoAddressFindings,
        onConfirm,
        onOpenChange: () => undefined,
      };
      const { rerender } = renderInAppCommandScope(<MultiReviewLaunchDialog {...props} open />);
      const checkbox = screen.getByRole("checkbox", {
        name: "Auto-address findings after consolidation",
      });
      expect(checkbox.getAttribute("aria-checked")).toBe(String(defaultAutoAddressFindings));
      fireEvent.click(checkbox);
      // Catalogue/default refresh while open must not erase the user's choice.
      rerender(<MultiReviewLaunchDialog {...props} catalog={{ ...catalog }} open />);
      fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
      expect(onConfirm.mock.calls[0]?.[0].autoFix).toBe(!defaultAutoAddressFindings);
      rerender(<MultiReviewLaunchDialog {...props} open={false} />);
      rerender(<MultiReviewLaunchDialog {...props} open />);
      expect(
        screen
          .getByRole("checkbox", { name: "Auto-address findings after consolidation" })
          .getAttribute("aria-checked"),
      ).toBe(String(defaultAutoAddressFindings));
      rerender(<MultiReviewLaunchDialog {...props} open busy />);
      expect(
        screen
          .getByRole("checkbox", { name: "Auto-address findings after consolidation" })
          .hasAttribute("disabled"),
      ).toBe(true);
    },
  );
});

describe("MultiReviewLaunchDialog auto-PR", () => {
  test("plain launch uses the saved default and defaults off for old settings", () => {
    expect(defaultMultiReviewLaunchSelection({ defaultAgent: "claude", catalog }).autoPr).toBe(
      false,
    );
    expect(
      defaultMultiReviewLaunchSelection({ defaultAgent: "claude", catalog, defaultAutoPr: true })
        .autoPr,
    ).toBe(true);
  });

  test("can override saved auto-PR for one launch, describes the turn, and resets on reopen", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    const props = {
      defaultAgent: "claude" as const,
      catalog,
      defaultAutoAddressFindings: true,
      onConfirm,
      onOpenChange: () => undefined,
    };
    const { rerender } = renderInAppCommandScope(<MultiReviewLaunchDialog {...props} open />);
    const checkbox = screen.getByRole("checkbox", { name: "Auto-PR after fix or clean review" });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(checkbox);
    expect(screen.getByTestId("multi-review-work-summary").textContent).toContain(
      "1 pull request turn",
    );
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ autoFix: true, autoPr: true });
    rerender(<MultiReviewLaunchDialog {...props} open={false} />);
    rerender(<MultiReviewLaunchDialog {...props} open />);
    expect(
      screen
        .getByRole("checkbox", { name: "Auto-PR after fix or clean review" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("MultiReviewLaunchDialog launch value", () => {
  test("warns about exact duplicates without blocking or altering the launch", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={speedCatalog}
        onConfirm={onConfirm}
      />,
    );

    const warning = screen.getByTestId("multi-review-duplicate-warning");
    expect(warning.getAttribute("aria-live")).toBe("polite");
    expect(warning.textContent).toBe(
      "Reviewers 1 and 2 use the same configuration. This may provide a second sample of that configuration, but often produces overlapping findings and approximately two review turns.",
    );
    const start = screen.getByRole("button", { name: "Start 2-model review" });
    expect(start.hasAttribute("disabled")).toBe(false);
    fireEvent.click(start);
    const selection = onConfirm.mock.calls[0]![0];
    expect(selection.reviewers[0]).toEqual(selection.reviewers[1]);
  });

  test("a behaviour-affecting difference clears the warning", () => {
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={speedCatalog}
        onConfirm={() => undefined}
      />,
    );
    chooseSpeed("Reviewer 2", /Fast/);
    expect(screen.getByTestId("multi-review-duplicate-warning").textContent).toBe("");
  });

  test("summarizes expected turns without estimating cost", () => {
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        onConfirm={() => undefined}
      />,
    );
    const summary = screen.getByTestId("multi-review-work-summary");
    expect(summary.textContent).toContain("2 reviewer turns");
    expect(summary.textContent).toContain("validation run once and shared");
    expect(summary.textContent).not.toMatch(/[$€£]/);
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    expect(summary.textContent).toContain("3 reviewer turns");
    fireEvent.click(screen.getByLabelText("Auto-address findings after consolidation"));
    expect(summary.textContent).toContain("then 1 Address Findings turn");
  });
});

describe("MultiReviewLaunchDialog focus", () => {
  function setPresets(reviewLensPresets: GlobalConfig["reviewLensPresets"]) {
    const config = appCommandStore(configStore).getState().config;
    appCommandStore(configStore).setState({
      config: { ...config, global: { ...config.global, reviewLensPresets } },
    });
  }
  afterEach(() => setPresets(undefined));

  function renderDialog(defaults: Partial<MultiReviewLaunchDefaults> = {}) {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        onConfirm={onConfirm}
        {...defaults}
      />,
    );
    return onConfirm;
  }

  test("offers the shipped presets and copies the chosen preset's text into the launch", () => {
    const onConfirm = renderDialog();
    const select = screen.getByRole("combobox", { name: "Reviewer 1 focus" });
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "No focus",
      ...SHIPPED_REVIEW_LENS_PRESETS.map((preset) => preset.label),
      "Custom…",
    ]);
    fireEvent.change(select, { target: { value: "preset:security" } });
    expect(screen.getByText(SHIPPED_REVIEW_LENS_PRESETS[0]!.instruction)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    const selection = onConfirm.mock.calls[0]![0];
    expect(selection.reviewers[0]!.lens).toEqual({
      label: "Security",
      instruction: SHIPPED_REVIEW_LENS_PRESETS[0]!.instruction,
    });
    expect(selection.reviewers[1]).not.toHaveProperty("lens");
    expect(selection.reviewModel).not.toHaveProperty("lens");
    expect(selection.fixModel).not.toHaveProperty("lens");
  });

  test("uses the edited presets and accepts free text, blocking an incomplete one", () => {
    setPresets([{ id: "mine", label: "Migrations", instruction: "Check both directions." }]);
    const onConfirm = renderDialog();
    const select = screen.getByRole("combobox", { name: "Reviewer 2 focus" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["No focus", "Migrations", "Custom…"]);
    // Custom starts from the preset's text, so it can be adjusted.
    fireEvent.change(select, { target: { value: "preset:mine" } });
    fireEvent.change(select, { target: { value: "custom:" } });
    const label = screen.getByRole("textbox", { name: "Reviewer 2 focus label" });
    expect((label as HTMLInputElement).value).toBe("Migrations");
    fireEvent.change(label, { target: { value: "" } });
    const start = screen.getByRole("button", { name: "Start 2-model review" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Give the focus a label.")).toBeTruthy();
    fireEvent.change(label, { target: { value: " Down migrations " } });
    fireEvent.change(screen.getByRole("textbox", { name: "Reviewer 2 focus instruction" }), {
      target: { value: "Check every down migration. " },
    });
    expect((start as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(start);
    expect(onConfirm.mock.calls[0]![0].reviewers[1]!.lens).toEqual({
      label: "Down migrations",
      instruction: "Check every down migration.",
    });
  });

  test("opens each reviewer on its position's saved focus", () => {
    const lens = { label: "Tests", instruction: "Name the missing cases." };
    const onConfirm = renderDialog({
      reviewerDefaults: [{ defaultAgent: "claude" }, { defaultAgent: "codex", lens }],
    });
    expect(
      (screen.getByRole("combobox", { name: "Reviewer 2 focus" }) as HTMLSelectElement).value,
    ).toBe("custom:");
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    const selection = onConfirm.mock.calls[0]![0];
    expect(selection.reviewers[0]).not.toHaveProperty("lens");
    expect(selection.reviewers[1]!.lens).toEqual(lens);
    expect(
      defaultMultiReviewLaunchSelection({
        defaultAgent: "claude",
        catalog,
        reviewerDefaults: [{ defaultAgent: "claude" }, { defaultAgent: "codex", lens }],
      }).reviewers[1]!.lens,
    ).toEqual(lens);
  });

  test("two rows on one model with different focuses are not duplicates", () => {
    renderDialog({ reviewerDefaults: [{ defaultAgent: "claude" }, { defaultAgent: "claude" }] });
    expect(screen.getByTestId("multi-review-duplicate-warning").textContent).toContain(
      "same configuration",
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Reviewer 2 focus" }), {
      target: { value: "preset:performance" },
    });
    expect(screen.getByTestId("multi-review-duplicate-warning").textContent).toBe("");
  });
});

describe("node-resolved defaults", () => {
  const selection: MultiReviewLaunchSelection = {
    reviewers: [
      { agent: "codex", model: "gpt-5.6", reasoningEffort: "low" },
      { agent: "claude", model: "opus", reasoningEffort: "high", fastMode: true },
      { agent: "codex", model: "gpt-5.5", reasoningEffort: "medium" },
    ],
    reviewModel: { agent: "claude", model: "opus", fastMode: true },
    fixModel: { agent: "codex", model: "gpt-5.5", reasoningEffort: "high" },
    autoFix: true,
    autoPr: true,
  };

  test("replaces the window reviewer count and exact resolved choices", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    const props = {
      open: true,
      onOpenChange: () => undefined,
      defaultAgent: "claude" as const,
      catalog: speedCatalog,
      onConfirm,
    };
    const { rerender } = renderInAppCommandScope(
      <MultiReviewLaunchDialog {...props} resolvedDefaults={{ status: "loading" }} />,
    );
    expect(
      screen.getByRole("button", { name: "Start 2-model review" }).hasAttribute("disabled"),
    ).toBe(true);
    rerender(
      <MultiReviewLaunchDialog {...props} resolvedDefaults={{ status: "ready", selection }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start 3-model review" }));
    expect(onConfirm.mock.calls[0]?.[0]).toEqual(selection);
  });

  test("seeds once per open and preserves edits until the next open", () => {
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    const props = {
      onOpenChange: () => undefined,
      defaultAgent: "claude" as const,
      catalog: speedCatalog,
      onConfirm,
    };
    const { rerender } = renderInAppCommandScope(
      <MultiReviewLaunchDialog {...props} open resolvedDefaults={{ status: "ready", selection }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove reviewer 3" }));
    rerender(
      <MultiReviewLaunchDialog
        {...props}
        open
        resolvedDefaults={{ status: "ready", selection: { ...selection } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start 2-model review" }));
    expect(onConfirm.mock.calls[0]?.[0].reviewers).toEqual(selection.reviewers.slice(0, 2));
    rerender(<MultiReviewLaunchDialog {...props} open={false} />);
    const next = { ...selection, reviewers: selection.reviewers.slice(0, 1) };
    rerender(
      <MultiReviewLaunchDialog
        {...props}
        open
        resolvedDefaults={{ status: "ready", selection: next }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start 1-model review" }));
    expect(onConfirm.mock.calls[1]?.[0]).toEqual(next);
  });

  test("keeps platform reasoning and speed preferences when switching a resolved row", () => {
    setFavorites([{ platform: "claude", modelId: "opus" }]);
    const onConfirm = mock((_selection: MultiReviewLaunchSelection) => undefined);
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="codex"
        catalog={speedCatalog}
        preferredReasoningEfforts={{ claude: "high", codex: "low" }}
        preferredFastModes={{ claude: true }}
        resolvedDefaults={{ status: "ready", selection }}
        onConfirm={onConfirm}
      />,
    );
    // Reviewer 3 has no corresponding window-built row; it inherits the fallback preferences.
    chooseFavorite("Reviewer 3", /Opus/);
    chooseFavorite("Preparation & consolidation model", /Opus/);
    chooseFavorite("Address Findings model", /Opus/);
    fireEvent.click(screen.getByRole("button", { name: "Start 3-model review" }));
    const submitted = onConfirm.mock.calls[0]![0];
    for (const row of [submitted.reviewers[2], submitted.reviewModel, submitted.fixModel]) {
      expect(row).toMatchObject({
        agent: "claude",
        model: "opus",
        reasoningEffort: "high",
        fastMode: true,
      });
    }
  });

  test("renders an unpunctuated read error separately from its retry hint", () => {
    renderInAppCommandScope(
      <MultiReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultAgent="claude"
        catalog={catalog}
        onConfirm={() => undefined}
        resolvedDefaults={{ status: "failed", message: "node unavailable" }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Close and reopen to try again.").className).toBe("block");
    expect(within(alert).getByText(/saved review defaults: node unavailable/).textContent).toBe(
      "Could not read this machine's saved review defaults: node unavailable",
    );
    expect(
      screen.getByRole("button", { name: "Start 2-model review" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
