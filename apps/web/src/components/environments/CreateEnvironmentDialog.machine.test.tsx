import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import * as federation from "@/components/federation/FederationProvider";
import * as machineViews from "@/components/federation/useMachineViews";
import type { MachineView } from "@/lib/federation/aggregate";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { portalStore } from "@/lib/portal/portal-store";
import { configStore } from "@/stores/configStore";
import { appCommandStore } from "@/test/app-command-store";
import {
  cleanupNodeScopes,
  FakeNodeClient,
  renderInAppCommandScope,
  renderInNodeScope,
} from "@/test/render-in-node-scope";
import { CreateEnvironmentDialog } from "./CreateEnvironmentDialog";

const LEAF = "bk_studio" as BackendId;

afterEach(() => {
  cleanup();
  cleanupNodeScopes();
  mock.restore();
});

/** The window works on "Build Mac"; "Studio" is another machine in view. */
function federated() {
  spyOn(federation, "useFederation").mockReturnValue({
    portal: portalStore,
    portalState: portalStore.getState(),
    bound: null,
    supported: true,
    enabled: true,
    kind: "browser",
    boundMachine: { name: "Build Mac", colorToken: "teal" },
  });
  return spyOn(machineViews, "useRemoteMachineView").mockImplementation((nodeId) =>
    nodeId === LEAF
      ? ({ backendId: LEAF, name: "Studio", colorToken: "amber" } as MachineView)
      : null,
  );
}

function dialog() {
  return (
    <DockerAvailabilityProvider available>
      <CreateEnvironmentDialog
        open
        onOpenChange={() => undefined}
        onCreate={async () => true}
        projectId="project-1"
      />
    </DockerAvailabilityProvider>
  );
}

describe("CreateEnvironmentDialog target machine", () => {
  test("on the command node it names the machine the window works on", () => {
    const remoteView = federated();
    renderInAppCommandScope(dialog());
    expect(screen.getByTestId("create-environment-machine").textContent).toContain("on Build Mac");
    expect(screen.queryByText("Isolated Docker environment on Build Mac") !== null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    expect(screen.queryByText("Git worktree on Build Mac") !== null).toBe(true);
    // The command scope never looks itself up among the other machines.
    expect(remoteView.mock.calls.every(([nodeId]) => nodeId === null)).toBe(true);
  });

  test("in another machine's workspace it names that machine, not the command node's", () => {
    const remoteView = federated();
    const leaf = new FakeNodeClient({ nodeId: LEAF });
    const view = renderInNodeScope(<></>, { role: "leaf", client: leaf });
    view.scope
      .store(configStore)
      .setState({ config: appCommandStore(configStore).getState().config });
    view.rerender(dialog());
    const label = screen.getByTestId("create-environment-machine").textContent ?? "";
    expect(label).toContain("on Studio");
    expect(label).not.toContain("Build Mac");
    // The type hint names the target machine too, not "your machine".
    expect(screen.queryByText("Isolated Docker environment on Studio") !== null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    expect(screen.queryByText("Git worktree on Studio") !== null).toBe(true);
    expect(screen.queryByText(/your machine/) === null).toBe(true);
    expect(remoteView.mock.calls.some(([nodeId]) => nodeId === LEAF)).toBe(true);
  });

  test("without federation the type hint names no machine", () => {
    // No federation spy: the inactive default, a single machine.
    renderInAppCommandScope(dialog());
    expect(screen.queryByTestId("create-environment-machine") === null).toBe(true);
    expect(screen.queryByText("Isolated Docker environment") !== null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    expect(screen.queryByText("Git worktree on the host") !== null).toBe(true);
    expect(screen.queryByText(/your machine/) === null).toBe(true);
  });

  test("with federation on but the target machine unknown it falls back too", () => {
    spyOn(federation, "useFederation").mockReturnValue({
      portal: portalStore,
      portalState: portalStore.getState(),
      bound: null,
      supported: true,
      enabled: true,
      kind: "browser",
      boundMachine: null,
    });
    spyOn(machineViews, "useRemoteMachineView").mockReturnValue(null);
    renderInAppCommandScope(dialog());
    expect(screen.queryByText("Isolated Docker environment") !== null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    expect(screen.queryByText("Git worktree on the host") !== null).toBe(true);
  });
});
