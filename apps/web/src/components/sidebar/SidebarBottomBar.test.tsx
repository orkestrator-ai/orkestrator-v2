import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import * as backend from "@/lib/backend";
import { onGlobalSettingsRequest, type GlobalSettingsSection } from "@/lib/settings-navigation";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useBugReportStore } from "@/stores/bugReportStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import type { Environment, Project } from "@/types";
import { SidebarBottomBar } from "./SidebarBottomBar";

const originalGateway = window.orkestratorGateway;
const originalOrkestrator = window.orkestrator;
const initialProjects = useProjectStore.getState();
const initialEnvironments = useEnvironmentStore.getState();
const initialRemote = useRemoteWorkspaceStore.getState();
const initialUI = useUIStore.getState();

function selectEnvironment() {
  useProjectStore.setState({
    projects: [{ id: "project-1", name: "repo", order: 0 } as Project],
  });
  useEnvironmentStore.setState({
    environments: [{ id: "env-1", projectId: "project-1", name: "feature" } as Environment],
  });
  useUIStore.setState({ selectedProjectId: "project-1", selectedEnvironmentId: "env-1" });
}

function hostUpdate(updateAvailable: boolean | null) {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    hostMaintenanceSnapshotFixture({
      updater: {
        ...hostMaintenanceSnapshotFixture().updater,
        latestVersion: updateAvailable ? "9.0.0" : null,
        updateAvailable,
      },
    }),
  );
}

