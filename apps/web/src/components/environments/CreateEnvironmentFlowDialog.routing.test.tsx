import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { BackendId } from "@orkestrator/protocol/federation";
import { createDefaultAppConfig } from "@orkestrator/protocol/app-config-defaults";
import { toNodeProjectSummary, type NodeSummary } from "@orkestrator/protocol/node-summaries";
import { configureInTreeScopes } from "@/lib/federation/in-tree-scopes";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { AppDialogHost } from "@/components/layout/AppDialogHost";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { invoke } from "@/lib/native/backend";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { agentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { configStore } from "@/stores/configStore";
import { projectStore } from "@/stores/projectStore";
import {
  startRemoteWorkspaceSelectionSync,
  useRemoteWorkspaceStore,
} from "@/stores/remoteWorkspaceStore";
import { FakeNodeClient, renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { AppConfig, Environment, Project } from "@/types";
import { CREATE_ENVIRONMENT_TARGET_TIMEOUT_MS } from "./create-environment-target";

const commandId = "bk_command" as BackendId;
const leafId = "bk_leaf" as BackendId;
const gitUrl = "https://github.com/acme/repo.git";
const commandProject = {
  id: "command-project",
  name: "Command checkout",
  localPath: "/command",
  gitUrl,
  order: 0,
} as Project;
const leafProject = {
  id: "leaf-project",
  name: "Leaf checkout",
  localPath: "/leaf",
  gitUrl,
  order: 0,
} as Project;
const created = { id: "leaf-new", projectId: leafProject.id, name: "new" } as Environment;
const commandProjectSelection = { nodeId: commandId, projectId: "elsewhere", environmentId: null };
const nativeInvoke = invoke as ReturnType<typeof mock>;
const remoteState = useRemoteWorkspaceStore.getState();
const portalState = portalStore.getState();
const stops: Array<() => void> = [];

afterEach(() => {
  cleanup();
  mock.restore();
  nativeInvoke.mockReset();
  for (const stop of stops.splice(0).reverse()) stop();
  useAppDialogStore.getState().close();
  portalStore.store.setState(portalState, true);
  useRemoteWorkspaceStore.setState(remoteState, true);
  resetWindowScopeForTests();
});

interface SetupOptions {
  leafReady?: boolean;
  project?: Project;
  leafDocker?: boolean;
  /** No scope is open for the leaf; the host opens it with this. */
  openLeaf?: () => Promise<NodeScope>;
}

function setup({
  leafReady = true,
  project = leafProject,
  leafDocker = false,
  openLeaf,
}: SetupOptions = {}) {
  nativeInvoke.mockImplementation(async (command: string) =>
    command === "create_feature_build"
      ? { pipelineId: "pipeline", environmentId: "env", ticketId: "ticket" }
      : null,
  );
  resetWindowScopeForTests(new FakeNodeClient({ nodeId: commandId }));
  const windowScope = getWindowScope();
  const commandScope = windowScope.commandScope();
  const leaf = new FakeNodeClient({
    nodeId: leafId,
    invoke: {
      get_projects: [project],
      check_docker: { available: leafDocker, reason: null },
      get_agent_model_catalog_cache: { schemaVersion: 1 },
      get_opencode_model_catalog_cache: null,
      get_project_base_branch_tip: () => Promise.reject(new Error("no base")),
      get_project_setup_requirements: { rootSteps: 0, aptPackages: null },
      patch_repository_settings: { repositories: {} },
      get_container_github_credential_status: { available: true },
      create_environment: created,
      update_environment_agent_settings: (args: Readonly<Record<string, unknown>>) => ({
        ...created,
        interactionMode: args.interactionMode,
      }),
      start_environment_background: null,
      create_feature_build: {
        pipelineId: "pipeline",
        environmentId: "leaf-built",
        ticketId: "ticket",
      },
      get_environment: null,
      get_build_pipeline: null,
    },
  });
  stops.push(
    configureInTreeScopes({
      prepare: null,
      startServices: () => () => undefined,
      ...(openLeaf ? { host: { kind: "browser" as const, openLeafScope: openLeaf } } : {}),
    }),
    startRemoteWorkspaceSelectionSync(),
  );
  const leafScope = openLeaf ? null : windowScope.open({ role: "leaf", client: leaf });
  leafScope?.store(configStore).setState({ hasLoaded: leafReady });
  commandScope
    .store(projectStore)
    .setState({ projects: [commandProject], hasLoaded: true, isLoading: false });
  commandScope.store(configStore).setState({ hasLoaded: true });
  portalStore.store.setState({
    selfId: commandId,
    loaded: true,
    nodes: [
      {
        nodeId: leafId,
        available: true,
        freshness: "current",
        environments: [],
        projects: [toNodeProjectSummary(leafId, leafProject, 0)!],
        view: { displayName: "Studio", connection: { state: "connected" } },
      } as unknown as NodeSummary,
    ],
  });
  spyOn(portalStore, "start").mockImplementation(() => () => undefined);
  renderInAppCommandScope(
    <FederationProvider>
      <DockerAvailabilityProvider available={false}>
        <AppDialogHost />
      </DockerAvailabilityProvider>
    </FederationProvider>,
  );
  windowScope.select(commandProjectSelection);
  return { leaf, leafScope: leafScope!, commandScope, windowScope };
}

function open(nodeId: BackendId, project: Project) {
  act(() =>
    openMachineWorkspace({
      connectionId: nodeId,
      projectId: project.id,
      title: project.name,
      createEnvironment: true,
    }),
  );
}

async function pick(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Machine" }));
  fireEvent.click(await screen.findByRole("option", { name }));
}

const form = () => screen.getByRole("dialog");
const machine = () => screen.getByRole<HTMLButtonElement>("combobox", { name: "Machine" });
const createButton = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: "Create environment" });
const promptField = () => screen.getByLabelText("Initial prompt (optional)") as HTMLTextAreaElement;
const nameField = () => screen.getByLabelText("Environment name (optional)") as HTMLInputElement;
const targetIs = (name: string) =>
  waitFor(() => expect(screen.queryByText(`Git worktree on ${name}`) !== null).toBe(true));

