import { useState } from "react";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import { permissionRuleOffer } from "@orkestrator/protocol/permission-rules";
import { codexRuleDetail } from "../../apps/backend/src/core/permission-rules/request-detail";
import { NativeAgentInteractionCard } from "../../apps/web/src/components/native-agent/NativeAgentInteractionCard";
import type { PermissionRuleChoiceInput } from "../../apps/web/src/lib/backend/permission-rules";

const WORKSPACE = "/Users/dev/orkestrator/workspaces/widgets-feature-3c724e19";

/**
 * Codex approvals as codex-bridge's `approvals.ts` forwards them. The first
 * command is the shape the pinned Codex 0.164.0 sent in
 * `live-policy-amendment.test.ts` (one `zsh -lc` layer around a plain
 * command); the others are built the same way.
 */
const BRIDGE_APPROVALS: Array<{
  id: string;
  kind: "command-approval" | "file-approval";
  payload: Record<string, unknown>;
}> = [
  {
    id: "codex-touch",
    kind: "command-approval",
    payload: {
      command: "/bin/zsh -lc 'touch policy-amendment-probe.txt'",
      cwd: WORKSPACE,
      ruleEligible: true,
      proposedCommandPrefix: ["touch", "policy-amendment-probe.txt"],
    },
  },
  {
    id: "codex-bun-test",
    kind: "command-approval",
    payload: {
      command: "/bin/zsh -lc 'bun test apps/web/src/components/native-agent --timeout 20000'",
      cwd: WORKSPACE,
      reason: "Run the native agent component tests",
      ruleEligible: true,
      proposedCommandPrefix: ["bun", "test"],
    },
  },
  {
    id: "codex-edit",
    kind: "file-approval",
    payload: {
      ruleEligible: true,
      changes: [
        {
          path: `${WORKSPACE}/apps/web/src/components/native-agent/RememberRulePanel.tsx`,
        },
      ],
    },
  },
  {
    id: "codex-pipe",
    kind: "command-approval",
    payload: {
      command: "/bin/zsh -lc 'git log --oneline | head -5'",
      cwd: WORKSPACE,
      ruleEligible: true,
    },
  },
];

/**
 * The card the backend projects for each approval: the presentation
 * `HttpBridgeInteractionAdapter.mapCodexApproval` builds, with the offer the
 * enforcer adds from the real Codex reader and the protocol's offer builder.
 */
function projected(entry: (typeof BRIDGE_APPROVALS)[number]): AgentInteractionRequest {
  const detail = codexRuleDetail(entry.payload, entry.kind, true);
  if (!detail) throw new Error(`No rule detail for fixture ${entry.id}`);
  const offer = permissionRuleOffer(detail.subject, {
    workspaceRoot: WORKSPACE,
    ...(detail.proposal ? { proposal: detail.proposal } : {}),
  });
  const { command, cwd, reason, changes } = entry.payload as {
    command?: string;
    cwd?: string;
    reason?: string;
    changes?: Array<{ path: string }>;
  };
  const body = [
    ...(reason ? [`Reason: ${reason}`] : []),
    ...(command ? [`Command: ${command}`] : []),
    ...(cwd ? [`Working directory: ${cwd}`] : []),
    ...(changes ?? []).map((change) => `Change: ${change.path}`),
  ].join("\n");
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id: entry.id,
    provider: "codex",
    kind: entry.kind,
    origin: "interactive-native",
    sessionId: "codex-session",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    presentation: {
      title: entry.kind === "command-approval" ? "Approve command" : "Approve file changes",
      body,
      questions: [],
      confirmLabel: "Approve",
      declineLabel: "Deny",
      approveForSessionLabel: "Approve for session",
      ruleOffer: offer,
    },
  };
}

export function RememberRulePanelFixture() {
  const [saved, setSaved] = useState<Record<string, PermissionRuleChoiceInput>>({});
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4">
      {BRIDGE_APPROVALS.map((entry) => {
        const interaction = projected(entry);
        return (
          <section key={entry.id} data-testid={`card-${entry.id}`}>
            <NativeAgentInteractionCard
              interaction={interaction}
              onResolve={async (resolution) => ({
                result: "applied",
                interactionId: resolution.interactionId,
                sessionId: resolution.sessionId,
                revision: 2,
              })}
              onApproveAndRemember={async (choice) => {
                setSaved((current) => ({ ...current, [entry.id]: choice }));
                return {
                  result: "applied",
                  interactionId: interaction.id,
                  sessionId: interaction.sessionId,
                  revision: 2,
                };
              }}
            />
            {saved[entry.id] ? (
              <output data-testid={`saved-${entry.id}`}>{JSON.stringify(saved[entry.id])}</output>
            ) : null}
          </section>
        );
      })}
    </main>
  );
}