/** Let the host maintenance snapshot the bar reads arrive. */
async function renderBar() {
  const view = render(<SidebarBottomBar />);
  await waitFor(() => expect(backend.getHostMaintenance).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

beforeEach(() => {
  window.orkestrator = undefined;
  window.orkestratorGateway = undefined;
});

afterEach(() => {
  cleanup();
  mock.restore();
  useBugReportStore.setState({ sheetOpen: false, draftInProgress: false });
  useAppDialogStore.setState({ request: null });
  useProjectStore.setState(initialProjects, true);
  useEnvironmentStore.setState(initialEnvironments, true);
  useUIStore.setState(initialUI, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
  window.orkestrator = originalOrkestrator;
  window.orkestratorGateway = originalGateway;
});

describe("SidebarBottomBar", () => {
  test("puts the settings on the left and the bug report on the right", async () => {
    hostUpdate(false);
    const sections: GlobalSettingsSection[] = [];
    const stop = onGlobalSettingsRequest((section) => sections.push(section));
    try {
      const { container } = await renderBar();
      const bar = container.querySelector("[data-sidebar-bottom-bar]")!;
      const buttons = Array.from(bar.querySelectorAll("button"));
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
        "Global settings",
        "Repository settings",
        "Environment settings",
        "Report a bug",
      ]);
      const settings = screen.getByRole("button", { name: "Global settings" });
      expect(settings.getAttribute("title")).toBe("Global settings");
      expect(screen.getByRole("button", { name: "Report a bug" }).getAttribute("title")).toBe(
        "Report a bug",
      );

      fireEvent.click(settings);
      expect(sections).toEqual(["general"]);
      expect(screen.queryByTestId("settings-update-dot") === null).toBe(true);
    } finally {
      stop();
    }
  });

  test("opens the selected project's and environment's settings in the app dialog host", async () => {
    hostUpdate(false);
    selectEnvironment();
    await renderBar();

    const repository = screen.getByRole("button", { name: "Repository settings" });
    expect(repository.getAttribute("title")).toBe("Repository settings");
    fireEvent.click(repository);
    expect(useAppDialogStore.getState().request).toEqual({
      kind: "repository-settings",
      projectId: "project-1",
    });

    const environment = screen.getByRole("button", { name: "Environment settings" });
    expect(environment.getAttribute("title")).toBe("Environment settings");
    fireEvent.click(environment);
    expect(useAppDialogStore.getState().request).toEqual({
      kind: "environment-settings",
      environmentId: "env-1",
    });
  });

  test("routes remote settings to the active realm with local selection cleared, then returns to the local host", async () => {
    hostUpdate(false);
    selectEnvironment();
    useRemoteWorkspaceStore.getState().open("remote-node", {
      projectId: "remote-project",
      environmentId: "remote-env",
    });
    expect(useUIStore.getState().selectedProjectId).toBeNull();
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    await renderBar();

    for (const [label, dialog] of [
      ["Repository settings", "repository-settings"],
      ["Environment settings", "environment-settings"],
    ] as const) {
      const button = screen.getByRole("button", { name: label });
      expect(button.hasAttribute("disabled")).toBe(false);
      const previousSeq = useRemoteWorkspaceStore.getState().requests["remote-node"]!.seq;
      fireEvent.click(button);
      const request = useRemoteWorkspaceStore.getState().requests["remote-node"]!;
      expect(request.seq).toBeGreaterThan(previousSeq);
      expect(request.request).toEqual({
        type: "select",
        projectId: "remote-project",
        environmentId: "remote-env",
        dialog,
      });
      expect(useAppDialogStore.getState().request).toBeNull();
    }

    act(() => {
      useRemoteWorkspaceStore.getState().noteRealmSelection("remote-node", {
        projectId: "remote-project-2",
        environmentId: null,
      });
    });
    expect(
      screen.getByRole("button", { name: "Environment settings" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Repository settings" }));
    expect(useRemoteWorkspaceStore.getState().requests["remote-node"]!.request).toEqual({
      type: "select",
      projectId: "remote-project-2",
      dialog: "repository-settings",
    });

    act(() => {
      useRemoteWorkspaceStore.getState().showLocal();
      selectEnvironment();
    });
    fireEvent.click(screen.getByRole("button", { name: "Environment settings" }));
    expect(useAppDialogStore.getState().request).toEqual({
      kind: "environment-settings",
      environmentId: "env-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Repository settings" }));
    expect(useAppDialogStore.getState().request).toEqual({
      kind: "repository-settings",
      projectId: "project-1",
    });
  });

  test("keeps repository and environment settings in place but disabled without a selection", async () => {
    hostUpdate(false);
    await renderBar();

    const repository = screen.getByRole("button", { name: "Repository settings" });
    const environment = screen.getByRole("button", { name: "Environment settings" });
    expect(repository.hasAttribute("disabled")).toBe(true);
    expect(repository.getAttribute("title")).toBe("Select a project first");
    expect(environment.hasAttribute("disabled")).toBe(true);
    expect(environment.getAttribute("title")).toBe("Select an environment first");

    // A selection whose environment was removed does not open a dead dialog.
    act(() => {
      selectEnvironment();
      useEnvironmentStore.setState({ environments: [] });
    });
    expect(
      screen.getByRole("button", { name: "Repository settings" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Environment settings" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(useAppDialogStore.getState().request).toBeNull();
  });

  test("opens the bug report sheet and marks a draft in progress", async () => {
    hostUpdate(null);
    await renderBar();
    const bug = screen.getByRole("button", { name: "Report a bug" });
    expect(screen.queryByTestId("bug-report-draft-dot") === null).toBe(true);
    expect(bug.getAttribute("aria-describedby")).toBeNull();

    fireEvent.click(bug);
    expect(useBugReportStore.getState().sheetOpen).toBe(true);

    act(() => useBugReportStore.getState().setDraftInProgress(true));
    expect(screen.getByTestId("bug-report-draft-dot")).toBeTruthy();
    const description = bug.getAttribute("aria-describedby");
    expect(description && document.getElementById(description)?.textContent).toBe(
      "Draft in progress",
    );
  });

  test("marks an available update on Settings, which still open on their first section", async () => {
    hostUpdate(true);
    const sections: GlobalSettingsSection[] = [];
    const stop = onGlobalSettingsRequest((section) => sections.push(section));
    try {
      await renderBar();
      expect(await screen.findByTestId("settings-update-dot")).toBeTruthy();
      const settings = screen.getByRole("button", { name: "Global settings" });
      expect(settings.getAttribute("title")).toBe("Global settings · Update available");
      const description = settings.getAttribute("aria-describedby");
      expect(description && document.getElementById(description)?.textContent).toBe(
        "Update available",
      );

      fireEvent.click(settings);
      expect(sections).toEqual(["general"]);
    } finally {
      stop();
    }
  });
});
