import { useState } from "react";
import {
  pipelineDeliveryTooLateNote,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import type { DeliveryPolicy } from "@orkestrator/protocol/ticket-sections";
import { BuildLaunchDialog } from "../../apps/web/src/components/build/BuildLaunchDialog";
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
  const [confirmed, setConfirmed] = useState<DeliveryPolicy | null>(null);
  const run: Pick<BuildPipeline, "phase" | "delivery" | "error"> = {
    phase: "creating-pr",
    ...(decided ? { delivery: { policy: decided, decidedAt: "2026-11-02T00:00:00.000Z" } } : {}),
  };
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      {params.has("launch") ? (
        <>
          <output data-testid="confirmed-policy">{confirmed ?? "none"}</output>
          <BuildLaunchDialog
            open
            onOpenChange={() => undefined}
            catalog={catalog}
            defaultAgent="claude"
            defaultEnvironmentType="local"
            deliveryPolicy={policy}
            onConfirm={(selection) => setConfirmed(selection.deliveryPolicy)}
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
