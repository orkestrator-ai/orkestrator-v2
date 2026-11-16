import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { CreateFeatureBuildInput } from "@orkestrator/protocol/feature-build";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import * as paneLayoutAuthoritative from "@/lib/pane-layout-authoritative";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { projectStore } from "@/stores/projectStore";
import { uiStore } from "@/stores/uiStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import type { Environment, Project } from "@/types";

// The inner form is stubbed to submit one feature build or one plain
// environment; its own tests cover the form. Snapshot and restore it so later files see the real module.
import * as realCreateEnvironmentDialog from "./CreateEnvironmentDialog";
const realCreateEnvironmentDialogSnapshot = { ...realCreateEnvironmentDialog };
mock.module("./CreateEnvironmentDialog", () => ({
  ...realCreateEnvironmentDialogSnapshot,
  CreateEnvironmentDialog: ({
    projectId,
    onCreate,
    onCreateFeatureBuild,
    isLoading,
    loadingLabel,
  }: {
    projectId: string;
    onCreate: (options: ClaudeOptions) => Promise<boolean>;
    onCreateFeatureBuild: (input: CreateFeatureBuildInput) => Promise<boolean>;
    isLoading?: boolean;
    loadingLabel?: string;
  }) => {
    const buildFeature = (environmentType: "local" | "containerized") =>
      void onCreateFeatureBuild({
        projectId,
        title: "Feature",
        environmentType,
        agentType: "claude",
      } as CreateFeatureBuildInput);
    const createEnvironment = (environmentType: "local" | "containerized") =>
      // Cursor always runs in its native SDK mode, so a launch opens the
      // startup agent tab whatever the node's saved modes are.
      void onCreate({
        environmentName: "",
        networkAccessMode: "restricted",
        initialPrompt: "",
        portMappings: [],
        environmentType,
        launchAgent: true,
        agentType: "cursor",
      } as unknown as ClaudeOptions);
    return (
      <>
        <output data-testid="create-busy">{isLoading ? (loadingLabel ?? "busy") : "idle"}</output>
        <button type="button" onClick={() => buildFeature("local")}>
          Build feature
        </button>
        <button type="button" onClick={() => buildFeature("containerized")}>
          Build container feature
        </button>
        <button type="button" onClick={() => createEnvironment("local")}>
          Create environment
        </button>
        <button type="button" onClick={() => createEnvironment("containerized")}>
          Create container environment
        </button>
      </>
    );
  },
}));
afterAll(() => {
  mock.module("./CreateEnvironmentDialog", () => realCreateEnvironmentDialogSnapshot);
});

import type { ClaudeOptions } from "./CreateEnvironmentDialog";
const { CreateEnvironmentFlowDialog } = await import("./CreateEnvironmentFlowDialog");

const scopes: WindowScope[] = [];
afterEach(() => {
  cleanup();
  mock.restore();
  for (const scope of scopes.splice(0)) scope.dispose();
});

test("a feature build created on another node selects it on that node, not the command node", async () => {
  const windowScope = new WindowScope();
  scopes.push(windowScope);
  const command = windowScope.open({
    role: "command",
    client: new FakeNodeClient({ nodeId: "bk_command" as BackendId }),
  });
  const leafClient = new FakeNodeClient({
    nodeId: "bk_leaf" as BackendId,
    invoke: {
      create_feature_build: {
        pipelineId: "pipeline-leaf",
        environmentId: "env-leaf",
        ticketId: "ticket-leaf",
      },
      get_build_pipeline: null,
      get_environment: null,
    },
  });
  const leaf = windowScope.open({ role: "leaf", client: leafClient });
  leaf.store(projectStore).setState({
    projects: [{ id: "project-leaf", name: "repo", localPath: "/leaf/repo" } as Project],
    hasLoaded: true,
  });
  // Ids are per node: the command node has no such project.
  command.store(projectStore).setState({ projects: [], hasLoaded: true });

  render(
    <WindowScopeProvider windowScope={windowScope}>
      <NodeScopeProvider scope={leaf}>
        <CreateEnvironmentFlowDialog
          open
          onOpenChange={() => undefined}
          projectId="project-leaf"
          createEnvironment={async () => ({}) as Environment}
          updateEnvironment={() => undefined}
          startEnvironment={async () => undefined}
        />
      </NodeScopeProvider>
    </WindowScopeProvider>,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Build feature" }));
  });

  await waitFor(() =>
    expect(leaf.store(uiStore).getState().selectedEnvironmentId).toBe("env-leaf"),
  );
  expect(leaf.store(uiStore).getState().selectedProjectId).toBe("project-leaf");
  expect(windowScope.selection.get()).toMatchObject({
    nodeId: "bk_leaf",
    projectId: "project-leaf",
    environmentId: "env-leaf",
  });
  // The command node shows nothing behind the leaf's workspace.
  expect(command.store(uiStore).getState().selectedProjectId).toBeNull();
  expect(command.store(uiStore).getState().selectedEnvironmentId).toBeNull();
  expect(leafClient.calls("create_feature_build")).toHaveLength(1);
});

