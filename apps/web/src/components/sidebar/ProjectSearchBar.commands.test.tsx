import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderHookInAppCommandScope, renderInAppCommandScope } from "@/test/render-in-node-scope";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { MAX_TABS_PER_ENVIRONMENT } from "@orkestrator/protocol/pane-layout";
import { appCommandStore } from "@/test/app-command-store";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { onGlobalSettingsRequest, type GlobalSettingsSection } from "@/lib/settings-navigation";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { uiStore } from "@/stores/uiStore";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import {
  claimSidebarAction,
  releaseSidebarAction,
  useSidebarActionStore,
} from "@/stores/sidebarActionStore";
import type { Environment, Project } from "@/types";
import { useCommandRuntime } from "@/components/command-palette/useCommandPalette";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { appCommandScope } from "@/lib/node-scope-slots";
import { createSessionKey } from "@/lib/utils";
import {
  peekNativeAgentResumeRequest,
  resetNativeAgentResumeRequests,
} from "@/lib/native-agent-resume-requests";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import {
  conversationScrollTargetKey,
  resetConversationScrollTargets,
  useConversationScrollTargetStore,
} from "@/stores/conversationScrollTargetStore";
import { ProjectSearchBar } from "./ProjectSearchBar";

const initialMachineView = useMachineViewStore.getState();
const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

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

