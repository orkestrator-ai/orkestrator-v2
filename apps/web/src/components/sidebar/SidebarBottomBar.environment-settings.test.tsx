import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { AppDialogHost } from "@/components/layout/AppDialogHost";
import { MobileAppShellLayout } from "@/components/layout/MobileAppShellLayout";
import { invoke } from "@/lib/native/backend";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import { uiStore } from "@/stores/uiStore";
import type { Environment, Project } from "@/types";
import { SidebarBottomBar } from "./SidebarBottomBar";
import { appCommandStore } from "@/test/app-command-store";

const nativeInvoke = invoke as ReturnType<typeof mock>;
const initialProjects = appCommandStore(projectStore).getState();
const initialEnvironments = appCommandStore(environmentStore).getState();
const initialUI = appCommandStore(uiStore).getState();

afterEach(() => {
  cleanup();
  useAppDialogStore.setState({ request: null });
  appCommandStore(projectStore).setState(initialProjects, true);
  appCommandStore(environmentStore).setState(initialEnvironments, true);
  appCommandStore(uiStore).setState(initialUI, true);
  nativeInvoke.mockReset();
});

test("the drawer's bottom bar and AppDialogHost open interactive settings and return focus to the drawer trigger, including cached reopening", async () => {
  // Background reads stay pending, as in the browser fixture, so this exercises
  // the real composed UI without depending on unrelated backend responses.
  nativeInvoke.mockImplementation(() => new Promise(() => {}));
  appCommandStore(projectStore).setState({
    projects: [
      {
        id: "project-1",
        name: "repo",
        gitUrl: "",
        localPath: "/fixture/settings-project",
        order: 0,
        addedAt: "2026-10-16T00:00:00.000Z",
      } as Project,
    ],
  });
  appCommandStore(environmentStore).setState({
    environments: [
      {
        id: "env-1",
        projectId: "project-1",
        name: "feature-env",
        order: 0,
        environmentType: "local",
        status: "running",
        setupPhase: "ready",
        networkAccessMode: "restricted",
        createdAt: "2026-10-16T00:00:00.000Z",
      } as Environment,
    ],
  });
  appCommandStore(uiStore).setState({
    selectedProjectId: "project-1",
    selectedEnvironmentId: "env-1",
  });
  renderInAppCommandScope(
    <>
      <AppDialogHost />
      <MobileAppShellLayout
        initialSidebarOpen={false}
        selectedProjectId="project-1"
        selectedEnvironmentId="env-1"
        title="Settings integration"
        filesPanelOpen={false}
        centralPanelStyle={{}}
        actionBar={null}
        agentInfoButton={null}
        sidebar={<SidebarBottomBar />}
        filesPanel={null}
        onTitleBarMouseDown={() => {}}
      />
    </>,
  );

  for (let pass = 0; pass < 2; pass += 1) {
    const drawerTrigger = screen.getByRole("button", { name: "Open projects and environments" });
    fireEvent.click(drawerTrigger);
    const launch = await screen.findByRole("button", { name: "Environment settings" });
    launch.focus();
    fireEvent.click(launch);
    const settings = await screen.findByRole("dialog", { name: "Environment Settings" });
    // The drawer closes for the dialog, which renders outside it.
    await waitFor(() =>
      expectDomAbsent(screen.queryByRole("dialog", { name: "Projects and environments" })),
    );
    await waitFor(() => expect(settings.contains(document.activeElement)).toBe(true));
    // Change a section through the real layout, then close with each input path.
    fireEvent.click(screen.getByRole("button", { name: "Defaults" }));
    expect(screen.getByRole("button", { name: "Defaults" }).getAttribute("aria-current")).toBe(
      "page",
    );
    const codex = within(screen.getByRole("radiogroup", { name: "Default agent" })).getByRole(
      "radio",
      { name: "Codex" },
    );
    fireEvent.click(codex);
    expect(codex.getAttribute("aria-checked")).toBe("true");
    if (pass === 0) fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    else fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() =>
      expectDomAbsent(screen.queryByRole("dialog", { name: "Environment Settings" })),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Open projects and environments" }),
      ),
    );
  }
}, 20_000);
