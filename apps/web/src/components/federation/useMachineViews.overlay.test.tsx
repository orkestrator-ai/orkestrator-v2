/**
 * The machine view the title bar reads for the node on screen
 * (`useRemoteMachineView`, `AppShell`'s names and merge-ready shimmer) follows
 * the same overlay as the sidebar rows (plan item 5007).
 */
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { noteAuthoritativeRead } from "@/lib/node-scope/snapshot-sync";
import { portalStore } from "@/lib/portal/portal-store";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import type { Environment, Project } from "@/types";
import { FederationProvider } from "./FederationProvider";
import { useRemoteMachineView } from "./useMachineViews";

const LEAF = "bk_leaf" as BackendId;
let scope: NodeScope | null = null;

afterEach(() => {
  cleanup();
  if (scope && !scope.disposed) scope.dispose();
  scope = null;
  uninstallDesktopFake();
});

function Probe() {
  const machine = useRemoteMachineView(LEAF);
  const environment = machine?.environmentsByProject.get("project-1")?.[0];
  return <output data-testid="probe">{environment ? environment.name : "none"}</output>;
}

test("the shown node's names come from its warm scope, and from its summary otherwise", async () => {
  installDesktopFake({
    list: connectionList([remoteConnection("leaf", "Leaf", "teal")]),
    datasets: { leaf: sharedIdDataset("idle") },
  });
  render(
    <FederationProvider>
      <Probe />
    </FederationProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("feature"));
  const summaries = portalStore.getState().nodes;

  const opened = getWindowScope().open({
    role: "leaf",
    client: new FakeNodeClient({ nodeId: LEAF }),
    tier: "live",
  });
  scope = opened;
  act(() => {
    opened
      .store(projectStore)
      .getState()
      .setProjects([
        {
          id: "project-1",
          name: "app",
          gitUrl: "",
          localPath: null,
          addedAt: "2026-10-01T00:00:00Z",
          order: 0,
        } as Project,
      ]);
    opened
      .store(environmentStore)
      .getState()
      .setEnvironments([
        {
          id: "env-1",
          projectId: "project-1",
          name: "feature-renamed",
          status: "running",
          agentActivityState: "idle",
          order: 0,
        } as unknown as Environment,
      ]);
  });
  // Not yet authoritative: still the summary's name.
  expect(screen.getByTestId("probe").textContent).toBe("feature");
  act(() => noteAuthoritativeRead(opened, "environment"));
  expect(screen.getByTestId("probe").textContent).toBe("feature-renamed");
  expect(portalStore.getState().nodes).toBe(summaries);

  act(() => opened.setTier("suspended"));
  expect(screen.getByTestId("probe").textContent).toBe("feature");
});