test("picking another machine keeps the same dialog, and the create goes to that machine", async () => {
  const { leaf, windowScope } = setup();
  const selections = mock((_selection: unknown) => undefined);
  stops.push(windowScope.selection.subscribe(selections));
  open(commandId, commandProject);
  await screen.findByRole("dialog");
  const dialog = form();
  const prompt = promptField();
  fireEvent.change(prompt, { target: { value: "Ship the report" } });
  fireEvent.change(nameField(), { target: { value: "report" } });
  fireEvent.click(screen.getByRole("button", { name: "Interactive" }));
  const file = new File(["notes"], "notes.md", { type: "text/markdown" });
  fireEvent.drop(dialog, {
    dataTransfer: { files: [file], types: ["Files"], dropEffect: "copy" },
  });
  await screen.findByText("notes.md");

  await pick("Studio");
  // The dropdown names it at once; nothing else in the window changes.
  expect(machine().textContent).toContain("Studio");
  await targetIs("Studio");
  expect(form()).toBe(dialog);
  expect(promptField()).toBe(prompt);
  expect(prompt.value).toBe("Ship the report");
  expect(nameField().value).toBe("report");
  expect(screen.getByText("notes.md")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Interactive", pressed: true })).toBeTruthy();
  expect(selections).not.toHaveBeenCalled();
  expect(useRemoteWorkspaceStore.getState().openNodes).toEqual([]);

  fireEvent.click(createButton());
  await waitFor(() => expect(leaf.calls("start_environment_background")).toHaveLength(1));
  expect(leaf.calls("create_environment")[0]?.args).toMatchObject({
    projectId: leafProject.id,
    name: "report",
    initialPrompt: "Ship the report",
  });
  expect(leaf.calls("update_environment_agent_settings")).toHaveLength(1);
  expect(nativeInvoke.mock.calls.some(([command]) => command === "create_environment")).toBe(false);
  // Only now does the window go to the machine, on the new environment.
  expect(windowScope.selection.get()).toMatchObject({
    nodeId: leafId,
    projectId: leafProject.id,
    environmentId: created.id,
  });
  expect(useRemoteWorkspaceStore.getState().active).toMatchObject({
    nodeId: leafId,
    environmentId: created.id,
  });
  expect(useAppDialogStore.getState().request).toBeNull();
});

test("a Pipeline build goes to the picked machine too", async () => {
  const { leaf } = setup();
  open(commandId, commandProject);
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
  fireEvent.change(screen.getByLabelText(/Feature name/), { target: { value: "Improve search" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Search by label" } });
  await pick("Studio");
  await targetIs("Studio");
  fireEvent.click(createButton());
  await waitFor(() => expect(leaf.calls("create_feature_build")).toHaveLength(1));
  expect(leaf.calls("create_feature_build")[0]?.args).toMatchObject({
    projectId: leafProject.id,
    title: "Improve search",
    description: "Search by label",
  });
  expect(nativeInvoke.mock.calls.some(([command]) => command === "create_feature_build")).toBe(
    false,
  );
  await waitFor(() =>
    expect(useRemoteWorkspaceStore.getState().active).toMatchObject({
      nodeId: leafId,
      environmentId: "leaf-built",
    }),
  );
});

test("opening it on another machine shows the dialog without moving the window, and can aim back", async () => {
  const { leaf, windowScope } = setup();
  open(leafId, leafProject);
  await screen.findByText("Leaf checkout");
  expect(machine().textContent).toContain("Studio");
  expect(windowScope.selection.get()).toEqual(commandProjectSelection);
  fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
  fireEvent.change(screen.getByLabelText(/Feature name/), { target: { value: "Improve search" } });

  await pick("This machine");
  await screen.findByText("Command checkout");
  expect((screen.getByLabelText(/Feature name/) as HTMLInputElement).value).toBe("Improve search");
  fireEvent.click(createButton());
  await waitFor(() =>
    expect(
      nativeInvoke.mock.calls.find(([command]) => command === "create_feature_build")?.[1],
    ).toMatchObject({ projectId: commandProject.id, title: "Improve search" }),
  );
  expect(leaf.calls("create_feature_build")).toHaveLength(0);
});

test("nothing can be created while the picked machine is made ready, and picking back cancels it", async () => {
  const { leaf, leafScope } = setup({ leafReady: false });
  open(commandId, commandProject);
  await screen.findByRole("dialog");
  await pick("Studio");
  expect(machine().textContent).toContain("Studio");
  expect(createButton().disabled).toBe(true);
  expect(screen.queryByText("Git worktree on Studio") === null).toBe(true);
  // The form stays usable.
  fireEvent.change(promptField(), { target: { value: "Typed while waiting" } });

  await pick("This machine");
  expect(createButton().disabled).toBe(false);
  await act(async () => leafScope.store(configStore).setState({ hasLoaded: true }));
  expect(machine().textContent).toContain("This machine");
  expect(screen.queryByText("Git worktree on Studio") === null).toBe(true);
  expect(promptField().value).toBe("Typed while waiting");
  expect(leaf.calls("create_environment")).toHaveLength(0);
});

const unusable: Array<[string, SetupOptions, string]> = [
  ["its project is gone", { project: { ...leafProject, id: "another" } }, "not on that machine"],
  [
    "it has neither a checkout nor Docker",
    { project: { ...leafProject, localPath: "" } },
    "no local checkout and Docker is unavailable",
  ],
  [
    "it cannot be reached",
    { openLeaf: () => Promise.reject(new Error("offline")) },
    "Could not connect: offline",
  ],
];
for (const [label, options, reason] of unusable) {
  test(`a machine is not switched to when ${label}, and the form stays as it was`, async () => {
    const error = spyOn(toast, "error").mockImplementation(() => "toast");
    setup(options);
    open(commandId, commandProject);
    await screen.findByRole("dialog");
    const dialog = form();
    fireEvent.change(promptField(), { target: { value: "Keep this" } });
    await pick("Studio");
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0]?.[0]).toBe("Could not switch to Studio");
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      description: expect.stringContaining(reason),
    });
    expect(form()).toBe(dialog);
    expect(machine().textContent).toContain("This machine");
    expect(promptField().value).toBe("Keep this");
    expect(createButton().disabled).toBe(false);
  });
}

