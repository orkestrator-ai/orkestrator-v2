import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { defaultFeatureBuildModels, type FeatureBuildModelState } from "@/lib/feature-build-launch";
import { FeatureBuildFields } from "./FeatureBuildFields";

afterEach(cleanup);

const catalog: AgentModelCatalog = {
  claude: [
    {
      id: "sonnet",
      name: "Sonnet",
      reasoningEfforts: ["low", "high"],
      supportsSpeed: true,
    },
  ],
  codex: [{ id: "gpt-5.6", name: "GPT-5.6", reasoningEfforts: ["medium"], supportsSpeed: true }],
  opencode: [{ id: "default", name: "Default", reasoningEfforts: [] }],
};

/**
 * The panel is controlled, so a harness that actually stores what it emits is
 * the only way to see a later edit overwrite an earlier one.
 */
function Harness({ onModels }: { onModels: (models: FeatureBuildModelState) => void }) {
  const [models, setModels] = useState<FeatureBuildModelState>(() =>
    defaultFeatureBuildModels({
      catalog,
      build: { agent: "claude", model: "sonnet" },
      review: { agent: "claude", model: "sonnet" },
      review2: { agent: "claude", model: "sonnet" },
      address: { agent: "claude", model: "sonnet" },
      pr: { agent: "claude", model: "sonnet" },
      resolve: { agent: "claude", model: "sonnet" },
    }),
  );
  return (
    <FeatureBuildFields
      intent="feature"
      onIntentChange={() => undefined}
      name=""
      onNameChange={() => undefined}
      description=""
      onDescriptionChange={() => undefined}
      acceptanceCriteria=""
      onAcceptanceCriteriaChange={() => undefined}
      advancedOpen
      onAdvancedOpenChange={() => undefined}
      customizeModels
      onCustomizeModelsChange={() => undefined}
      models={models}
      onModelsChange={(next) => {
        setModels(next);
        onModels(next);
      }}
      catalog={catalog}
      enabledPlatforms={["claude", "codex"]}
      promptFields={null}
    />
  );
}

function openBuildPicker() {
  const picker = screen.getByRole("combobox", { name: "Build agent, model and reasoning" });
  return act(async () => fireEvent.pointerDown(picker));
}

describe("FeatureBuildFields build step speed", () => {
  test("keeps the Fast choice when the reasoning level changes afterwards", async () => {
    let latest: FeatureBuildModelState | undefined;
    render(<Harness onModels={(models) => (latest = models)} />);

    await openBuildPicker();
    const speed = screen.getByRole("group", { name: "Speed mode", hidden: true });
    fireEvent.click(within(speed).getByRole("menuitemradio", { name: /Fast/, hidden: true }));
    expect(latest?.build.fastMode).toBe(true);

    // Reasoning and speed live on the same picker, so a reasoning edit that
    // rebuilds the row instead of extending it silently reverts to Normal.
    await openBuildPicker();
    const reasoning = screen.getByRole("group", { name: "Reasoning", hidden: true });
    fireEvent.click(within(reasoning).getByRole("menuitemradio", { name: "High", hidden: true }));

    expect(latest?.build).toMatchObject({ reasoningEffort: "high", fastMode: true });
  });

  test("keeps the reasoning level when the speed changes afterwards", async () => {
    let latest: FeatureBuildModelState | undefined;
    render(<Harness onModels={(models) => (latest = models)} />);

    await openBuildPicker();
    const reasoning = screen.getByRole("group", { name: "Reasoning", hidden: true });
    fireEvent.click(within(reasoning).getByRole("menuitemradio", { name: "High", hidden: true }));

    await openBuildPicker();
    const speed = screen.getByRole("group", { name: "Speed mode", hidden: true });
    fireEvent.click(within(speed).getByRole("menuitemradio", { name: /Fast/, hidden: true }));

    expect(latest?.build).toMatchObject({ reasoningEffort: "high", fastMode: true });
  });
});
