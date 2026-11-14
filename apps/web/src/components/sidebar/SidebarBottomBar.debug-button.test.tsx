import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import * as backend from "@/lib/backend";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { appCommandStore } from "@/test/app-command-store";
import { useDebugBuildStore } from "@/stores/debugBuildStore";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { uiStore } from "@/stores/uiStore";
import type { Environment, Project } from "@/types";
import { SidebarBottomBar } from "./SidebarBottomBar";

const originalOrkestrator = window.orkestrator;
const initialProjects = appCommandStore(projectStore).getState();
const initialEnvironments = appCommandStore(environmentStore).getState();
const initialUI = appCommandStore(uiStore).getState();
const initialRemote = useRemoteWorkspaceStore.getState();

function selectEnvironment() {
  appCommandStore(projectStore).setState({
    projects: [{ id: "project-1", name: "repo", order: 0 } as Project],
  });
  appCommandStore(environmentStore).setState({
    environments: [{ id: "env-1", projectId: "project-1", name: "feature" } as Environment],
  });
  appCommandStore(uiStore).setState({
    selectedProjectId: "project-1",
    selectedEnvironmentId: "env-1",
  });
}

async function renderBar() {
  const view = renderInAppCommandScope(<SidebarBottomBar />);
  await waitFor(() => expect(backend.getHostMaintenance).toHaveBeenCalled());
  return view;
}

beforeEach(() => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(hostMaintenanceSnapshotFixture());
});

afterEach(() => {
  cleanup();
  mock.restore();
  useUIChromeStore.setState({ debugButtonEnabled: false });
  useDebugBuildStore.getState().close();
  appCommandStore(projectStore).setState(initialProjects, true);
  appCommandStore(environmentStore).setState(initialEnvironments, true);
  appCommandStore(uiStore).setState(initialUI, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
  window.orkestrator = originalOrkestrator;
});

const DEBUG_BUTTON = "Debug: start a pipeline environment for this environment";

test("the debug button appears only while the setting is on", async () => {
  selectEnvironment();
  await renderBar();
  expect(screen.queryByRole("button", { name: DEBUG_BUTTON }) === null).toBe(true);
  act(() => useUIChromeStore.setState({ debugButtonEnabled: true }));
  expect(screen.getByRole("button", { name: DEBUG_BUTTON })).toBeTruthy();
});

test("is disabled until an environment is selected", async () => {
  useUIChromeStore.setState({ debugButtonEnabled: true });
  await renderBar();
  expect(screen.getByRole("button", { name: DEBUG_BUTTON }).hasAttribute("disabled")).toBe(true);
});

test("captures the window before opening the dialog for the selected environment", async () => {
  useUIChromeStore.setState({ debugButtonEnabled: true });
  selectEnvironment();
  let openAtCapture = null as boolean | null;
  window.orkestrator = {
    bugReport: {
      captureWindow: async () => {
        openAtCapture = useDebugBuildStore.getState().open;
        return "AAAA";
      },
    },
  } as never;
  await renderBar();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: DEBUG_BUTTON }));
  });
  await waitFor(() => expect(useDebugBuildStore.getState().open).toBe(true));
  expect(openAtCapture).toBe(false);
  expect(useDebugBuildStore.getState().screenshot).toBe("AAAA");
  expect(useDebugBuildStore.getState().target).toEqual({
    nodeId: null,
    projectId: "project-1",
    environmentId: "env-1",
  });
});