test("a machine that never answers gives the form back after the time limit", async () => {
  const error = spyOn(toast, "error").mockImplementation(() => "toast");
  const clock = installControlledTimeout(CREATE_ENVIRONMENT_TARGET_TIMEOUT_MS, {
    label: "create-environment target",
  });
  try {
    setup({ openLeaf: () => new Promise(() => undefined) });
    open(commandId, commandProject);
    await screen.findByRole("dialog");
    await pick("Studio");
    expect(clock.pendingCount()).toBe(1);
    await act(async () => {
      expect(clock.advance()).toBe(1);
    });
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      description: expect.stringContaining("in time"),
    });
    expect(createButton().disabled).toBe(false);
    expect(clock.pendingCount()).toBe(0);
  } finally {
    clock.restore();
  }
});

test("closing while a machine is made ready drops the switch, and the next opening starts over", async () => {
  const error = spyOn(toast, "error").mockImplementation(() => "toast");
  const { leafScope } = setup({ leafReady: false });
  open(commandId, commandProject);
  await screen.findByRole("dialog");
  fireEvent.change(promptField(), { target: { value: "Draft" } });
  await pick("Studio");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => leafScope.store(configStore).setState({ hasLoaded: true }));
  expect(screen.queryByRole("dialog") === null).toBe(true);

  open(commandId, commandProject);
  await screen.findByRole("dialog");
  expect(machine().textContent).toContain("This machine");
  // The draft is the one kept for the machine the dialog opened on.
  expect(promptField().value).toBe("Draft");
  expect(error).not.toHaveBeenCalled();
});

