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
