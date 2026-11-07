import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { FullscreenSettingsLayout } from "@/components/settings/FullscreenSettingsLayout";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { portalStore } from "@/lib/portal/portal-store";
import * as realEnvironmentSettingsDialog from "@/components/environments/EnvironmentSettingsDialog";
import { invoke } from "@/lib/native/backend";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { configStore } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { uiStore } from "@/stores/uiStore";
import { projectStore } from "@/stores/projectStore";
import type { Environment, Project } from "@/types";
import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { useNodeScope, WindowScopeProvider } from "@/lib/node-scope/providers";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { appCommandStore } from "@/test/app-command-store";

/** Outside a node scope provider, components act for the app's command node. */
const commandNodeId = () => getWindowScope().commandScope().nodeId;

const realEnvironmentSettingsDialogSnapshot = { ...realEnvironmentSettingsDialog };

/** Stands in for a dialog that acts through its scope's client (plan item 5003). */
function ActOnNode({ environmentId }: { environmentId: string }) {
  const scope = useNodeScope();
  return (
    <button
      type="button"
      onClick={() => void scope.client.invokeRaw("act_on_environment", { environmentId })}
    >
      Act on {scope.nodeId}
    </button>
  );
}
const nativeInvoke = invoke as ReturnType<typeof mock>;
const initialProjects = appCommandStore(projectStore).getState();
const project = { id: "project-1", name: "app", gitUrl: "", order: 0 } as unknown as Project;

mock.module("@/components/environments/EnvironmentSettingsDialog", () => ({
  EnvironmentSettingsDialog: ({
    environment,
    onOpenChange,
    onRestart,
    onUpdate,
    open,
    initialSection,
    sectionRequest,
  }: {
    environment: Environment;
    onOpenChange: (open: boolean) => void;
    onRestart: (
      environmentId: string,
      options: { intent: "discard"; expectedContainerId: string | null },
    ) => Promise<void>;
    onUpdate: (environment: Environment) => void;
    open: boolean;
    initialSection?: string;
    sectionRequest?: number;
  }) =>
    open ? (
      <FullscreenSettingsLayout
        open={open}
        onOpenChange={onOpenChange}
        title="Environment Settings"
        menuItems={[
          { id: "first", label: "General", icon: null },
          { id: "container", label: "Container", icon: null },
          { id: "ports", label: "Ports", icon: null },
        ]}
        defaultSection={initialSection}
        sectionRequest={sectionRequest}
      >
        {(active) => (
          <>
            <span>Settings for {environment.name}</span>
            <ActOnNode environmentId={environment.id} />
            <span>Section: {active}</span>
            <button type="button" onClick={() => onUpdate({ ...environment, status: "stopping" })}>
              Stop from settings
            </button>
            <button
              type="button"
              onClick={() =>
                void onRestart(environment.id, {
                  intent: "discard",
                  expectedContainerId: environment.containerId ?? null,
                })
              }
            >
              Restart from settings
            </button>
          </>
        )}
      </FullscreenSettingsLayout>
    ) : null,
}));

const { AppDialogHost } = await import("./AppDialogHost");

function environment(id: string, name: string): Environment {
  return {
    id,
    projectId: "project-1",
    name,
    order: 0,
    environmentType: "containerized",
    status: "running",
    networkAccessMode: "restricted",
    createdAt: "2026-10-16T00:00:00.000Z",
  } as Environment;
}

function requestSettings(environmentId: string) {
  act(() => {
    useAppDialogStore
      .getState()
      .open({ nodeId: commandNodeId(), kind: "environment-settings", environmentId });
  });
}

beforeEach(() => {
  useAppDialogStore.setState({ request: null });
  appCommandStore(environmentStore).setState({
    environments: [environment("env-1", "first-env"), environment("env-2", "second-env")],
  });
});

afterEach(() => {
  cleanup();
  // Back to tests/setup.ts's answer: a reset mock answers `undefined`, which a
  // later file's `invoke(...).catch` in the same process cannot take.
  nativeInvoke.mockReset();
  nativeInvoke.mockImplementation(() => Promise.resolve());
  appCommandStore(projectStore).setState(initialProjects, true);
});

afterAll(() => {
  mock.module(
    "@/components/environments/EnvironmentSettingsDialog",
    () => realEnvironmentSettingsDialogSnapshot,
  );
});