test("a target whose scope closes falls back to the machine the dialog opened on", async () => {
  const error = spyOn(toast, "error").mockImplementation(() => "toast");
  const { leafScope } = setup();
  open(commandId, commandProject);
  await screen.findByRole("dialog");
  const dialog = form();
  fireEvent.change(promptField(), { target: { value: "Keep this" } });
  await pick("Studio");
  await targetIs("Studio");
  await act(async () => leafScope.dispose());
  await targetIs("This machine");
  expect(form()).toBe(dialog);
  expect(promptField().value).toBe("Keep this");
  expect(error.mock.calls[0]?.[0]).toBe("Studio is no longer connected");
});

test("the environment type follows what each machine can create, and comes back", async () => {
  setup({ project: { ...leafProject, localPath: "" }, leafDocker: true });
  open(commandId, commandProject);
  await screen.findByRole("dialog");
  // The command node has a checkout and no Docker; the leaf the opposite.
  await targetIs("This machine");
  await pick("Studio");
  await screen.findByText("Isolated Docker environment on Studio");
  await pick("This machine");
  await targetIs("This machine");
});

test("the chosen agent and model survive a machine without them, and a late model list", async () => {
  const { leafScope, commandScope } = setup();
  const config = createDefaultAppConfig() as unknown as AppConfig;
  const withAgents = (agents: string[]): AppConfig => ({
    ...config,
    global: {
      ...config.global,
      enabledAgentPlatforms: agents as AppConfig["global"]["enabledAgentPlatforms"],
      agentSettings: {
        ...config.global.agentSettings,
        defaultAgent: agents[0] as "codex" | "claude",
      },
    },
  });
  const models = (id: string) => [{ id, name: `Model ${id}` }];
  act(() => {
    commandScope
      .store(configStore)
      .getState()
      .setConfig(withAgents(["codex", "claude"]));
    commandScope.store(agentModelCatalogStore).setState({ codexModels: models("shared") as never });
    leafScope.store(agentModelCatalogStore).setState({ codexModels: models("other") as never });
  });
  const picker = () => screen.getByRole("combobox", { name: "Agent, model and reasoning" });
  open(commandId, commandProject);
  await screen.findByRole("dialog");
  await waitFor(() => expect(picker().textContent).toContain("Model shared"));

  await pick("Studio");
  await targetIs("Studio");
  await waitFor(() => expect(picker().textContent).toContain("Model other"));
  // The machine's list arrives with the chosen model in it.
  act(() =>
    leafScope
      .store(agentModelCatalogStore)
      .setState({ codexModels: [...models("other"), ...models("shared")] as never }),
  );
  await waitFor(() => expect(picker().textContent).toContain("Model shared"));

  // A machine where the agent is off uses its own default; going back restores it.
  await pick("This machine");
  await targetIs("This machine");
  act(() => {
    const store = leafScope.store(configStore);
    const { config: current } = store.getState();
    store.setState({
      config: { ...current, global: { ...current.global, enabledAgentPlatforms: ["claude"] } },
    });
  });
  await pick("Studio");
  await targetIs("Studio");
  await waitFor(() => expect(picker().textContent).not.toContain("Model"));
  await pick("This machine");
  await targetIs("This machine");
  await waitFor(() => expect(picker().textContent).toContain("Model shared"));
});

