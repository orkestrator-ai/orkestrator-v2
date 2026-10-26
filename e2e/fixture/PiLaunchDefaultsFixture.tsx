import { useState } from "react";
import { MultiReviewRestartDialog } from "../../apps/web/src/components/review/MultiReviewRestartDialog";
import { MultiReviewFixPromptDialog } from "../../apps/web/src/components/review/MultiReviewFixPromptDialog";
import { FeatureBuildFields } from "../../apps/web/src/components/environments/FeatureBuildFields";
import type { AgentModelCatalog } from "../../apps/web/src/lib/agent-launch";
import { defaultFeatureBuildModels } from "../../apps/web/src/lib/feature-build-launch";

const catalog: AgentModelCatalog = {
  claude: [{ id: "sonnet", name: "Sonnet", reasoningEfforts: ["low"] }],
  codex: [],
  opencode: [],
  pi: [
    { id: "openai/gpt-4", name: "Refused first model", reasoningEfforts: ["low"] },
    {
      id: "openai/gpt-6.1-sol",
      name: "Saved Pi default",
      reasoningEfforts: ["medium", "high"],
      sessionDefault: true,
    },
  ],
};
const initialSelection = { agent: "claude", model: "sonnet" } as const;

export function PiLaunchDefaultsFixture() {
  const kind = new URLSearchParams(window.location.search).get("kind");
  const [selection, setSelection] = useState<unknown>();
  const [models, setModels] = useState(() =>
    defaultFeatureBuildModels({
      catalog,
      build: initialSelection,
      review: initialSelection,
      review2: initialSelection,
      address: initialSelection,
      pr: initialSelection,
      resolve: initialSelection,
    }),
  );
  return (
    <>
      <output aria-label="Submitted selection">{JSON.stringify(selection)}</output>
      {kind === "feature" ? (
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
            setSelection(next.build);
          }}
          catalog={catalog}
          enabledPlatforms={["claude", "pi"]}
          promptFields={null}
        />
      ) : kind === "fix" ? (
        <MultiReviewFixPromptDialog
          open
          onOpenChange={() => undefined}
          catalog={catalog}
          defaultSelection={initialSelection}
          onSubmit={setSelection}
        />
      ) : (
        <MultiReviewRestartDialog
          open
          onOpenChange={() => undefined}
          kind="fix"
          catalog={catalog}
          defaultSelection={initialSelection}
          onSubmit={setSelection}
        />
      )}
    </>
  );
}
