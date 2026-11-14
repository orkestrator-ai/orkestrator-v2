import { FeatureBuildFields } from "../../apps/web/src/components/environments/FeatureBuildFields";
import { defaultFeatureBuildModels } from "../../apps/web/src/lib/feature-build-launch";
import { useState } from "react";
import {
  pipelineDeliveryTooLateNote,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import type { DeliveryPolicy } from "@orkestrator/protocol/ticket-sections";
import { BuildLaunchDialog } from "../../apps/web/src/components/build/BuildLaunchDialog";
import type { BuildLaunchMachine } from "../../apps/web/src/components/build/build-machines";
import { TicketSectionsGrid } from "../../apps/web/src/components/tickets/TicketSectionsGrid";
import type { AgentModelCatalog } from "../../apps/web/src/lib/agent-launch";

const catalog: AgentModelCatalog = {
  claude: [{ id: "claude-a", name: "Claude A", reasoningEfforts: ["high"] }],
  codex: [{ id: "codex-a", name: "Codex A", reasoningEfforts: ["high"] }],
  opencode: [],
  cursor: [],
  grok: [],
  pi: [],
};

/** `?machines`: the launcher's Machine choice, as a project present on a second machine gives it. */
const MACHINES: BuildLaunchMachine[] = [
  {
    key: "node:own",
    name: "Studio Mac",
    machine: undefined,
    nodeId: "own",
    projectId: "project-own",
    current: true,
    available: true,
  },
  {
    key: "node:builder",
    name: "Builder",
    machine: "builder",
    nodeId: "builder",
    projectId: "project-builder",
    current: false,
    available: true,
  },
  {
    key: "node:laptop",
    name: "Laptop",
    machine: "laptop",
    nodeId: "laptop",
    projectId: "project-laptop",
    current: false,
    available: false,
  },
];

function policyParam(params: URLSearchParams): DeliveryPolicy | undefined {
  const value = params.get("policy");
  return value === "commit-only" || value === "push-no-pr" || value === "open-pr"
    ? value
    : undefined;
}

/**
 * The "When verified" dropdown where a user meets it: `?launch` is the Build
 * launcher's Pull request card, otherwise the ticket's Delivery tile, and
 * `?decided=open-pr` a run that has already gone ahead with that policy.
 */
export function DeliveryPolicyFixture() {
  const params = new URLSearchParams(window.location.search);
  const [policy, setPolicy] = useState(policyParam(params));
  const decided = params.get("decided") as DeliveryPolicy | null;
  const [models, setModels] = useState(() =>
    defaultFeatureBuildModels({
      catalog,
      build: { agent: "claude", model: "claude-a" },
      review: { agent: "claude", model: "claude-a" },
      review2: { agent: "claude", model: "claude-a" },
      address: { agent: "claude", model: "claude-a" },
      pr: { agent: "claude", model: "claude-a" },
      resolve: { agent: "claude", model: "claude-a" },
    }),
  );
  const [confirmed, setConfirmed] = useState<DeliveryPolicy | null>(null);
  const [confirmedMachine, setConfirmedMachine] = useState<string | null>(null);
  const run: Pick<BuildPipeline, "phase" | "delivery" | "error"> = {
    phase: params.has("complete") ? "complete" : "creating-pr",
    ...(decided ? { delivery: { policy: decided, decidedAt: "2026-11-02T00:00:00.000Z" } } : {}),
  };
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      {params.has("feature") ? (
        <FeatureBuildFields
          intent="feature"
          onIntentChange={() => undefined}
          name="Delivery policy"
          onNameChange={() => undefined}
          description="Keep the selected delivery policy through verification."
          onDescriptionChange={() => undefined}
          acceptanceCriteria="No PR is opened for push-only delivery."
          onAcceptanceCriteriaChange={() => undefined}
          advancedOpen
          onAdvancedOpenChange={() => undefined}
          customizeModels
          onCustomizeModelsChange={() => undefined}
          models={models}
          onModelsChange={setModels}
          catalog={catalog}
          enabledPlatforms={["claude", "codex"]}
          promptFields={null}
          deliveryPolicy={policy}
          onDeliveryPolicyChange={setPolicy}
        />
      ) : params.has("launch") ? (
        <>
          <output data-testid="confirmed-policy">{confirmed ?? "none"}</output>
          <output data-testid="confirmed-machine">{confirmedMachine ?? "this machine"}</output>
          <BuildLaunchDialog
            open
            onOpenChange={() => undefined}
            catalog={catalog}
            defaultAgent="claude"
            defaultEnvironmentType="local"
            deliveryPolicy={policy}
            machines={params.has("machines") ? MACHINES : undefined}
            onConfirm={(selection) => {
              setConfirmed(selection.deliveryPolicy);
              setConfirmedMachine(selection.machine?.name ?? null);
            }}
          />
        </>
      ) : (
        <TicketSectionsGrid
          sections={{
            summary: "Make Build honour the ticket's delivery policy.",
            delivery: policy ? { policy, note: "Mail the coordinator when pushed." } : undefined,
          }}
          deliveryControl={{
            onChange: setPolicy,
            tooLateNote: pipelineDeliveryTooLateNote(run, policy),
          }}
        />
      )}
    </main>
  );
}
