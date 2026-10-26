import { afterEach, expect, test } from "bun:test";
import { portalStore } from "@/lib/portal/portal-store";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import { openMachineWorkspace } from "./open-workspace";

const originalPortal = portalStore.getState();
const originalRemote = useRemoteWorkspaceStore.getState();
const originalUI = useUIStore.getState();
afterEach(() => {
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
        ? { kind: dialog, environmentId: "env" }
        : { kind: dialog, projectId: "project" },
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
    kind: "environment-settings",
    environmentId: "env",
    section: "container",
  });
  expect(useUIStore.getState().selectedEnvironmentId).toBe("env");
});

test("another node's environment rebuild goes to that node's realm", () => {
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
