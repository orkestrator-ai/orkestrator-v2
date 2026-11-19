import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { appCommandStore } from "@/test/app-command-store";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { onGlobalSettingsRequest, type GlobalSettingsSection } from "@/lib/settings-navigation";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { uiStore } from "@/stores/uiStore";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useSidebarActionStore } from "@/stores/sidebarActionStore";
import type { Environment, Project } from "@/types";
import { ProjectSearchBar } from "./ProjectSearchBar";

const initialMachineView = useMachineViewStore.getState();

const project: Project = {
  id: "project-1",
  name: "orkestrator-v2",
  gitUrl: "https://github.com/acme/orkestrator-v2.git",
  localPath: null,
  addedAt: "2026-01-01T00:00:00.000Z",
  order: 0,
};

const base = {
  projectId: "project-1",
  containerId: null,
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  networkAccessMode: "restricted" as const,
};

const container: Environment = {
  ...base,
  id: "env-container",
  name: "build-modal-steps",
  branch: "build-modal-steps",
  containerId: "container-1",
  status: "running",
  order: 1,
  environmentType: "containerized",
};

const worktree: Environment = {
  ...base,
  id: "env-local",
  name: "main",
  branch: "main",
  status: "running",
  order: 0,
  environmentType: "local",
  worktreePath: "/tmp/orkestrator-v2",
};

function renderPalette() {
  const handlers = {
    startEnvironment: mock(async (_id: string) => undefined),
    stopEnvironment: mock(async (_id: string) => undefined),
    restartEnvironment: mock(async (_id: string) => undefined),
    onAddProject: mock(() => undefined),
  };
  const onSelectEnvironment = mock((_id: string) => undefined);
  const view = renderInAppCommandScope(
    <ProjectSearchBar
      projects={[project]}
      environments={[worktree, container]}
      onSelectProject={() => undefined}
      onSelectEnvironment={onSelectEnvironment}
      commandHandlers={handlers}
    />,
  );
  return { handlers, onSelectEnvironment, view };
}

function select(environmentId: string | null) {
  act(() => {
    const ui = appCommandStore(uiStore).getState();
    if (environmentId) ui.selectProjectAndEnvironment("project-1", environmentId);
    else ui.selectProject(null);
  });
}

async function openPalette() {
  const trigger = screen.getByTestId("project-search-trigger");
  trigger.focus();
  fireEvent.click(trigger);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  return screen.getByRole("combobox", { name: "Search projects and environments" });
}

function activeOptionId(input: HTMLElement) {
  return input.getAttribute("aria-activedescendant");
}

