import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { CreateEnvironmentHandoff } from "@/lib/federation/workspace-request";
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
import { CreateEnvironmentDialog, type ClaudeOptions } from "./CreateEnvironmentDialog";
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
  onSelectMachine: (machine: CreateEnvironmentMachine, form: CreateEnvironmentHandoff) => boolean,
  {
    projectId = "project-1",
    handoff,
    onOpenChange = () => undefined,
    isLoading = false,
    localEnvironmentAvailable = true,
  }: {
    projectId?: string;
    handoff?: CreateEnvironmentHandoff;
    onOpenChange?: (open: boolean) => void;
    isLoading?: boolean;
    localEnvironmentAvailable?: boolean;
  } = {},
) {
  return (
    <DockerAvailabilityProvider available>
      <CreateEnvironmentDialog
        open
        onOpenChange={onOpenChange}
        isLoading={isLoading}
        localEnvironmentAvailable={localEnvironmentAvailable}
        onCreate={async () => true}
        projectId={projectId}
        handoff={handoff}
        machines={machines}
        onSelectMachine={onSelectMachine}
      />
    </DockerAvailabilityProvider>
  );
}

describe("CreateEnvironmentDialog machine dropdown", () => {
  test("sits in the header and lists only the machines that can take the environment", async () => {
    federated();
    renderInAppCommandScope(dialogWithMachines([OWN, STUDIO], () => true));
    const header = screen.getByRole("dialog").querySelector("[data-slot='dialog-header']");
    const select = screen.getByRole("combobox", { name: "Machine" });
    expect(header?.contains(select)).toBe(true);
    expect(select.textContent).toContain("Build Mac");
    expect(select.querySelector("[data-machine-color]")?.getAttribute("data-machine-color")).toBe(
      "teal",
    );
    expect((select as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(select);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Build Mac", "Studio"]);
  });

  test("with no other machine holding the repository it names this one, disabled", () => {
    federated();
    renderInAppCommandScope(dialogWithMachines([OWN], () => true));
    const select = screen.getByRole("combobox", { name: "Machine" }) as HTMLButtonElement;
    expect(select.textContent).toContain("Build Mac");
    expect(select.disabled).toBe(true);
  });

  test("disables switching during creation even when an alternative is available", () => {
    federated();
    renderInAppCommandScope(dialogWithMachines([OWN, STUDIO], () => true, { isLoading: true }));
    expect((screen.getByRole("combobox", { name: "Machine" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  for (const prompt of ["", "Add a dark mode"]) {
    test(`preserves an existing destination draft with a ${prompt ? "populated" : "blank"} handoff`, async () => {
      federated();
      const projectId = `project-draft-${Boolean(prompt)}`;
      const handoff = { prompt, name: "dark-mode" };
      const showTarget = (form?: CreateEnvironmentHandoff) =>
        renderInAppCommandScope(
          dialogWithMachines([STUDIO], () => true, { projectId, handoff: form }),
        );
      const promptField = () =>
        screen.getByLabelText("Initial prompt (optional)") as HTMLTextAreaElement;
      const nameField = () =>
        screen.getByLabelText("Environment name (optional)") as HTMLInputElement;
      const close = () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

      showTarget();
      fireEvent.change(promptField(), { target: { value: "Existing draft" } });
      close();
      cleanup();

      showTarget(handoff);
      expect(promptField().value).toBe(prompt || "Existing draft");
      expect(nameField().value).toBe("dark-mode");
      close();
      cleanup();

      showTarget({ prompt: "", name: "" });
      expect(promptField().value).toBe("Existing draft");
      expect(nameField().value).toBe("");
      cleanup();

      showTarget();
      expect(promptField().value).toBe("Existing draft");
      expect(nameField().value).toBe("");
    });
  }

  test("an interactive handoff and source draft override the remembered Task choice", async () => {
    federated();
    const onSelectMachine = mock(
      (_machine: CreateEnvironmentMachine, _form: CreateEnvironmentHandoff) => true,
    );
    const projectId = "project-recovery";
    const store = appCommandStore(configStore);
    const initialConfig = store.getState().config;
    const rememberedTask = {
      defaultBranch: "main",
      prBaseBranch: "main",
      lastBuildIntent: "task",
    } as const;
    store.getState().setConfig({
      ...initialConfig,
      repositories: {
        ...initialConfig.repositories,
        [projectId]: rememberedTask,
        [STUDIO.projectId]: rememberedTask,
      },
    });
    try {
      renderInAppCommandScope(dialogWithMachines([OWN, STUDIO], onSelectMachine, { projectId }));
      expect(screen.getByRole("button", { name: "Task", pressed: true })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Interactive" }));
      fireEvent.change(screen.getByLabelText("Environment name (optional)"), {
        target: { value: "dark-mode" },
      });
      fireEvent.change(screen.getByLabelText("Initial prompt (optional)"), {
        target: { value: "Add a dark mode" },
      });
      fireEvent.click(screen.getByRole("combobox", { name: "Machine" }));
      fireEvent.click(await screen.findByRole("option", { name: /Studio/ }));
      const handoff = {
        prompt: "Add a dark mode",
        name: "dark-mode",
        interactionMode: "interactive",
        environmentType: "containerized",
        agent: { type: "claude", model: "sonnet", reasoningEffort: "default" },
      } satisfies CreateEnvironmentHandoff;
      expect(onSelectMachine.mock.calls[0]?.slice(0, 2)).toEqual([STUDIO, handoff]);
      cleanup();

      renderInAppCommandScope(
        dialogWithMachines([STUDIO], () => true, { projectId: STUDIO.projectId, handoff }),
      );
      expect(screen.getByRole("button", { name: "Interactive", pressed: true })).toBeTruthy();
      cleanup();

      renderInAppCommandScope(dialogWithMachines([OWN], () => true, { projectId }));
      expect(screen.getByRole("button", { name: "Interactive", pressed: true })).toBeTruthy();
      expect(
        (screen.getByLabelText("Initial prompt (optional)") as HTMLTextAreaElement).value,
      ).toBe("Add a dark mode");
    } finally {
      cleanup();
      store.getState().setConfig(initialConfig);
    }
  });
});

describe("CreateEnvironmentDialog machine switch carries the form", () => {
  const carried = {
    prompt: "Ship the report",
    name: "report",
    interactionMode: "task",
    environmentType: "local",
    agent: { type: "codex", model: "not-in-this-catalogue", reasoningEffort: "high" },
  } satisfies CreateEnvironmentHandoff;

  async function switchToStudio(
    onSelectMachine: ReturnType<
      typeof mock<(machine: CreateEnvironmentMachine, form: CreateEnvironmentHandoff) => boolean>
    >,
  ) {
    fireEvent.click(screen.getByRole("combobox", { name: "Machine" }));
    fireEvent.click(await screen.findByRole("option", { name: /Studio/ }));
    return onSelectMachine.mock.calls.at(-1)?.[1];
  }

  test("the switch sends the environment type and agent with the rest of the form", async () => {
    federated();
    const onSelectMachine = mock(
      (_machine: CreateEnvironmentMachine, _form: CreateEnvironmentHandoff) => true,
    );
    renderInAppCommandScope(dialogWithMachines([OWN, STUDIO], onSelectMachine));
    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    const form = await switchToStudio(onSelectMachine);
    expect(form?.environmentType).toBe("local");
    expect(form?.agent?.type).toBe("claude");
  });

  test("a carried environment type and agent survive Strict Mode effect replay", async () => {
    federated();
    const onSelectMachine = mock(
      (_machine: CreateEnvironmentMachine, _form: CreateEnvironmentHandoff) => true,
    );
    renderInAppCommandScope(
      dialogWithMachines([OWN, STUDIO], onSelectMachine, { handoff: carried }),
      { reactStrictMode: true },
    );
    // Containerized is this dialog's default; the carried Local wins.
    expect(screen.queryByText("Git worktree on Build Mac") !== null).toBe(true);
    expect((screen.getByLabelText("Initial prompt (optional)") as HTMLTextAreaElement).value).toBe(
      "Ship the report",
    );
    expect((screen.getByLabelText("Environment name (optional)") as HTMLInputElement).value).toBe(
      "report",
    );
    expect(screen.getByRole("button", { name: "Task", pressed: true })).toBeTruthy();
    const form = await switchToStudio(onSelectMachine);
    expect(form).toMatchObject({
      prompt: "Ship the report",
      name: "report",
      interactionMode: "task",
      environmentType: "local",
    });
    // The agent is kept; a model this machine does not list falls back to its default.
    expect(form?.agent?.type).toBe("codex");
    expect(form?.agent?.model).not.toBe("not-in-this-catalogue");
  });

  test("a type the destination cannot create falls back to one it can", () => {
    federated();
    renderInAppCommandScope(
      dialogWithMachines([OWN, STUDIO], () => true, {
        handoff: carried,
        localEnvironmentAvailable: false,
      }),
    );
    expect(screen.queryByText("Isolated Docker environment on Build Mac") !== null).toBe(true);
  });

  test("an agent the destination has not enabled keeps its default agent", async () => {
    federated();
    const store = appCommandStore(configStore);
    const initialConfig = store.getState().config;
    store.getState().setConfig({
      ...initialConfig,
      global: { ...initialConfig.global, enabledAgentPlatforms: ["claude"] },
    });
    try {
      const onSelectMachine = mock(
        (_machine: CreateEnvironmentMachine, _form: CreateEnvironmentHandoff) => true,
      );
      renderInAppCommandScope(
        dialogWithMachines([OWN, STUDIO], onSelectMachine, { handoff: carried }),
      );
      const form = await switchToStudio(onSelectMachine);
      expect(form?.agent?.type).toBe("claude");
    } finally {
      cleanup();
      store.getState().setConfig(initialConfig);
    }
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

for (const editsModel of [false, true]) {
  test(`a late OpenCode catalogue ${editsModel ? "respects the user's model selection" : "restores the carried model and effort"}`, async () => {
    const cachedModel = {
      id: "fixture/late",
      name: "Late OpenCode model",
      provider: "Fixture",
      variants: ["high"],
    };
    const catalogue = Promise.withResolvers<{
      projectId: string;
      models: (typeof cachedModel)[];
    }>();
    const onCreate = mock(async (_options: ClaudeOptions) => true);
    const leaf = new FakeNodeClient({ nodeId: LEAF }).respond(
      "get_opencode_model_catalog_cache",
      () => catalogue.promise,
    );
    const view = renderInNodeScope(<></>, { role: "leaf", client: leaf });
    view.scope
      .store(configStore)
      .setState({ config: appCommandStore(configStore).getState().config });
    view.rerender(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={() => undefined}
          onCreate={onCreate}
          projectId="project-1"
          handoff={{
            name: "carried-model",
            prompt: "",
            agent: { type: "opencode", model: cachedModel.id, reasoningEffort: "high" },
          }}
        />
      </DockerAvailabilityProvider>,
    );

    if (editsModel) {
      const picker = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
      fireEvent.keyDown(picker, { key: "Enter" });
      fireEvent.click(await screen.findByRole("button", { name: "claude models" }));
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    }
    await act(async () => catalogue.resolve({ projectId: "project-1", models: [cachedModel] }));
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    if (editsModel) {
      expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ agentType: "claude" });
    } else {
      expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
        agentType: "opencode",
        model: cachedModel.id,
        reasoningEffort: "high",
      });
    }
  });
}