describe("AppDialogHost", () => {
  test("shows the settings of the requested environment and closes them", async () => {
    render(<AppDialogHost />);
    expectDomAbsent(screen.queryByRole("dialog"));

    requestSettings("env-2");
    expect(await screen.findByText("Settings for second-env")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expectDomAbsent(screen.queryByRole("dialog"));
    expect(useAppDialogStore.getState().request).toBeNull();
  });

  test("opens an environment's settings on the section the request names", async () => {
    render(<AppDialogHost />);
    act(() => {
      useAppDialogStore.getState().open({
        nodeId: commandNodeId(),
        kind: "environment-settings",
        environmentId: "env-1",
        section: "container",
      });
    });
    expect(await screen.findByText("Section: container")).toBeTruthy();
  });

  test("writes a settings change to the environment store, which every row reads", async () => {
    render(<AppDialogHost />);
    requestSettings("env-1");

    fireEvent.click(await screen.findByRole("button", { name: "Stop from settings" }));

    expect(
      appCommandStore(environmentStore)
        .getState()
        .environments.find((candidate) => candidate.id === "env-1")?.status,
    ).toBe("stopping");
  });

  test("follows a background update to the requested environment", async () => {
    render(<AppDialogHost />);
    requestSettings("env-1");
    expect(await screen.findByText("Settings for first-env")).toBeTruthy();

    // The request pins an id, not a snapshot, so a sync that renames the
    // environment reaches the open dialog.
    act(() => {
      appCommandStore(environmentStore)
        .getState()
        .updateEnvironment("env-1", { name: "renamed-by-sync" });
    });

    expect(screen.getByText("Settings for renamed-by-sync")).toBeTruthy();
  });

  test("restarts the requested environment through the backend", async () => {
    render(<AppDialogHost />);
    requestSettings("env-2");

    fireEvent.click(await screen.findByRole("button", { name: "Restart from settings" }));

    await waitFor(() =>
      expect(nativeInvoke).toHaveBeenCalledWith("recreate_environment", {
        environmentId: "env-2",
        intent: "discard",
        expectedContainerId: null,
      }),
    );
  });

  test("drops the request when its environment disappears", async () => {
    render(<AppDialogHost />);
    requestSettings("env-1");
    expect(await screen.findByText("Settings for first-env")).toBeTruthy();

    act(() => {
      appCommandStore(environmentStore).setState({
        environments: [environment("env-2", "second-env")],
      });
    });

    expectDomAbsent(screen.queryByRole("dialog"));
    expect(useAppDialogStore.getState().request).toBeNull();
    // A later environment that reuses the id does not reopen the dialog.
    act(() => {
      appCommandStore(environmentStore).setState({
        environments: [environment("env-1", "reused-id")],
      });
    });
    expectDomAbsent(screen.queryByRole("dialog"));
  });

  test("confirms deleting a project, counting its environments but not its home", async () => {
    // The dialog's own project and environment hooks read the node's list.
    nativeInvoke.mockImplementation(async (command: string) =>
      command === "get_projects" ? [project] : undefined,
    );
    appCommandStore(projectStore).setState({ projects: [project], hasLoaded: true });
    appCommandStore(environmentStore).setState({
      environments: [
        environment("env-1", "first-env"),
        { ...environment("home", "app"), projectHome: true },
      ],
    });
    render(<AppDialogHost />);
    act(() => {
      useAppDialogStore
        .getState()
        .open({ nodeId: commandNodeId(), kind: "delete-project", projectId: "project-1" });
    });

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("remove app from your projects");
    expect(dialog.textContent).toContain(
      "This project has 1 environment that will also be deleted",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expectDomAbsent(screen.queryByRole("alertdialog"));
    expect(useAppDialogStore.getState().request).toBeNull();
    expect(nativeInvoke.mock.calls.some(([command]) => command === "remove_project")).toBe(false);
  });
});

describe("a dialog request names its node", () => {
  const scopes: WindowScope[] = [];
  afterEach(() => {
    cleanup();
    for (const scope of scopes.splice(0)) scope.dispose();
  });

  function windowWithTwoNodes() {
    const windowScope = new WindowScope();
    scopes.push(windowScope);
    const clientA = new FakeNodeClient({
      nodeId: "bk_node-a" as BackendId,
      invoke: { act_on_environment: null },
    });
    const clientB = new FakeNodeClient({
      nodeId: "bk_node-b" as BackendId,
      invoke: { act_on_environment: null },
    });
    windowScope.open({ role: "command", client: clientA });
    const nodeB = windowScope.open({ role: "leaf", client: clientB });
    // Environment ids are node-local: the dialog reads node B's own environments.
    nodeB.store(environmentStore).setState({ environments: [environment("env-1", "on-node-b")] });
    render(
      <WindowScopeProvider windowScope={windowScope}>
        <AppDialogHost />
      </WindowScopeProvider>,
    );
    return { windowScope, clientA, clientB, nodeB };
  }

  test("a dialog opened for node B acts on B", async () => {
    const { clientA, clientB } = windowWithTwoNodes();
    act(() => {
      useAppDialogStore
        .getState()
        .open({ nodeId: clientB.nodeId, kind: "environment-settings", environmentId: "env-1" });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Act on bk_node-b" }));
    expect(clientB.calls("act_on_environment")).toEqual([
      { command: "act_on_environment", args: { environmentId: "env-1" } },
    ]);
    expect(clientA.calls("act_on_environment")).toEqual([]);
  });

  test("a request for a node with no open scope is dropped, and so is one whose scope closes", async () => {
    const { clientB, nodeB } = windowWithTwoNodes();
    act(() => {
      useAppDialogStore.getState().open({
        nodeId: "bk_unopened" as BackendId,
        kind: "environment-settings",
        environmentId: "env-1",
      });
    });
    await waitFor(() => expect(useAppDialogStore.getState().request).toBeNull());
    expectDomAbsent(screen.queryByRole("dialog"));

    act(() => {
      useAppDialogStore
        .getState()
        .open({ nodeId: clientB.nodeId, kind: "environment-settings", environmentId: "env-1" });
    });
    await screen.findByRole("button", { name: "Act on bk_node-b" });
    act(() => nodeB.dispose());
    await waitFor(() => expect(useAppDialogStore.getState().request).toBeNull());
    expectDomAbsent(screen.queryByRole("dialog"));
  });
});

describe("node dialogs open under the node's scope with hydration checks (plan item 5003)", () => {
  const scopes: WindowScope[] = [];
  afterEach(() => {
    cleanup();
    for (const scope of scopes.splice(0)) scope.dispose();
  });

  /** A window whose node B has not read its projects yet; its first read waits for `release`. */
  function windowWithColdNodeB() {
    const windowScope = new WindowScope();
    scopes.push(windowScope);
    const projects = deferred<Project[]>();
    const clientA = new FakeNodeClient({ nodeId: "bk_node-a" as BackendId, invoke: {} });
    const clientB = new FakeNodeClient({
      nodeId: "bk_node-b" as BackendId,
      invoke: {
        get_projects: () => projects.promise,
        get_environment_snapshots: [],
        get_environments: [],
        remove_project: null,
        get_config: null,
      },
    });
    windowScope.open({ role: "command", client: clientA });
    const nodeB = windowScope.open({ role: "leaf", client: clientB });
    render(
      <WindowScopeProvider windowScope={windowScope}>
        <AppDialogHost />
      </WindowScopeProvider>,
    );
    return { clientA, clientB, nodeB, release: () => projects.resolve([project]) };
  }

  test("a project dialog for a node still reading its projects waits for them, then acts on that node", async () => {
    const { clientA, clientB, release } = windowWithColdNodeB();
    act(() => {
      useAppDialogStore
        .getState()
        .open({ nodeId: clientB.nodeId, kind: "delete-project", projectId: project.id });
    });
    // The project is not known yet: the request waits instead of being dropped.
    await waitFor(() => expect(clientB.calls("get_projects").length).toBeGreaterThan(0));
    expect(useAppDialogStore.getState().request?.kind).toBe("delete-project");
    expectDomAbsent(screen.queryByRole("alertdialog"));

    await act(async () => release());
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("remove app from your projects");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(clientB.calls("remove_project")).toHaveLength(1));
    expect(clientB.calls("get_environment_snapshots")).toHaveLength(1);
    expect(clientA.invocations).toEqual([]);
  });

  test("a project that is not there once the node's projects have loaded is dropped", async () => {
    const { clientB } = windowWithColdNodeB();
    clientB.respond("get_projects", []);
    act(() => {
      useAppDialogStore
        .getState()
        .open({ nodeId: clientB.nodeId, kind: "repository-settings", projectId: project.id });
    });
    await waitFor(() => expect(useAppDialogStore.getState().request).toBeNull());
  });

  test("environment Settings and Rebuild open on the node the request names", async () => {
    const { clientA, clientB, nodeB } = windowWithColdNodeB();
    clientB.respond("act_on_environment", null);
    nodeB.store(environmentStore).setState({ environments: [environment("env-7", "only-on-b")] });
    act(() => {
      useAppDialogStore.getState().open({
        nodeId: nodeB.nodeId,
        kind: "environment-settings",
        environmentId: "env-7",
        section: "container",
      });
    });
    expect(await screen.findByText("Settings for only-on-b")).toBeTruthy();
    expect(screen.getByText("Section: container")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Act on bk_node-b" }));
    await waitFor(() => expect(clientB.calls("act_on_environment")).toHaveLength(1));
    expect(clientA.invocations).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (const failSnapshot of [false, true]) {
  test(`project deletion waits for an authoritative snapshot${failSnapshot ? " and retains the dialog on read failure" : " then deletes Home before removing the project"}`, async () => {
    const snapshot = deferred<Environment[]>();
    const homeDelete = deferred<void>();
    const calls: string[] = [];
    nativeInvoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === "get_projects") return [project];
      if (command === "get_environment_snapshots") return snapshot.promise;
      if (command === "delete_environment") {
        calls.push(args.environmentId!);
        if (args.environmentId === "home") await homeDelete.promise;
      }
      if (command === "remove_project") calls.push("remove-project");
    });
    appCommandStore(projectStore).setState({ projects: [project], hasLoaded: true });
    appCommandStore(environmentStore).setState({ environments: [] });
    render(<AppDialogHost />);
    act(() =>
      useAppDialogStore
        .getState()
        .open({ nodeId: commandNodeId(), kind: "delete-project", projectId: project.id }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(calls).toEqual([]);
    await act(async () => {
      if (failSnapshot) snapshot.reject(new Error("snapshot unavailable"));
      else
        snapshot.resolve([
          environment("env-1", "first"),
          { ...environment("home", "app"), projectHome: true },
        ]);
    });
    if (failSnapshot) {
      expect(calls).toEqual([]);
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(useAppDialogStore.getState().request?.kind).toBe("delete-project");
    } else {
      await waitFor(() => expect(calls).toEqual(["env-1", "home"]));
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      await act(async () => homeDelete.resolve());
      await waitFor(() => expect(calls).toEqual(["env-1", "home", "remove-project"]));
      await waitFor(() => expect(useAppDialogStore.getState().request).toBeNull());
    }
  });
}

test("partial deletion keeps the project and dialog and retries only remaining environments", async () => {
  const remaining = new Map(
    [environment("env-1", "first"), { ...environment("home", "app"), projectHome: true }].map(
      (env) => [env.id, env],
    ),
  );
  const calls: string[] = [];
  let fail = true;
  nativeInvoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === "get_projects") return [project];
    if (command === "get_environment_snapshots") return Array.from(remaining.values());
    if (command === "delete_environment") {
      calls.push(args.environmentId!);
      if (args.environmentId === "home" && fail) throw new Error("busy");
      remaining.delete(args.environmentId!);
    }
    if (command === "remove_project") calls.push("remove-project");
  });
  appCommandStore(projectStore).setState({ projects: [project], hasLoaded: true });
  appCommandStore(environmentStore).setState({ environments: Array.from(remaining.values()) });
  render(<AppDialogHost />);
  act(() =>
    useAppDialogStore
      .getState()
      .open({ nodeId: commandNodeId(), kind: "delete-project", projectId: project.id }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(appCommandStore(projectStore).getState().deletingProjects.has(project.id)).toBe(false),
  );
  await waitFor(() => expect(calls).toEqual(["env-1", "home"]));
  expect(appCommandStore(projectStore).getState().projects).toHaveLength(1);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(calls).toEqual(["env-1", "home", "home", "remove-project"]));
  await waitFor(() => expect(useAppDialogStore.getState().request).toBeNull());
});

test("repository settings waits for saved config, saves through the owner's project handler, and closes when removed", async () => {
  const initialConfig = appCommandStore(configStore).getState();
  const savedConfig = {
    ...initialConfig.config,
    repositories: { [project.id]: { defaultBranch: "saved-main", prBaseBranch: "saved-base" } },
  };
  try {
    appCommandStore(configStore).setState({ hasLoaded: false });
    nativeInvoke.mockImplementation(async (command: string) => {
      if (command === "get_projects") return [project];
      if (command === "update_project") return { ...project, name: "renamed", localPath: null };
      if (command === "patch_repository_settings") return savedConfig;
      return [];
    });
    appCommandStore(projectStore).setState({ projects: [project], hasLoaded: true });
    render(<AppDialogHost />);
    act(() =>
      useAppDialogStore
        .getState()
        .open({ nodeId: commandNodeId(), kind: "repository-settings", projectId: project.id }),
    );
    expectDomAbsent(screen.queryByLabelText("Name"));
    act(() => appCommandStore(configStore).getState().setConfig(savedConfig));
    fireEvent.click(await screen.findByRole("button", { name: "Branches" }));
    const branch = (await screen.findByLabelText("Default Branch")) as HTMLInputElement;
    expect(branch.value).toBe("saved-main");
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        nativeInvoke.mock.calls.some(([command]) => command === "patch_repository_settings"),
      ).toBe(true),
    );
    expect(nativeInvoke).toHaveBeenCalledWith(
      "update_project",
      expect.objectContaining({
        projectId: project.id,
        updates: expect.objectContaining({ name: "renamed" }),
      }),
    );
    // The dialog loaded the saved record, so an unchanged branch is not resent.
    expect(nativeInvoke).toHaveBeenCalledWith("patch_repository_settings", {
      projectId: project.id,
      updates: {},
    });
    await waitFor(() => expect(useAppDialogStore.getState().request).toBeNull());
    act(() =>
      useAppDialogStore
        .getState()
        .open({ nodeId: commandNodeId(), kind: "repository-settings", projectId: project.id }),
    );
    await screen.findByLabelText("Name");
    act(() => appCommandStore(projectStore).setState({ projects: [] }));
    expect(useAppDialogStore.getState().request).toBeNull();
    expectDomAbsent(screen.queryByLabelText("Name"));
  } finally {
    appCommandStore(configStore).setState(initialConfig, true);
  }
});

test("a local Rebuild requested before the environment snapshot arrives opens Container when it arrives", async () => {
  const originalPortal = portalStore.getState();
  const originalUI = appCommandStore(uiStore).getState();
  const originalRemote = useRemoteWorkspaceStore.getState();
  try {
    portalStore.store.setState({ selfId: "self" as never });
    appCommandStore(environmentStore).setState({ environments: [] });
    render(<AppDialogHost />);
    act(() =>
      openMachineWorkspace({
        connectionId: "self",
        projectId: "project-1",
        environmentId: "env-delayed",
        dialog: "environment-rebuild",
        title: "Delayed",
      }),
    );
    expect(useAppDialogStore.getState().request).toMatchObject({ environmentId: "env-delayed" });
    expectDomAbsent(screen.queryByRole("dialog"));
    act(() =>
      appCommandStore(environmentStore)
        .getState()
        .addEnvironment(environment("env-delayed", "Delayed")),
    );
    expect(await screen.findByText("Section: container")).toBeTruthy();
  } finally {
    portalStore.store.setState(originalPortal, true);
    appCommandStore(uiStore).setState(originalUI, true);
    useRemoteWorkspaceStore.setState(originalRemote, true);
  }
});

test("a repeated Rebuild returns from Ports to Container", async () => {
  render(<AppDialogHost />);
  const rebuild = () =>
    useAppDialogStore.getState().open({
      nodeId: commandNodeId(),
      kind: "environment-settings",
      environmentId: "env-1",
      section: "container",
    });
  act(rebuild);
  expect(await screen.findByText("Section: container")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Ports" }));
  expect(screen.getByText("Section: ports")).toBeTruthy();
  act(rebuild);
  expect(await screen.findByText("Section: container")).toBeTruthy();
});
