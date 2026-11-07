import { afterEach, expect, test } from "bun:test";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { portalStore } from "@/lib/portal/portal-store";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import { openMachineWorkspace } from "./open-workspace";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { selectOnNode } from "@/test/node-selection";

/** Outside a node scope provider, components act for the app's command node. */
const commandNodeId = () => getWindowScope().commandScope().nodeId;

const originalViews = useMachineViewStore.getState();
const originalPortal = portalStore.getState();
const originalRemote = useRemoteWorkspaceStore.getState();
const originalUI = useUIStore.getState();
afterEach(() => {
  useMachineViewStore.setState(originalViews, true);
  portalStore.store.setState(originalPortal, true);
  useRemoteWorkspaceStore.setState(originalRemote, true);
  useUIStore.setState(originalUI, true);
  useAppDialogStore.setState({ request: null });
});

for (const dialog of ["delete-project", "repository-settings", "environment-settings"] as const) {
  test(`opens a local ${dialog} through the app dialog store`, () => {
    portalStore.store.setState({ selfId: "bk_self" as never });
    useRemoteWorkspaceStore.getState().open("bk_other", { projectId: "other" });
    openMachineWorkspace({
      connectionId: "bk_self",
      projectId: "project",
      ...(dialog === "environment-settings" ? { environmentId: "env" } : {}),
      dialog,
      title: "Local",
    });
    expect(useAppDialogStore.getState().request).toEqual(
      dialog === "environment-settings"
        ? { nodeId: commandNodeId(), kind: dialog, environmentId: "env" }
        : { nodeId: commandNodeId(), kind: dialog, projectId: "project" },
    );
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
    expect(useUIStore.getState().selectedProjectId).toBe("project");
    if (dialog === "environment-settings")
      expect(useUIStore.getState().selectedEnvironmentId).toBe("env");
  });
}

test("an environment's rebuild opens its settings on the Container section", () => {
  portalStore.store.setState({ selfId: "bk_self" as never });
  openMachineWorkspace({
    connectionId: "bk_self",
    projectId: "project",
    environmentId: "env",
    dialog: "environment-rebuild",
    title: "Local",
  });
  expect(useAppDialogStore.getState().request).toEqual({
    nodeId: commandNodeId(),
    kind: "environment-settings",
    environmentId: "env",
    section: "container",
  });
  expect(useUIStore.getState().selectedEnvironmentId).toBe("env");
});

test("another node's environment rebuild goes to that node's workspace", () => {
  portalStore.store.setState({ selfId: "bk_self" as never });
  openMachineWorkspace({
    connectionId: "bk_other",
    projectId: "project",
    environmentId: "env",
    dialog: "environment-rebuild",
    title: "Remote",
  });
  expect(useAppDialogStore.getState().request).toBeNull();
  expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_other");
  expect(useRemoteWorkspaceStore.getState().requests.bk_other?.request).toMatchObject({
    projectId: "project",
    environmentId: "env",
    dialog: "environment-rebuild",
  });
});

const remoteProject = (nodeId: string, id: string) =>
  projectKey(projectRef(nodeId as BackendId, id));
const remoteEnvironment = (nodeId: string, id: string) =>
  environmentKey(environmentRef(nodeId as BackendId, id));

test("navigation and creation in the shown node update machine-qualified recency without local selections", () => {
  portalStore.store.setState({ selfId: "bk_self" as BackendId });
  openMachineWorkspace({ connectionId: "bk_other", projectId: "project", title: "Remote" });
  const local = useUIStore.getState();
  selectOnNode("bk_other", { projectId: "project", environmentId: "selected" });
  expect(useMachineViewStore.getState().recentKeys.slice(0, 2)).toEqual([
    remoteEnvironment("bk_other", "selected"),
    remoteProject("bk_other", "project"),
  ]);
  selectOnNode("bk_other", { projectId: "new-project", environmentId: "created" });
  expect(useMachineViewStore.getState().recentKeys.slice(0, 2)).toEqual([
    remoteEnvironment("bk_other", "created"),
    remoteProject("bk_other", "new-project"),
  ]);
  expect(useUIStore.getState()).toBe(local);
  const views = useMachineViewStore.getState();
  selectOnNode("bk_inactive", { projectId: "inactive", environmentId: "hidden" });
  expect(useMachineViewStore.getState()).toBe(views);
  expect(useRemoteWorkspaceStore.getState().active?.projectId).toBe("new-project");
});

test("remote opens and the shown node's selections clear a different reveal but preserve opening its project", () => {
  portalStore.store.setState({ selfId: "bk_self" as BackendId });
  useUIStore.getState().selectProject(null);
  const key = remoteProject("bk_other", "project");
  useMachineViewStore.getState().revealProject(key);
  openMachineWorkspace({ connectionId: "bk_other", projectId: "project", title: "Remote" });
  expect(useMachineViewStore.getState().revealedProject?.key).toBe(key);
  selectOnNode("bk_inactive", { projectId: "elsewhere", environmentId: "hidden" });
  expect(useMachineViewStore.getState().revealedProject?.key).toBe(key);
  selectOnNode("bk_other", { projectId: "project", environmentId: "selected" });
  expect(useMachineViewStore.getState().revealedProject).toBeNull();
  useMachineViewStore.getState().revealProject(key);
  openMachineWorkspace({
    connectionId: "bk_another",
    projectId: "project",
    title: "Other machine",
  });
  expect(useMachineViewStore.getState().revealedProject).toBeNull();
});
