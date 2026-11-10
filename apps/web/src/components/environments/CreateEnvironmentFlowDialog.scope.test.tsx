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
  }: {
    projectId: string;
    onCreate: (options: ClaudeOptions) => Promise<boolean>;
    onCreateFeatureBuild: (input: CreateFeatureBuildInput) => Promise<boolean>;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          void onCreateFeatureBuild({
            projectId,
            title: "Feature",
            environmentType: "local",
            agentType: "claude",
          } as CreateFeatureBuildInput)
        }
      >
        Build feature
      </button>
      <button
        type="button"
        onClick={() =>
          // Cursor always runs in its native SDK mode, so a launch opens the
          // startup agent tab whatever the node's saved modes are.
          void onCreate({
            environmentName: "",
            networkAccessMode: "restricted",
            initialPrompt: "",
            portMappings: [],
            environmentType: "local",
            launchAgent: true,
            agentType: "cursor",
          } as unknown as ClaudeOptions)
        }
      >
        Create environment
      </button>
    </>
  ),
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