describe("ProjectSearchBar commands", () => {
  beforeEach(() => {
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {};
    }
    useMachineViewStore.setState(initialMachineView, true);
    useCommandPaletteStore.setState({ recentCommandIds: [], rememberRecent: true });
    useSidebarActionStore.setState({ pending: new Set() });
  });

  afterEach(() => {
    cleanup();
    select(null);
    useMachineViewStore.setState(initialMachineView, true);
  });

  test("shows its context and suggests that environment's actions", async () => {
    renderPalette();
    select("env-container");
    await openPalette();

    expect(screen.getByTestId("command-palette-context-path").textContent).toBe(
      "This machine › orkestrator-v2 › build-modal-steps",
    );
    const actions = screen.getByTestId("command-palette-actions");
    expect(actions.textContent).toContain("Suggested actions");
    const stop = screen.getByTestId("command-palette-item-environment.stop");
    expect(stop.getAttribute("aria-label")).toBe(
      "Stop environment, for build-modal-steps · orkestrator-v2, on this machine",
    );
    expect(screen.getByTestId("command-palette-item-environment.open-changes")).toBeTruthy();
    // The recent destinations stay first.
    const options = screen.getAllByRole("option").map((row) => row.getAttribute("data-testid"));
    expect(options[0]).toBe("project-search-item-project-1");
  });

  test("a confirmed action keeps its frozen target when the window switches environments", async () => {
    const { handlers } = renderPalette();
    select("env-container");
    const input = await openPalette();

    fireEvent.change(input, { target: { value: "stop" } });
    expect(activeOptionId(input)).toBe("project-search-option-command:environment.stop");
    fireEvent.keyDown(input, { key: "Enter" });

    const confirm = await screen.findByTestId("command-palette-confirm");
    expect(confirm.textContent).toContain("Stop this environment?");
    expect(screen.getByTestId("command-palette-confirm-environment").textContent).toBe(
      "build-modal-steps",
    );
    expect(handlers.stopEnvironment).not.toHaveBeenCalled();

    // Another surface moves the window to a different environment.
    select("env-local");
    expect(screen.getByTestId("command-palette-confirm-environment").textContent).toBe(
      "build-modal-steps",
    );
    expect(await screen.findByText(/The window now shows main/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("command-palette-confirm-run"));
    await waitFor(() => expect(handlers.stopEnvironment).toHaveBeenCalledTimes(1));
    expect(handlers.stopEnvironment).toHaveBeenCalledWith("env-container");
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "closed palette"));
    expect(useCommandPaletteStore.getState().recentCommandIds).toEqual(["environment.stop"]);
  });

  test("a confirmation re-checks the frozen target and refuses when it went away", async () => {
    const { handlers, view } = renderPalette();
    select("env-container");
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "restart" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("command-palette-confirm");

    view.rerender(
      <ProjectSearchBar
        projects={[project]}
        environments={[worktree]}
        onSelectProject={() => undefined}
        onSelectEnvironment={() => undefined}
        commandHandlers={handlers}
      />,
    );
    expect((await screen.findByTestId("command-palette-confirm-blocked")).textContent).toContain(
      "no longer exists",
    );
    const run = screen.getByTestId("command-palette-confirm-run") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.click(run);
    expect(handlers.restartEnvironment).not.toHaveBeenCalled();
  });

  test("Escape leaves a confirmation, then closes and restores focus", async () => {
    renderPalette();
    select("env-container");
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "stop" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("command-palette-confirm");

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() =>
      expectDomAbsent(screen.queryByTestId("command-palette-confirm"), "left confirmation"),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "closed palette"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("project-search-trigger")),
    );
  });

  test("an unavailable action explains itself and Enter follows its next step", async () => {
    const { handlers } = renderPalette();
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "open changes" } });

    const row = await screen.findByTestId("command-palette-item-environment.open-changes");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("Choose an environment first · Choose an environment");
    expect(activeOptionId(input)).toBe("project-search-option-command:environment.open-changes");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByLabelText("Filter results: Environments")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(handlers.stopEnvironment).not.toHaveBeenCalled();
  });

  test("opens a precise Settings section from its alias", async () => {
    renderPalette();
    const requested: GlobalSettingsSection[] = [];
    const off = onGlobalSettingsRequest((section) => requested.push(section));
    try {
      const input = await openPalette();
      fireEvent.change(input, { target: { value: "allowlist" } });
      expect(activeOptionId(input)).toBe("project-search-option-command:settings.network");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(requested).toEqual(["network"]);
    } finally {
      off();
    }
  });

  test("pointer users reach the same commands", async () => {
    const { handlers } = renderPalette();
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "add project" } });
    fireEvent.click(await screen.findByTestId("command-palette-item-app.add-project"));
    expect(handlers.onAddProject).toHaveBeenCalledTimes(1);
  });

  test("a late History answer does not move the row Enter opens", async () => {
    const { onSelectEnvironment } = renderPalette();
    select("env-container");
    act(() => {
      const layouts = appCommandStore(paneLayoutStore).getState();
      layouts.initialize("container-1", "env-container");
      const paneId = layouts.getActivePaneId("env-container");
      if (!paneId) throw new Error("no pane");
      layouts.addTab(
        paneId,
        { id: "tab-notes", type: "agent-native", displayTitle: "build notes" },
        "env-container",
      );
    });
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "build" } });
    // Before History answers, the environment is highlighted.
    expect(activeOptionId(input)).toBe("project-search-option-env-container");
    expect(await screen.findByTestId("command-palette-history-tab-notes")).toBeTruthy();
    expect(activeOptionId(input)).toBe("project-search-option-env-container");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectEnvironment).toHaveBeenCalledWith("env-container");
  });

  test("Tab reaches every category and the category filter hides other groups", async () => {
    renderPalette();
    select("env-container");
    const input = await openPalette();
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Filter results: Actions")).toBeTruthy();
    expectDomAbsent(screen.queryByTestId("project-search-item-project-1"), "project under Actions");
    expect(screen.getByTestId("command-palette-item-app.keyboard-shortcuts")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Filter results: Settings")).toBeTruthy();
    expect(screen.getByTestId("command-palette-item-settings.environment")).toBeTruthy();
  });
});
