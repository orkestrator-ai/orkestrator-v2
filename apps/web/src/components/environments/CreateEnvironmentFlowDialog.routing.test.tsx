import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { BackendId } from "@orkestrator/protocol/federation";
import { toNodeProjectSummary, type NodeSummary } from "@orkestrator/protocol/node-summaries";
import { NodeWorkspaceHost } from "@/components/federation/NodeWorkspaceHost";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { AppDialogHost } from "@/components/layout/AppDialogHost";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { invoke } from "@/lib/native/backend";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { NodeScopeProvider } from "@/lib/node-scope/providers";
import { useProjectHomeActivation } from "@/hooks/useProjectHomeActivation";
import {
  reportCreateEnvironmentFailed,
  stopCreateEnvironmentWatches,
} from "@/lib/federation/create-environment-handoff";
import { portalStore } from "@/lib/portal/portal-store";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { configStore } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import {
  startRemoteWorkspaceSelectionSync,
  useRemoteWorkspaceStore,
} from "@/stores/remoteWorkspaceStore";
import { FakeNodeClient, renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { Environment, Project } from "@/types";

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
/** The leaf project's Home, which its workspace opens when the project is selected. */
const leafHome = {
  id: "leaf-home",
  projectId: leafProject.id,
  name: "Leaf checkout Home",
  projectHome: true,
  environmentType: "local",
  status: "running",
  worktreePath: leafProject.localPath,
} as Environment;
const nativeInvoke = invoke as ReturnType<typeof mock>;
const remoteState = useRemoteWorkspaceStore.getState();
const portalState = portalStore.getState();
let stopSync: (() => void) | undefined;

afterEach(() => {
  stopCreateEnvironmentWatches();
  cleanup();
  mock.restore();
  nativeInvoke.mockReset();
  stopSync?.();
  useAppDialogStore.getState().close();
  portalStore.store.setState(portalState, true);
  useRemoteWorkspaceStore.setState(remoteState, true);
  resetWindowScopeForTests();
});

/** The part of a node's workspace that opens a selected project's Home. */
function HomeActivation() {
  useProjectHomeActivation();
  return null;
}

function setup(leafReady: boolean, { leafHome: withHome = false } = {}) {
  nativeInvoke.mockImplementation(async (command: string) =>
    command === "create_feature_build"
      ? { pipelineId: "pipeline", environmentId: "env", ticketId: "ticket" }
      : null,
  );
  const command = new FakeNodeClient({ nodeId: commandId });
  resetWindowScopeForTests(command);
  const windowScope = getWindowScope();
  const leaf = new FakeNodeClient({
    nodeId: leafId,
    invoke: {
      get_projects: [leafProject],
      get_environments: withHome ? [leafHome] : [],
      get_environment_snapshots: [],
      create_environment: (args: Record<string, unknown>) => ({
        ...leafHome,
        id: "leaf-new",
        name: String(args.name ?? "new"),
        projectHome: false,
      }),
      update_environment_agent_settings: { ...leafHome, id: "leaf-new", projectHome: false },
    },
  });
  const leafScope = windowScope.open({ role: "leaf", client: leaf });
  leafScope.store(configStore).setState({ hasLoaded: leafReady });
  leafScope.store(projectStore).setState({ projects: [leafProject], hasLoaded: true });
  if (withHome) leafScope.store(environmentStore).setState({ environments: [leafHome] });
  windowScope
    .commandScope()
    .store(projectStore)
    .setState({ projects: [commandProject], hasLoaded: true });
  windowScope.commandScope().store(configStore).setState({ hasLoaded: true });
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
  stopSync = startRemoteWorkspaceSelectionSync();
  spyOn(portalStore, "start").mockImplementation(() => () => undefined);
  renderInAppCommandScope(
    <FederationProvider>
      <DockerAvailabilityProvider available={false}>
        <AppDialogHost />
        <NodeScopeProvider scope={leafScope}>
          <NodeWorkspaceHost />
          {withHome ? <HomeActivation /> : null}
        </NodeScopeProvider>
      </DockerAvailabilityProvider>
    </FederationProvider>,
  );
  return { leaf, leafScope, windowScope };
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

test("switches to the command machine without a sidebar and starts a Pipeline on its backend", async () => {
  const { leaf } = setup(true);
  open(leafId, leafProject);
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
  fireEvent.change(screen.getByLabelText(/Feature name/), { target: { value: "Improve search" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Search by label" } });
  fireEvent.change(screen.getByLabelText("Acceptance criteria"), {
    target: { value: "Matches saved labels" },
  });

  await pick("This machine");
  await screen.findByText("Command checkout");
  expect((screen.getByLabelText(/Feature name/) as HTMLInputElement).value).toBe("Improve search");
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
    "Search by label",
  );
  expect((screen.getByLabelText("Acceptance criteria") as HTMLTextAreaElement).value).toBe(
    "Matches saved labels",
  );
  fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
  await waitFor(() =>
    expect(
      nativeInvoke.mock.calls.filter(([command]) => command === "create_feature_build"),
    ).toHaveLength(1),
  );
  const args = nativeInvoke.mock.calls.find(([command]) => command === "create_feature_build")?.[1];
  expect(args).toMatchObject({
    projectId: commandProject.id,
    title: "Improve search",
    description: "Search by label",
    acceptanceCriteria: "Matches saved labels",
  });
  expect(leaf.calls("create_feature_build")).toHaveLength(0);
});

test("cancelling a switch during destination hydration discards its form and preserves the source draft", async () => {
  const { leafScope, windowScope } = setup(false);
  open(commandId, commandProject);
  fireEvent.change(screen.getByLabelText("Initial prompt (optional)"), {
    target: { value: "Recover this draft" },
  });
  fireEvent.change(screen.getByLabelText("Environment name (optional)"), {
    target: { value: "pending-name" },
  });
  await pick("Studio");
  expect(screen.queryByRole("dialog") === null).toBe(true);
  expect(
    useRemoteWorkspaceStore.getState().requests[leafId]?.request.createEnvironmentHandoff?.name,
  ).toBe("pending-name");

  act(() => windowScope.select({ nodeId: leafId, projectId: "other", environmentId: null }));
  act(() => leafScope.store(configStore).setState({ hasLoaded: true }));
  expect(useRemoteWorkspaceStore.getState().requests[leafId]).toBeUndefined();
  expect(screen.queryByRole("dialog") === null).toBe(true);

  open(leafId, leafProject);
  await screen.findByRole("dialog");
  expect((screen.getByLabelText("Initial prompt (optional)") as HTMLTextAreaElement).value).toBe(
    "",
  );
  expect((screen.getByLabelText("Environment name (optional)") as HTMLInputElement).value).toBe("");

  open(commandId, commandProject);
  await waitFor(() =>
    expect((screen.getByLabelText("Initial prompt (optional)") as HTMLTextAreaElement).value).toBe(
      "Recover this draft",
    ),
  );
  expect((screen.getByLabelText("Environment name (optional)") as HTMLInputElement).value).toBe(
    "pending-name",
  );
});

test("picker uses loaded project rows and confirmed Docker availability", async () => {
  const { leafScope } = setup(true);
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
  const { windowScope } = setup(true);
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
  const { windowScope } = setup(true);
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

test("navigation cancels a return to the command node while its dialog is loading", async () => {
  const { windowScope } = setup(true);
  const config = windowScope.commandScope().store(configStore);
  act(() => config.setState({ hasLoaded: false }));
  open(leafId, leafProject);
  await screen.findByRole("dialog");
  fireEvent.change(screen.getByLabelText("Initial prompt (optional)"), {
    target: { value: "Pending command handoff" },
  });
  await pick("This machine");
  expect(screen.queryByRole("dialog") === null).toBe(true);

  act(() => windowScope.select({ nodeId: commandId, projectId: "other", environmentId: null }));
  act(() => config.setState({ hasLoaded: true }));
  expect(useAppDialogStore.getState().request).toBeNull();
  expect(screen.queryByRole("dialog") === null).toBe(true);

  open(commandId, commandProject);
  await screen.findByRole("dialog");
  expect((screen.getByLabelText("Initial prompt (optional)") as HTMLTextAreaElement).value).toBe(
    "",
  );
});

const promptField = () => screen.getByLabelText("Initial prompt (optional)") as HTMLTextAreaElement;
const nameField = () => screen.getByLabelText("Environment name (optional)") as HTMLInputElement;

test("switching to a machine whose project opens on its Home keeps the form there, prefilled", async () => {
  const { leaf, windowScope } = setup(true, { leafHome: true });
  open(commandId, commandProject);
  await screen.findByRole("dialog");
  fireEvent.change(promptField(), { target: { value: "Ship the report" } });
  fireEvent.change(nameField(), { target: { value: "report" } });
  fireEvent.click(screen.getByRole("button", { name: "Interactive" }));

  await pick("Studio");
  // The leaf's workspace opens the project's Home behind its dialog. That
  // used to drop the request and leave the Home tab without the form.
  await waitFor(() =>
    expect(windowScope.selection.get()).toMatchObject({
      nodeId: leafId,
      projectId: leafProject.id,
      environmentId: leafHome.id,
    }),
  );
  await screen.findByText("Leaf checkout");
  expect(useRemoteWorkspaceStore.getState().requests[leafId]?.request).toMatchObject({
    createEnvironmentProjectId: leafProject.id,
  });
  expect(screen.getByRole("combobox", { name: "Machine" }).textContent).toContain("Studio");
  expect(promptField().value).toBe("Ship the report");
  expect(nameField().value).toBe("report");
  expect(screen.getByRole("button", { name: "Interactive", pressed: true })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
  await waitFor(() =>
    expect(leaf.invocations.map((call) => call.command)).toContain("create_environment"),
  );
  expect(
    leaf.invocations.find((call) => call.command === "create_environment")?.args,
  ).toMatchObject({ projectId: leafProject.id, name: "report" });
  expect(nativeInvoke.mock.calls.some(([command]) => command === "create_environment")).toBe(false);
});

test("a destination workspace that is already open still shows the form, prefilled", async () => {
  const { windowScope } = setup(true, { leafHome: true });
  // The user has been working in the leaf's project Home.
  act(() =>
    openMachineWorkspace({ connectionId: leafId, projectId: leafProject.id, title: "Leaf" }),
  );
  await waitFor(() =>
    expect(windowScope.selection.get()).toMatchObject({
      nodeId: leafId,
      environmentId: leafHome.id,
    }),
  );
  open(commandId, commandProject);
  await screen.findByText("Command checkout");
  fireEvent.change(promptField(), { target: { value: "Again on the leaf" } });

  await pick("Studio");
  await screen.findByText("Leaf checkout");
  await waitFor(() =>
    expect(windowScope.selection.get()).toMatchObject({ environmentId: leafHome.id }),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(promptField().value).toBe("Again on the leaf");
});

test("a destination without the project says so and brings the form back with its input", async () => {
  const error = spyOn(toast, "error").mockImplementation(() => "toast");
  const { leafScope } = setup(false);
  open(commandId, commandProject);
  await screen.findByText("Command checkout");
  fireEvent.change(promptField(), { target: { value: "Keep this" } });
  fireEvent.change(nameField(), { target: { value: "kept" } });
  await pick("Studio");
  expect(screen.queryByRole("dialog") === null).toBe(true);

  // Once the leaf has loaded, its copy of the project is gone.
  act(() => {
    leafScope.store(projectStore).setState({ projects: [], hasLoaded: true });
    leafScope.store(configStore).setState({ hasLoaded: true });
  });
  await screen.findByText("Command checkout");
  expect(promptField().value).toBe("Keep this");
  expect(nameField().value).toBe("kept");
  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0]?.[0]).toBe("Could not open the new environment form on Studio");
  expect(String((error.mock.calls[0]?.[1] as { description?: string })?.description)).toContain(
    "The project is not on that machine any more.",
  );
});

test("a destination that cannot be reached brings the form back with its input", async () => {
  const error = spyOn(toast, "error").mockImplementation(() => "toast");
  setup(false);
  open(commandId, commandProject);
  await screen.findByText("Command checkout");
  fireEvent.change(promptField(), { target: { value: "Unreachable" } });
  await pick("Studio");
  expect(screen.queryByRole("dialog") === null).toBe(true);

  // What the leaf's workspace reports when its scope cannot be opened.
  act(() => reportCreateEnvironmentFailed(leafId, null, "Could not connect: offline"));
  await screen.findByText("Command checkout");
  expect(promptField().value).toBe("Unreachable");
  expect(useRemoteWorkspaceStore.getState().requests[leafId]).toBeUndefined();
  expect(error).toHaveBeenCalledTimes(1);
});

test("navigating away from a pending switch cancels it without bringing the form back", async () => {
  const error = spyOn(toast, "error").mockImplementation(() => "toast");
  const { windowScope } = setup(false);
  open(commandId, commandProject);
  await screen.findByText("Command checkout");
  await pick("Studio");
  act(() => windowScope.select({ nodeId: leafId, projectId: "other", environmentId: null }));
  act(() => reportCreateEnvironmentFailed(leafId, null, "Could not connect: offline"));
  expect(screen.queryByRole("dialog") === null).toBe(true);
  expect(error).not.toHaveBeenCalled();
});