test("a plain environment created on another node arms its startup agent tab on that node", async () => {
  const arm = spyOn(paneLayoutAuthoritative, "armStartupAgentTabActivation").mockImplementation(
    () => undefined,
  );
  const windowScope = new WindowScope();
  scopes.push(windowScope);
  const command = windowScope.open({
    role: "command",
    client: new FakeNodeClient({ nodeId: "bk_command" as BackendId }),
  });
  const created = { id: "env-leaf", projectId: "project-leaf" } as Environment;
  const leafClient = new FakeNodeClient({
    nodeId: "bk_leaf" as BackendId,
    invoke: { update_environment_agent_settings: created },
  });
  const leaf = windowScope.open({ role: "leaf", client: leafClient });
  leaf.store(projectStore).setState({
    projects: [{ id: "project-leaf", name: "repo", localPath: "/leaf/repo" } as Project],
    hasLoaded: true,
  });
  command.store(projectStore).setState({ projects: [], hasLoaded: true });
  const createEnvironment = mock(async () => created);
  const startEnvironment = mock(async () => undefined);

  render(
    <WindowScopeProvider windowScope={windowScope}>
      <NodeScopeProvider scope={leaf}>
        <CreateEnvironmentFlowDialog
          open
          onOpenChange={() => undefined}
          projectId="project-leaf"
          createEnvironment={createEnvironment}
          updateEnvironment={() => undefined}
          startEnvironment={startEnvironment}
        />
      </NodeScopeProvider>
    </WindowScopeProvider>,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
  });

  await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
  // Armed for the leaf, never the command node the window defaults to.
  expect(arm.mock.calls[0]?.[0]).toBe("env-leaf");
  expect(arm.mock.calls[0]?.[1]).toBe(leaf);
  expect(leafClient.calls("update_environment_agent_settings")).toHaveLength(1);
  expect(leaf.store(uiStore).getState().selectedEnvironmentId).toBe("env-leaf");
  expect(command.store(uiStore).getState().selectedEnvironmentId).toBeNull();
});

// ---------------------------------------------------------------------------
// The busy button names the step in progress, and gives it back on every exit.
// ---------------------------------------------------------------------------

interface Gate<T> {
  promise: Promise<T>;
  release: (value: T) => void;
}

