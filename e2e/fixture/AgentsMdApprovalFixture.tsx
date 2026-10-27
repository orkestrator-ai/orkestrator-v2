import { useState } from "react";
import { AgentsMdApprovalDialog } from "../../apps/web/src/components/federation/AgentsMdApprovalDialog";
import type { NodeActionRequestView } from "../../apps/web/src/lib/portal/portal-store";

const request: NodeActionRequestView = {
  requestId: "agents-md-fixture",
  kind: "update-agents-md",
  state: "pending",
  reason: "Agreed while planning the release",
  targets: [{ nodeId: "self", nodeName: "this machine", projectId: "p1", projectName: "widgets" }],
  requestedBy: { projectId: "p1" },
  agentsMd: {
    changes: [
      { action: "add", text: "Commit flaky-test records in the same change." },
      {
        action: "replace",
        replaces: "Never touch ports 34121/34122.",
        text: "Never bind ports 34121 or 34122.",
      },
    ],
  },
};

const SECTION = [
  "## Orkestrator",
  "",
  "Operating decisions the user approved in Orkestrator coordinator conversations.",
  "",
  "- Never touch ports 34121/34122.",
  "- Use bun, never npm.",
  "",
].join("\n");

/** The decision the dialog sent, rendered for the spec to read. */
function installFixture(record: (value: unknown) => void) {
  window.orkestrator = {
    ...window.orkestrator!,
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      switch (command) {
        case "preview_agents_md_update":
          return {
            baseBranch: "main",
            baseCommit: "c0ffee00".repeat(5),
            fetched: true,
            fileExists: true,
            section: { exists: true, text: SECTION, entries: [] },
          } as T;
        case "resolve_node_action_request":
          record(args);
          return {
            ...request,
            state: args?.decision === "approve" ? "executed" : "rejected",
            result: {
              code: "pr-opened",
              message: "Opened",
              url: "https://github.com/acme/widgets/pull/9",
            },
          } as T;
        default:
          throw new Error(`Unexpected AGENTS.md fixture command: ${command}`);
      }
    },
  };
  return true;
}

export function AgentsMdApprovalFixture() {
  const [decision, setDecision] = useState<unknown>(null);
  useState(() => installFixture(setDecision));
  const [settled, setSettled] = useState(false);
  return (
    <main className="p-4">
      {settled ? null : (
        <AgentsMdApprovalDialog request={request} onSettled={() => setSettled(true)} />
      )}
      <pre data-testid="decision">{decision ? JSON.stringify(decision) : ""}</pre>
    </main>
  );
}
