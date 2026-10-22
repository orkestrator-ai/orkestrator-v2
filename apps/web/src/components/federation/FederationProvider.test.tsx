import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FederationProvider, useFederation } from "./FederationProvider";
import { portalStore } from "@/lib/portal/portal-store";
import { invoke } from "@/lib/native/backend";
import { mock } from "bun:test";
import { switchWorkspace } from "@/lib/portal/workspace-switch";
import { writeStoredWorkspace } from "@/lib/portal/workspace-target-storage";
import { fireEvent } from "@testing-library/react";

const original = window.orkestrator;
afterEach(() => {
  cleanup();
  window.orkestrator = original;
  delete window.orkestratorWorkspaceTarget;
  sessionStorage.clear();
  (invoke as ReturnType<typeof mock>).mockReset();
});

function ReturnControl() {
  const { enabled, portalState } = useFederation();
  return enabled && portalState.self ? (
    <button
      onClick={() => {
        void switchWorkspace(null);
      }}
    >
      Return to {portalState.self.displayName}
    </button>
  ) : null;
}

test("removing the final leaf leaves the self-summary return route enabled", async () => {
  window.orkestrator = undefined;
  window.orkestratorWorkspaceTarget = { nodeId: "bk_leaf", nodeName: "Leaf", path: "relay" };
  writeStoredWorkspace({
    workspaceId: "w",
    nodeId: "bk_leaf" as never,
    nodeName: "Leaf",
    path: "relay",
    baseUrl: "https://command.test/relay",
    expiresAt: Date.now() + 900000,
  });
  const self = {
    nodeId: "bk_command",
    displayName: "Desk",
    loadedAt: 1,
    truncated: false,
    projects: [],
    environments: [],
  };
  (invoke as ReturnType<typeof mock>).mockImplementation(async (command) =>
    command === "get_node_summaries" ? { selfId: "bk_command", nodes: [], self } : {},
  );
  portalStore.store.setState({ self: self as never, nodes: [], selfId: "bk_command" as never });
  // Happy DOM reload stays in this document; target storage proves the return.
  render(
    <FederationProvider>
      <ReturnControl />
    </FederationProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Return to Desk" }));
  await waitFor(() => expect(sessionStorage.getItem("orkestrator.workspace-target")).toBeNull());
});
