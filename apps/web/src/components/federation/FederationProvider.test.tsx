import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { FederationProvider, useFederation } from "./FederationProvider";
import { portalStore } from "@/lib/portal/portal-store";
import { invoke } from "@/lib/native/backend";
import { mock } from "bun:test";

const original = window.orkestrator;
afterEach(() => {
  cleanup();
  window.orkestrator = original;
  delete window.orkestratorWorkspaceTarget;
  sessionStorage.clear();
  (invoke as ReturnType<typeof mock>).mockReset();
});

function BoundMachine() {
  const { enabled, bound } = useFederation();
  return enabled && bound ? <p>Bound to {bound.backendId}</p> : null;
}

test("a workspace realm stays bound to its node with no other node listed", async () => {
  window.orkestrator = undefined;
  window.orkestratorWorkspaceTarget = { nodeId: "bk_leaf", nodeName: "Leaf", path: "relay" };
  (invoke as ReturnType<typeof mock>).mockImplementation(async (command) =>
    command === "get_node_summaries" ? { selfId: "bk_command", nodes: [] } : {},
  );
  portalStore.store.setState({ nodes: [], selfId: "bk_command" as never });
  render(
    <FederationProvider>
      <BoundMachine />
    </FederationProvider>,
  );
  expect(await screen.findByText("Bound to bk_leaf")).toBeTruthy();
});
