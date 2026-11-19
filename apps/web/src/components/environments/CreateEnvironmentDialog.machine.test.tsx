import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import * as federation from "@/components/federation/FederationProvider";
import * as machineViews from "@/components/federation/useMachineViews";
import type { MachineView } from "@/lib/federation/aggregate";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { portalStore } from "@/lib/portal/portal-store";
import { MODEL_CATALOG_REFRESHED_EVENT } from "@/components/settings/agent/refresh-model-catalog";
import { agentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { configStore } from "@/stores/configStore";
import { appCommandStore } from "@/test/app-command-store";
import {
  cleanupNodeScopes,
  FakeNodeClient,
  renderInAppCommandScope,
  renderInNodeScope,
} from "@/test/render-in-node-scope";
import { CreateEnvironmentDialog } from "./CreateEnvironmentDialog";
import type { CreateEnvironmentMachine } from "./create-environment-machines";

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

function dialog(open = true) {
  return (
    <DockerAvailabilityProvider available>
      <CreateEnvironmentDialog
        open={open}
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
    expect(screen.getByTestId("create-environment-machine").textContent).toContain("Build Mac");
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
    expect(label).toContain("Studio");
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

const OWN: CreateEnvironmentMachine = {
  key: "node:own",
  name: "Build Mac",
  machine: undefined,
  nodeId: "own",
  projectId: "project-1",
  current: true,
  available: true,
  hasCheckout: true,
};
const STUDIO: CreateEnvironmentMachine = {
  key: "node:studio",
  name: "Studio",
  machine: "studio",
  nodeId: "studio",
  projectId: "project-studio",
  current: false,
  available: true,
  hasCheckout: true,
};

function dialogWithMachines(
  machines: CreateEnvironmentMachine[],
  onSelectMachine: (machine: CreateEnvironmentMachine) => void,
  projectId = "project-1",
) {
  return (
    <DockerAvailabilityProvider available>
      <CreateEnvironmentDialog
        open
        onOpenChange={() => undefined}
        onCreate={async () => true}
        projectId={projectId}
        machines={machines}
        onSelectMachine={onSelectMachine}
      />
    </DockerAvailabilityProvider>
  );
}

describe("CreateEnvironmentDialog machine dropdown", () => {
  test("sits in the header and lists only the machines that can take the environment", async () => {
    federated();
    renderInAppCommandScope(dialogWithMachines([OWN, STUDIO], () => undefined));
    const header = screen.getByRole("dialog").querySelector("[data-slot='dialog-header']");
    const select = screen.getByRole("combobox", { name: "Machine" });
    expect(header?.contains(select)).toBe(true);
    expect(select.textContent).toContain("Build Mac");
    expect((select as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(select);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Build Mac", "Studio"]);
  });

  test("with no other machine holding the repository it names this one, disabled", () => {
    federated();
    renderInAppCommandScope(dialogWithMachines([OWN], () => undefined));
    const select = screen.getByRole("combobox", { name: "Machine" }) as HTMLButtonElement;
    expect(select.textContent).toContain("Build Mac");
    expect(select.disabled).toBe(true);
  });

  test("picking another machine hands the typed prompt and name to its dialog", async () => {
    federated();
    const onSelectMachine = mock((_machine: CreateEnvironmentMachine) => undefined);
    renderInAppCommandScope(dialogWithMachines([OWN, STUDIO], onSelectMachine));
    fireEvent.change(screen.getByLabelText("Environment name (optional)"), {
      target: { value: "dark-mode" },
    });
    fireEvent.change(screen.getByLabelText("Initial prompt (optional)"), {
      target: { value: "Add a dark mode" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Machine" }));
    fireEvent.click(await screen.findByRole("option", { name: /Studio/ }));
    expect(onSelectMachine).toHaveBeenCalledTimes(1);
    expect(onSelectMachine.mock.calls[0]![0]).toBe(STUDIO);
    cleanup();

    // Studio's own dialog, for its copy of the project, opens with them.
    renderInAppCommandScope(dialogWithMachines([STUDIO], () => undefined, "project-studio"));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Initial prompt (optional)") as HTMLTextAreaElement).value,
      ).toBe("Add a dark mode"),
    );
    expect((screen.getByLabelText("Environment name (optional)") as HTMLInputElement).value).toBe(
      "dark-mode",
    );
    cleanup();

    // They moved: this machine's project keeps no copy of the prompt.
    renderInAppCommandScope(dialogWithMachines([OWN], () => undefined));
    expect((screen.getByLabelText("Initial prompt (optional)") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });
});

describe("CreateEnvironmentDialog root setup steps on another machine", () => {
  test("the warning comes from the target machine's own reading", async () => {
    federated();
    const leaf = new FakeNodeClient({ nodeId: LEAF }).respond("get_project_setup_requirements", {
      rootSteps: 2,
    });
    const view = renderInNodeScope(<></>, { role: "leaf", client: leaf });
    view.scope
      .store(configStore)
      .setState({ config: appCommandStore(configStore).getState().config });
    view.rerender(dialog());
    fireEvent.click(screen.getByRole("button", { name: "Restricted" }));
    await waitFor(() =>
      expect(screen.queryByText(/orkestrator-ai\.json has root setup steps/) !== null).toBe(true),
    );
    const reads = leaf.invocations.filter(
      (call) => call.command === "get_project_setup_requirements",
    );
    expect(reads.length > 0).toBe(true);
    expect(reads.every((call) => call.args.projectId === "project-1")).toBe(true);
  });
});

test("hydrates on open, ignores other nodes, and removes the refresh listener on close", async () => {
  federated();
  const leaf = new FakeNodeClient({ nodeId: LEAF });
  leaf.respond("get_opencode_model_catalog_cache", null);
  const read = mock(() => ({
    schemaVersion: 1,
    codex: {
      updatedAt: "2026-11-18T12:00:00.000Z",
      models: [{ id: "studio-cached", name: "Studio cached" }],
    },
  }));
  leaf.respond("get_agent_model_catalog_cache", read);
  const view = renderInNodeScope(dialog(false), { role: "leaf", client: leaf });
  const models = view.scope.store(agentModelCatalogStore);
  const refresh = (nodeId: string | null) =>
    window.dispatchEvent(new CustomEvent(MODEL_CATALOG_REFRESHED_EVENT, { detail: nodeId }));
  expect(read).not.toHaveBeenCalled();

  view.rerender(dialog());
  await waitFor(() => expect(models.getState().codexModels[0]?.id).toBe("studio-cached"));
  read.mockImplementationOnce(() => {
    throw new Error("fixture catalogue unavailable");
  });
  await act(async () => {
    refresh("another-node");
    refresh(null);
  });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    refresh(LEAF);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(models.getState().codexModels[0]?.id).toBe("studio-cached");
  expect(screen.getByRole("dialog")).toBeTruthy();

  view.rerender(dialog(false));
  await act(async () => {
    refresh(LEAF);
  });
  expect(read).toHaveBeenCalledTimes(2);
});