function renderPalette(containerState = container) {
  const handlers = {
    startEnvironment: mock(async (_id: string) => undefined),
    stopEnvironment: mock(async (_id: string) => undefined),
    onAddProject: mock(() => undefined),
  };
  const onSelectEnvironment = mock((_id: string) => undefined);
  const view = renderInAppCommandScope(
    <ProjectSearchBar
      projects={[project]}
      environments={[worktree, containerState]}
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
    invokeMock.mockImplementation(() => Promise.resolve());
    resetNativeAgentResumeRequests();
    resetConversationScrollTargets();
    appCommandStore(nativeAgentProjectionStore).getState().reset();
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
    fireEvent.change(input, { target: { value: "stop" } });
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
    expect(handlers.stopEnvironment).not.toHaveBeenCalled();
  });

  for (const action of ["start", "stop"] as const) {
    test(`blocks a stale ${action} confirmation after the run state changes`, async () => {
      const initial = { ...container, status: action === "start" ? "stopped" : "running" } as const;
      const { handlers, view } = renderPalette(initial);
      select(container.id);
      const input = await openPalette();
      fireEvent.change(input, { target: { value: action } });
      fireEvent.keyDown(input, { key: "Enter" });
      await screen.findByTestId("command-palette-confirm");
      view.rerender(
        <ProjectSearchBar
          projects={[project]}
          environments={[{ ...container, status: action === "start" ? "running" : "stopped" }]}
          onSelectProject={() => undefined}
          onSelectEnvironment={() => undefined}
          commandHandlers={handlers}
        />,
      );
      const run = screen.getByTestId("command-palette-confirm-run") as HTMLButtonElement;
      expect(run.disabled).toBe(true);
      fireEvent.click(run);
      expect(handlers.startEnvironment).not.toHaveBeenCalled();
      expect(handlers.stopEnvironment).not.toHaveBeenCalled();
    });
  }

  test("the runtime refuses local power while another action holds the claim", async () => {
    const stopEnvironment = mock(async (_id: string) => undefined);
    const { result } = renderHookInAppCommandScope(() =>
      useCommandRuntime({ handlers: { stopEnvironment }, machines: [] }),
    );
    const target = { machine: null, project: null, environment: container };
    expect(claimSidebarAction(container.id)).toBe(true);
    try {
      await result.current.environmentPower("stop", target);
      expect(stopEnvironment).not.toHaveBeenCalled();
    } finally {
      releaseSidebarAction(container.id);
    }
    await result.current.environmentPower("stop", target);
    expect(stopEnvironment).toHaveBeenCalledTimes(1);
  });

  test("Restart recovery asks for explicit confirmation of Start", async () => {
    const { handlers } = renderPalette({ ...container, status: "stopped" });
    select(container.id);
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "restart" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "Start this environment?" })).toBeTruthy();
    expect(handlers.startEnvironment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("command-palette-confirm-run"));
    await waitFor(() => expect(handlers.startEnvironment).toHaveBeenCalledWith(container.id));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("project-search-trigger")),
    );
  });

  test("New agent tab explains why it is unavailable during setup", async () => {
    renderPalette({ ...container, setupPhase: "running" });
    select(container.id);
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "new agent tab" } });
    const row = await screen.findByTestId("command-palette-item-environment.new-agent-tab");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("Environment setup is still running");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).toBe(input);
  });

  test("New agent tab follows the current layout's tab cap", async () => {
    renderPalette();
    select(container.id);
    const layout = appCommandStore(paneLayoutStore).getState();
    act(() => {
      layout.initialize(container.containerId!, container.id);
      const pane = layout.getActivePaneId(container.id)!;
      for (let index = 0; index < MAX_TABS_PER_ENVIRONMENT; index++) {
        layout.addTab(pane, { id: `cap-${index}`, type: "agent-native" }, container.id);
      }
    });
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "new agent tab" } });
    const row = await screen.findByTestId("command-palette-item-environment.new-agent-tab");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("Close a tab before creating another");
    act(() => layout.removeTab(layout.getActivePaneId(container.id)!, "cap-0", container.id));
    expect(row.getAttribute("aria-disabled")).toBeNull();
    act(() => {
      const pane = layout.getActivePaneId(container.id)!;
      for (let index = 1; index < MAX_TABS_PER_ENVIRONMENT; index++) {
        layout.removeTab(pane, `cap-${index}`, container.id);
      }
    });
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
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(row.getAttribute("aria-label")).toContain("Choose an environment");
    expect(row.textContent).toContain("Choose an environment first · Choose an environment");
    expect(activeOptionId(input)).toBe("project-search-option-command:environment.open-changes");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByLabelText("Filter results: Environments")).toBeTruthy();
    expect(screen.getByRole("option", { name: /build-modal-steps/ })).toBeTruthy();
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

  test("copy restores the opener and records only the static action and counts", async () => {
    const logs = captureLogs();
    try {
      renderPalette();
      select(container.id);
      const input = await openPalette();
      fireEvent.change(input, { target: { value: "copy environment id" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("project-search-trigger")),
      );
      const record = logs
        .records()
        .find((entry) => entry.area === "web.command-palette" && entry.event === "session.closed");
      expect(record?.fields).toEqual({
        activated: "environment.copy-id",
        activatedAfterMs: expect.any(Number),
        openForMs: expect.any(Number),
        noResultQueries: expect.any(Number),
        unavailableChoices: 0,
      });
    } finally {
      logs.restore();
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

  test("History matches a non-context project and drops closed tabs on the same query", async () => {
    const { view, handlers } = renderPalette();
    const otherProject = { ...project, id: "other-project", name: "distinct-project" };
    const otherEnvironment = { ...worktree, id: "other-environment", projectId: otherProject.id };
    view.rerender(
      <ProjectSearchBar
        projects={[project, otherProject]}
        environments={[container, otherEnvironment]}
        onSelectProject={() => undefined}
        onSelectEnvironment={() => undefined}
        commandHandlers={handlers}
      />,
    );
    select(container.id);
    const layout = appCommandStore(paneLayoutStore).getState();
    act(() => {
      layout.initialize(null, otherEnvironment.id);
      layout.addTab(
        layout.getActivePaneId(otherEnvironment.id)!,
        { id: "other-tab", type: "agent-native" },
        otherEnvironment.id,
      );
    });
    const input = await openPalette();
    fireEvent.change(input, { target: { value: otherProject.name } });
    await screen.findByTestId("command-palette-history-other-tab");
    fireEvent.change(input, { target: { value: "unmatched" } });
    fireEvent.change(input, { target: { value: otherProject.name } });
    expectDomAbsent(screen.queryByTestId("command-palette-history-other-tab"), "previous request");
    await screen.findByTestId("command-palette-history-other-tab");
    act(() =>
      layout.removeTab(
        layout.getActivePaneId(otherEnvironment.id)!,
        "other-tab",
        otherEnvironment.id,
      ),
    );
    expectDomAbsent(screen.queryByTestId("command-palette-history-other-tab"), "closed tab");
  });

  test("Alt+Down reaches every category and the category filter hides other groups", async () => {
    renderPalette();
    select("env-container");
    const input = await openPalette();
    fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    expect(await screen.findByLabelText("Filter results: Actions")).toBeTruthy();
    expectDomAbsent(screen.queryByTestId("project-search-item-project-1"), "project under Actions");
    expect(screen.getByTestId("command-palette-item-app.keyboard-shortcuts")).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    expect(await screen.findByLabelText("Filter results: Settings")).toBeTruthy();
    expect(screen.getByTestId("command-palette-item-settings.environment")).toBeTruthy();
  });
  /** An agent chat in the context environment, with one loaded message, and a past-session list. */
  function seedConversations() {
    const listed: string[] = [];
    invokeMock.mockImplementation(async (command: string, args?: { agent?: string }) => {
      if (command !== "list_native_agent_resumable_sessions") return undefined;
      listed.push(String(args?.agent));
      return [
        {
          sessionId: "past-1",
          title: "Investigate arm64 linker",
          updatedAt: "2026-11-18T10:00:00.000Z",
        },
        { sessionId: "open-1", title: "arm64 chat already open" },
      ];
    });
    act(() => {
      const layouts = appCommandStore(paneLayoutStore).getState();
      // A fresh layout: earlier tests leave tabs in this environment's.
      layouts.reset("env-container");
      layouts.initialize("container-1", "env-container");
      layouts.addTab(
        layouts.getActivePaneId("env-container")!,
        {
          id: "tab-chat",
          type: "agent-native",
          displayTitle: "deploy chat",
          nativeAgentData: {
            platform: "codex",
            environmentId: "env-container",
            containerId: "container-1",
            isLocal: false,
            sessionId: "open-1",
          },
        },
        "env-container",
      );
      layouts.addTab(
        layouts.getActivePaneId("env-container")!,
        { id: "tab-shell", type: "plain" },
        "env-container",
      );
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(createSessionKey("env-container", "tab-chat"), {
          platform: "codex",
          environmentId: "env-container",
          sessionId: "open-1",
          messages: [
            {
              id: "m-1",
              role: "assistant",
              content: "The arm64 build failed at link time.",
              parts: [],
              createdAt: "2026-11-19T00:00:00.000Z",
            },
          ],
        } as never);
    });
    return listed;
  }

  test("History finds a loaded message and opens its tab at that message", async () => {
    renderPalette();
    select("env-container");
    seedConversations();
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "arm64 link" } });
    const row = await screen.findByTestId("command-palette-message-m-1");
    expect(row.getAttribute("aria-label")).toContain("Agent reply in deploy chat");
    expect(row.textContent).toContain("arm64 build failed at link time");
    expect(screen.getByTestId("command-palette-history-messages").textContent).toContain(
      "Messages",
    );

    fireEvent.click(row);
    const key = conversationScrollTargetKey({
      nodeId: appCommandScope().nodeId,
      environmentId: "env-container",
      tabId: "tab-chat",
    });
    expect(useConversationScrollTargetStore.getState().targets.get(key)?.messageId).toBe("m-1");
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "closed palette"));
  });

  test("History lists past sessions once per palette session and resumes one in a new tab", async () => {
    renderPalette();
    select("env-container");
    const listed = seedConversations();
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "arm64" } });
    const past = await screen.findByTestId("command-palette-session-past-1");
    expect(past.getAttribute("aria-label")).toBe(
      "Investigate arm64 linker, Codex session in build-modal-steps; resumes it in a new tab",
    );
    // The conversation already open in a tab is listed under Open tabs, not here.
    expectDomAbsent(screen.queryByTestId("command-palette-session-open-1"), "open conversation");
    fireEvent.change(input, { target: { value: "linker" } });
    await screen.findByTestId("command-palette-session-past-1");
    // Typing filters the list read once; only the platform of an open tab is read.
    expect(listed).toEqual(["codex"]);

    fireEvent.click(screen.getByTestId("command-palette-session-past-1"));
    const tabs = appCommandStore(paneLayoutStore).getState().getAllTabs("env-container");
    const opened = tabs.find((tab) => !["tab-chat", "tab-shell"].includes(tab.id));
    expect(opened?.type).toBe("agent-native");
    expect(opened?.nativeAgentData).toMatchObject({
      platform: "codex",
      environmentId: "env-container",
    });
    expect(opened?.nativeAgentData?.sessionId).toBeUndefined();
    const request = peekNativeAgentResumeRequest({
      nodeId: appCommandScope().nodeId,
      environmentId: "env-container",
      tabId: opened!.id,
    });
    expect(request).toMatchObject({ platform: "codex", sessionId: "past-1" });
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "closed palette"));
  });

  test("History explains why past sessions are not listed", async () => {
    renderPalette({ ...container, status: "stopped" });
    select("env-container");
    seedConversations();
    const input = await openPalette();
    for (let index = 0; index < 5; index += 1) {
      fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    }
    expect(await screen.findByLabelText("Filter results: History")).toBeTruthy();
    expect((await screen.findByTestId("command-palette-history-sessions")).textContent).toContain(
      "Start build-modal-steps to list its past sessions.",
    );
  });
});