test("picker uses loaded project rows and confirmed Docker availability", async () => {
  const { leafScope } = setup();
  act(() => leafScope.store(projectStore).setState({ projects: [leafProject], hasLoaded: true }));
  open(commandId, commandProject);
  const picker = () => screen.getByRole<HTMLButtonElement>("combobox", { name: "Machine" });
  expect(picker().disabled).toBe(false);

  act(() => {
    leafScope.setTier("warm");
    leafScope.store(projectStore).setState({ projects: [{ ...leafProject, localPath: "" }] });
    const [summary] = portalStore.getState().nodes;
    portalStore.store.setState({
      nodes: [
        {
          ...summary!,
          environments: [{ dockerAvailable: false, projectId: leafProject.id }],
          projects: [toNodeProjectSummary(leafId, { ...leafProject, localPath: "" }, 0)!],
        } as NodeSummary,
      ],
    });
  });
  expect(picker().disabled).toBe(true);

  act(() => {
    const [summary] = portalStore.getState().nodes;
    portalStore.store.setState({
      nodes: [
        {
          ...summary!,
          environments: [{ dockerAvailable: true, projectId: leafProject.id }],
        } as NodeSummary,
      ],
    });
  });
  expect(picker().disabled).toBe(false);

  act(() => leafScope.store(projectStore).setState({ projects: [], hasLoaded: true }));
  expect(picker().disabled).toBe(true);
});

test("a project without a Git remote only offers its own machine", () => {
  const { windowScope } = setup();
  act(() =>
    windowScope
      .commandScope()
      .store(projectStore)
      .setState({
        projects: [{ ...commandProject, gitUrl: "" }],
      }),
  );
  open(commandId, commandProject);
  const picker = screen.getByRole<HTMLButtonElement>("combobox", { name: "Machine" });
  expect(picker.textContent).toContain("This machine");
  expect(picker.disabled).toBe(true);
});

test("a remote-only command project waits for an unknown Docker probe", async () => {
  const { windowScope } = setup();
  const docker = Promise.withResolvers<{ available: true; reason: null }>();
  const command = windowScope.commandScope();
  nativeInvoke.mockImplementation(async (name: string) =>
    name === "check_docker" ? docker.promise : null,
  );
  act(() =>
    command.store(projectStore).setState({
      projects: [{ ...commandProject, localPath: "" }],
    }),
  );
  open(leafId, leafProject);
  const picker = await screen.findByRole<HTMLButtonElement>("combobox", { name: "Machine" });
  expect(picker.disabled).toBe(true);
  await act(async () => docker.resolve({ available: true, reason: null }));
  expect(picker.disabled).toBe(false);
});

test("going elsewhere before the machine answers drops the request", async () => {
  const { leafScope, windowScope } = setup({ leafReady: false });
  open(leafId, leafProject);
  // A wait long enough to notice is shown, and can be cancelled.
  expect(await screen.findByText(/Connecting to Studio/)).toBeTruthy();
  act(() => windowScope.select({ nodeId: commandId, projectId: "other", environmentId: null }));
  expect(useAppDialogStore.getState().request).toBeNull();
  await act(async () => leafScope.store(configStore).setState({ hasLoaded: true }));
  expect(screen.queryByRole("dialog") === null).toBe(true);
});

test("a machine that cannot be reached says so instead of opening the form", async () => {
  const error = spyOn(toast, "error").mockImplementation(() => "toast");
  setup({ openLeaf: () => Promise.reject(new Error("offline")) });
  open(leafId, leafProject);
  await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  expect(error.mock.calls[0]?.[0]).toBe("Could not open the new environment form on Studio");
  expect(useAppDialogStore.getState().request).toBeNull();
});
