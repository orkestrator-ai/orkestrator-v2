import { useState } from "react";
import { ProjectHomeMessageApprovalDialog } from "../../apps/web/src/components/federation/ProjectHomeMessageApprovalDialog";
import type { NodeActionRequestView } from "../../apps/web/src/lib/portal/portal-store";

const request: NodeActionRequestView = {
  requestId: "project-home-fixture",
  kind: "message-project-home",
  state: "pending",
  reason: "The user asked to update their checkout; an isolated worktree cannot update it.",
  targets: [
    { nodeId: "self", nodeName: "this machine", environmentId: "home", environmentName: "widgets" },
  ],
  requestedBy: { projectId: "p1" },
  projectHomeMessage: {
    mailRequestId: "home-message-1",
    subject: "Update the checkout",
    body: "Update the project checkout to the approved release commit.",
  },
};

/** `?images=1` holds the same message with two pasted images. */
const withImages = (): NodeActionRequestView =>
  new URLSearchParams(window.location.search).has("images")
    ? {
        ...request,
        projectHomeMessage: {
          ...request.projectHomeMessage!,
          attachments: ["clipboard-1.png", "clipboard-2.png"],
        },
      }
    : request;

export function ProjectHomeMessageApprovalFixture() {
  const [shown] = useState(withImages);
  const [decision, setDecision] = useState<unknown>(null);
  const [settled, setSettled] = useState(false);
  useState(() => {
    window.orkestrator = {
      ...window.orkestrator!,
      invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command !== "resolve_node_action_request")
          throw new Error(`Unexpected command: ${command}`);
        setDecision(args);
        return { ...request, state: args?.decision === "approve" ? "executed" : "rejected" } as T;
      },
    };
  });
  return (
    <main>
      <pre data-testid="decision">{JSON.stringify(decision)}</pre>
      {!settled && (
        <ProjectHomeMessageApprovalDialog request={shown} onSettled={() => setSettled(true)} />
      )}
    </main>
  );
}
