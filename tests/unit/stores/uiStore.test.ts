import { describe, test, expect, beforeEach } from "bun:test";
import { useUIStore } from "../../../apps/web/src/stores/uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    // Reset store between tests
    useUIStore.setState({
      selectedProjectId: null,
      selectedEnvironmentId: null,
      projectBoardTab: "kanban",
      projectBoardNotesOpen: false,
      sidebarWidth: 280,
      collapsedProjects: [],
      selectedEnvironmentIds: [],
      expandedSessionsEnvironments: [],
      zoomLevel: 100,
    });
  });

  test("initial state has correct defaults", () => {
    const state = useUIStore.getState();
    expect(state.selectedProjectId).toBeNull();
    expect(state.selectedEnvironmentId).toBeNull();
    expect(state.projectBoardTab).toBe("kanban");
    expect(state.projectBoardNotesOpen).toBe(false);
    expect(state.sidebarWidth).toBe(280);
    expect(state.collapsedProjects).toEqual([]);
    expect(state.selectedEnvironmentIds).toEqual([]);
    expect(state.expandedSessionsEnvironments).toEqual([]);
    expect(state.zoomLevel).toBe(100);
  });

  test("selectProject sets project and clears environment", () => {
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    useUIStore.getState().selectProject("project-1");

    const state = useUIStore.getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBeNull();
  });

  test("selectProject with null clears selection", () => {
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    useUIStore.getState().selectProject(null);

    const state = useUIStore.getState();
    expect(state.selectedProjectId).toBeNull();
    expect(state.selectedEnvironmentId).toBeNull();
  });

  test("selectEnvironment sets environment id", () => {
    useUIStore.getState().selectEnvironment("env-1");
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");
  });

  test("selectEnvironment with null clears environment", () => {
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    useUIStore.getState().selectEnvironment(null);
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  });

  test("setProjectBoardTab updates the board tab and closes project notes", () => {
    useUIStore.setState({ projectBoardTab: "kanban", projectBoardNotesOpen: true });

    useUIStore.getState().setProjectBoardTab("features");

    expect(useUIStore.getState().projectBoardTab).toBe("features");
    expect(useUIStore.getState().projectBoardNotesOpen).toBe(false);
  });

  test("setProjectBoardNotesOpen toggles project notes", () => {
    useUIStore.getState().setProjectBoardNotesOpen(true);
    expect(useUIStore.getState().projectBoardNotesOpen).toBe(true);

    useUIStore.getState().setProjectBoardNotesOpen(false);
    expect(useUIStore.getState().projectBoardNotesOpen).toBe(false);
  });

  test("setSidebarWidth updates the width", () => {
    useUIStore.getState().setSidebarWidth(350);
    expect(useUIStore.getState().sidebarWidth).toBe(350);

    useUIStore.getState().setSidebarWidth(200);
    expect(useUIStore.getState().sidebarWidth).toBe(200);
  });

  test("selectProjectAndEnvironment sets both", () => {
    useUIStore.getState().selectProjectAndEnvironment("project-1", "env-1");

    const state = useUIStore.getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBe("env-1");
  });

  test("toggleProjectCollapse adds and removes", () => {
    useUIStore.getState().toggleProjectCollapse("project-1");
    expect(useUIStore.getState().collapsedProjects).toEqual(["project-1"]);

    useUIStore.getState().toggleProjectCollapse("project-1");
    expect(useUIStore.getState().collapsedProjects).toEqual([]);
  });

  test("setProjectCollapsed sets collapsed state", () => {
    useUIStore.getState().setProjectCollapsed("project-1", true);
    expect(useUIStore.getState().collapsedProjects).toEqual(["project-1"]);

    // No duplicate when already collapsed
    useUIStore.getState().setProjectCollapsed("project-1", true);
    expect(useUIStore.getState().collapsedProjects).toEqual(["project-1"]);

    useUIStore.getState().setProjectCollapsed("project-1", false);
    expect(useUIStore.getState().collapsedProjects).toEqual([]);
  });

  test("toggleEnvironmentSelection adds and removes", () => {
    useUIStore.getState().toggleEnvironmentSelection("env-1");
    expect(useUIStore.getState().selectedEnvironmentIds).toEqual(["env-1"]);

    useUIStore.getState().toggleEnvironmentSelection("env-2");
    expect(useUIStore.getState().selectedEnvironmentIds).toEqual(["env-1", "env-2"]);

    useUIStore.getState().toggleEnvironmentSelection("env-1");
    expect(useUIStore.getState().selectedEnvironmentIds).toEqual(["env-2"]);
  });

  test("setMultiSelection and clearMultiSelection", () => {
    useUIStore.getState().setMultiSelection(["env-1", "env-2", "env-3"]);
    expect(useUIStore.getState().selectedEnvironmentIds).toEqual(["env-1", "env-2", "env-3"]);

    useUIStore.getState().clearMultiSelection();
    expect(useUIStore.getState().selectedEnvironmentIds).toEqual([]);
  });

  test("toggleSessionsExpanded and isSessionsExpanded", () => {
    expect(useUIStore.getState().isSessionsExpanded("env-1")).toBe(false);

    useUIStore.getState().toggleSessionsExpanded("env-1");
    expect(useUIStore.getState().isSessionsExpanded("env-1")).toBe(true);

    useUIStore.getState().toggleSessionsExpanded("env-1");
    expect(useUIStore.getState().isSessionsExpanded("env-1")).toBe(false);
  });

  test("setZoomLevel clamps to 50-200", () => {
    useUIStore.getState().setZoomLevel(150);
    expect(useUIStore.getState().zoomLevel).toBe(150);

    useUIStore.getState().setZoomLevel(10);
    expect(useUIStore.getState().zoomLevel).toBe(50);

    useUIStore.getState().setZoomLevel(300);
    expect(useUIStore.getState().zoomLevel).toBe(200);
  });

  test("zoomIn and zoomOut step by 10", () => {
    useUIStore.getState().zoomIn();
    expect(useUIStore.getState().zoomLevel).toBe(110);

    useUIStore.getState().zoomOut();
    expect(useUIStore.getState().zoomLevel).toBe(100);
  });

  test("zoomIn caps at 200 and zoomOut caps at 50", () => {
    useUIStore.getState().setZoomLevel(200);
    useUIStore.getState().zoomIn();
    expect(useUIStore.getState().zoomLevel).toBe(200);

    useUIStore.getState().setZoomLevel(50);
    useUIStore.getState().zoomOut();
    expect(useUIStore.getState().zoomLevel).toBe(50);
  });

  test("resetZoom sets zoom to 100", () => {
    useUIStore.getState().setZoomLevel(150);
    useUIStore.getState().resetZoom();
    expect(useUIStore.getState().zoomLevel).toBe(100);
  });

  test("collapseEmptyProjects collapses only empty projects", () => {
    const projectsWithEnvs = new Set(["project-2"]);
    useUIStore.getState().collapseEmptyProjects(["project-1", "project-2", "project-3"], projectsWithEnvs);

    const collapsed = useUIStore.getState().collapsedProjects;
    expect(collapsed).toContain("project-1");
    expect(collapsed).toContain("project-3");
    expect(collapsed).not.toContain("project-2");
  });
});