function gate<T>(): Gate<T> {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const CREDENTIAL_OK = { available: true, source: "host-cli" };

function renderStagedDialog(
  client: FakeNodeClient,
  createEnvironment: (...args: unknown[]) => Promise<Environment> = async () =>
    ({ id: "env-staged", projectId: "project-staged" }) as Environment,
) {
  const windowScope = new WindowScope();
  scopes.push(windowScope);
  const node = windowScope.open({ role: "command", client });
  node.store(projectStore).setState({
    projects: [
      { id: "project-staged", name: "repo", localPath: "/repo" } as Project,
      { id: "project-other", name: "other", localPath: "/other" } as Project,
    ],
    hasLoaded: true,
  });
  const element = (props: { open?: boolean; projectId?: string }) => (
    <WindowScopeProvider windowScope={windowScope}>
      <NodeScopeProvider scope={node}>
        <CreateEnvironmentFlowDialog
          open={props.open ?? true}
          onOpenChange={() => undefined}
          projectId={props.projectId ?? "project-staged"}
          createEnvironment={createEnvironment as never}
          updateEnvironment={() => undefined}
          startEnvironment={async () => undefined}
        />
      </NodeScopeProvider>
    </WindowScopeProvider>
  );
  const view = render(element({}));
  return {
    rerender: (props: { open?: boolean; projectId?: string }) => view.rerender(element(props)),
  };
}

const busyLabel = () => screen.getByTestId("create-busy").textContent;

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

test("a container environment names each step, then returns to idle", async () => {
  const credential = gate<unknown>();
  const settings = gate<unknown>();
  const created = gate<Environment>();
  const client = new FakeNodeClient({
    invoke: {
      get_container_github_credential_status: () => credential.promise,
      update_environment_agent_settings: () => settings.promise,
    },
  });
  renderStagedDialog(client, () => created.promise);

  await click("Create container environment");
  expect(busyLabel()).toBe("Checking GitHub access…");
  await act(async () => credential.release(CREDENTIAL_OK));
  await waitFor(() => expect(busyLabel()).toBe("Creating environment…"));
  await act(async () =>
    created.release({ id: "env-staged", projectId: "project-staged" } as Environment),
  );
  await waitFor(() => expect(busyLabel()).toBe("Saving agent settings…"));
  await act(async () =>
    settings.release({ id: "env-staged", projectId: "project-staged" } as Environment),
  );
  await waitFor(() => expect(busyLabel()).toBe("idle"));
});

test("a local environment is named as a worktree", async () => {
  const created = gate<Environment>();
  const client = new FakeNodeClient({
    invoke: {
      update_environment_agent_settings: { id: "env-staged", projectId: "project-staged" },
    },
  });
  renderStagedDialog(client, () => created.promise);

  await click("Create environment");
  expect(busyLabel()).toBe("Creating git worktree…");
  await act(async () =>
    created.release({ id: "env-staged", projectId: "project-staged" } as Environment),
  );
  await waitFor(() => expect(busyLabel()).toBe("idle"));
});

test("a container feature build leaves the credential label once the check passes", async () => {
  const credential = gate<unknown>();
  const build = gate<unknown>();
  const client = new FakeNodeClient({
    invoke: {
      get_container_github_credential_status: () => credential.promise,
      create_feature_build: () => build.promise,
      get_build_pipeline: null,
      get_environment: null,
    },
  });
  renderStagedDialog(client);

  await click("Build container feature");
  expect(busyLabel()).toBe("Checking GitHub access…");
  await act(async () => credential.release(CREDENTIAL_OK));
  await waitFor(() => expect(busyLabel()).toBe("Starting build…"));
  await act(async () =>
    build.release({ pipelineId: "pipeline", environmentId: "env", ticketId: "ticket" }),
  );
  await waitFor(() => expect(busyLabel()).toBe("idle"));
});

test("a local feature build after an earlier create shows its own label, not the stale one", async () => {
  const build = gate<unknown>();
  const client = new FakeNodeClient({
    invoke: {
      update_environment_agent_settings: { id: "env-staged", projectId: "project-staged" },
      create_feature_build: () => build.promise,
      get_build_pipeline: null,
      get_environment: null,
    },
  });
  renderStagedDialog(client);

  await click("Create environment");
  await waitFor(() => expect(busyLabel()).toBe("idle"));
  await click("Build feature");
  expect(busyLabel()).toBe("Starting build…");
  await act(async () =>
    build.release({ pipelineId: "pipeline", environmentId: "env", ticketId: "ticket" }),
  );
  await waitFor(() => expect(busyLabel()).toBe("idle"));
});

test("closing the dialog during the credential check returns the button to idle", async () => {
  const credential = gate<unknown>();
  const createEnvironment = mock(async () => ({ id: "env-staged" }) as Environment);
  const client = new FakeNodeClient({
    invoke: { get_container_github_credential_status: () => credential.promise },
  });
  const { rerender } = renderStagedDialog(client, createEnvironment);

  await click("Create container environment");
  expect(busyLabel()).toBe("Checking GitHub access…");
  await act(async () => rerender({ open: false }));
  await waitFor(() => expect(busyLabel()).toBe("idle"));
  // The answer that arrives after the cancel neither creates nor re-arms the button.
  await act(async () => credential.release(CREDENTIAL_OK));
  expect(busyLabel()).toBe("idle");
  expect(createEnvironment).not.toHaveBeenCalled();
});

test("changing project during the credential check returns the button to idle", async () => {
  const credential = gate<unknown>();
  const createEnvironment = mock(async () => ({ id: "env-staged" }) as Environment);
  const client = new FakeNodeClient({
    invoke: { get_container_github_credential_status: () => credential.promise },
  });
  const { rerender } = renderStagedDialog(client, createEnvironment);

  await click("Create container environment");
  expect(busyLabel()).toBe("Checking GitHub access…");
  await act(async () => rerender({ projectId: "project-other" }));
  await act(async () => credential.release(CREDENTIAL_OK));
  await waitFor(() => expect(busyLabel()).toBe("idle"));
  expect(createEnvironment).not.toHaveBeenCalled();
});
