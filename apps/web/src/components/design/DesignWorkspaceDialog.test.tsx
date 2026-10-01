import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import { invoke } from "@/lib/native/backend";
import { createSessionKey } from "@/lib/utils";
import { useConfigStore } from "@/stores";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { nativeComposeDraft, useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import type { CreatableTabType, CreateTabOptions } from "@/contexts/TerminalContext";
import type { DesignReadinessView } from "./design-launch";
import type { DesignLibraryClient } from "./DesignLibrary";
import { DesignWorkspaceDialog } from "./DesignWorkspaceDialog";
import { installImagePasteSupport, pasteImage } from "./design-paste-test-support";

// `@/lib/native/backend` is mocked once in tests/setup.ts; vary its behavior here.
const invokeMock = invoke as unknown as Mock<(command: string, args?: unknown) => Promise<unknown>>;

const canvas = {
  format: "orkdes",
  version: 1,
  id: "3f9b0c1e-2d4a-4f5b-8c6d-7e8f9a0b1c2d",
  environmentId: "env-1",
  name: "Checkout",
  revision: 1,
  frames: [],
} satisfies DesignCanvas;

const legacyReady: DesignReadinessView = {
  backend: { state: "connected" },
  protocol: "v1",
  capabilities: null,
  storage: { state: "unknown" },
  renderer: { state: "ready", ready: true, message: "" },
};

const emptyLibrary: DesignLibraryClient = {
  list: async () => ({
    entries: [],
    total: 0,
    quota: {
      live: 0,
      liveLimit: 256,
      deleted: 0,
      deletedLimit: 0,
      deletedBytes: 0,
      deletedBytesLimit: 0,
    },
  }),
  lifecycle: async () => ({}) as never,
  purge: async () => ({}),
  exportDocument: async () => canvas,
};

const originalConfig = useConfigStore.getState().config;

beforeEach(() => {
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        "env-1",
        {
          root: { kind: "leaf", id: "pane-1", tabs: [], activeTabId: null },
          activePaneId: "pane-1",
          containerId: null,
        },
      ],
    ]),
    hydration: new Map([["env-1", "done"]]),
  });
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args?: unknown) => {
    const action = (args as { action?: string } | undefined)?.action;
    if (command === "design_action" && action === "create_canvas") return canvas;
    if (command === "design_action" && action === "delete_canvas") return { deleted: true };
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  cleanup();
  // After unmount, so the reset does not re-render a mounted dialog outside act().
  useEnvironmentStore.setState({ environments: [] });
  invokeMock.mockImplementation(() => Promise.resolve());
  useConfigStore.setState({ config: originalConfig });
});

function mount(createTab: (type: CreatableTabType, options?: CreateTabOptions) => boolean) {
  const onOpenChange = mock((_open: boolean) => {});
  const loadReadiness = mock(async (_probe: boolean) => legacyReady);
  render(
    <DesignWorkspaceDialog
      open
      onOpenChange={onOpenChange}
      environmentId="env-1"
      createTab={createTab}
      loadReadiness={loadReadiness}
      libraryClient={emptyLibrary}
    />,
  );
  return { onOpenChange, loadReadiness };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const switchTo = (name: string) =>
  act(() => {
    fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
  });

const brief = () => screen.getByRole("textbox", { name: "Design brief" }) as HTMLTextAreaElement;

describe("DesignWorkspaceDialog", () => {
  test("probes readiness once when opened", async () => {
    const { loadReadiness } = mount(() => true);
    await flush();
    expect(loadReadiness.mock.calls).toEqual([[true]]);
    expect(screen.getByText("Design services ready.")).toBeTruthy();
  });

  test("switching modes preserves the draft brief", async () => {
    mount(() => true);
    await flush();
    fireEvent.change(brief(), { target: { value: "A calmer checkout" } });
    await switchTo("Open");
    expect(screen.queryByRole("textbox", { name: "Design brief" }) === null).toBe(true);
    await flush();
    await switchTo("Import");
    expect(screen.getByLabelText("Import .orkdes")).toBeTruthy();
    await switchTo("New design");
    expect(brief().value).toBe("A calmer checkout");
  });

  test("layout failure before the agent exists rolls back and keeps the brief", async () => {
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => false);
    const { onOpenChange } = mount(createTab);
    await flush();
    fireEvent.change(brief(), { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Create design workspace" }));
    await flush();
    expect(createTab.mock.calls.map((call) => call[0])).toEqual(["design-canvas"]);
    expect(invokeMock.mock.calls.map((call) => (call[1] as { action?: string }).action)).toEqual([
      "create_canvas",
      "delete_canvas",
    ]);
    expect(screen.getByRole("alert").textContent).toContain("Could not open a tab");
    expect(screen.queryByRole("button", { name: "Open design" }) === null).toBe(true);
    expect(brief().value).toBe("Keep me");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("failure after the agent tab exists offers to open the kept design", async () => {
    const createTab = mock((type: CreatableTabType, options?: CreateTabOptions) => {
      if (type === "design-canvas") return true;
      usePaneLayoutStore
        .getState()
        .addTab("pane-1", { id: options!.tabId!, type: "plain" }, "env-1");
      throw new Error("agent mount failed");
    });
    const { onOpenChange } = mount(createTab);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Create design workspace" }));
    await flush();
    const agentCall = createTab.mock.calls.find((call) => call[0] === "claude");
    expect(agentCall?.[1]).toMatchObject({ agentLaunchMode: "native", displayTitle: "Design" });
    expect(agentCall?.[1]?.initialPrompt).toContain(canvas.id);
    expect(
      invokeMock.mock.calls.some(
        (call) => (call[1] as { action?: string }).action === "delete_canvas",
      ),
    ).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("Your design was created");
    fireEvent.click(screen.getByRole("button", { name: "Open design" }));
    expect(createTab.mock.calls.at(-1)).toEqual([
      "design-canvas",
      { canvasId: canvas.id, designPlacement: "split" },
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("a pasted image is attached to the agent's initial prompt", async () => {
    const restorePaste = installImagePasteSupport();
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          containerId: null,
          status: "running",
          environmentType: "local",
          worktreePath: "/tmp/wt",
        } as Environment,
      ],
    });
    useNativeComposeStore.setState({ drafts: new Map() });
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      const request = args as { action?: string; worktreePath?: string; filePath?: string };
      if (command === "design_action" && request.action === "create_canvas") return canvas;
      if (command === "write_local_file") return `${request.worktreePath}/${request.filePath}`;
      throw new Error(`Unexpected command: ${command}`);
    });
    let draftAtLaunch: ReturnType<typeof nativeComposeDraft> | null = null;
    const createTab = mock((type: CreatableTabType, options?: CreateTabOptions) => {
      if (type === "claude")
        draftAtLaunch = nativeComposeDraft(
          useNativeComposeStore.getState(),
          createSessionKey("env-1", options!.tabId!),
        );
      usePaneLayoutStore
        .getState()
        .addTab("pane-1", { id: options!.tabId!, type: "plain" }, "env-1");
      return true;
    });
    try {
      const { onOpenChange } = mount(createTab);
      await flush();
      fireEvent.change(brief(), { target: { value: "Match this screenshot" } });
      await pasteImage(brief());

      const attached = screen.getByRole("list", { name: "Attached images" });
      expect(attached.querySelectorAll("img")).toHaveLength(1);
      expect(brief().value).toBe("Match this screenshot");

      fireEvent.click(screen.getByRole("button", { name: "Create design workspace" }));
      await flush();

      const agentCall = createTab.mock.calls.find((call) => call[0] === "claude");
      expect(agentCall?.[1]?.initialPrompt).toContain("Match this screenshot");
      expect(draftAtLaunch).not.toBeNull();
      expect(draftAtLaunch!.attachments).toHaveLength(1);
      expect(draftAtLaunch!.attachments[0]).toMatchObject({ type: "image" });
      expect(draftAtLaunch!.attachments[0]!.path).toStartWith("/tmp/wt/.orkestrator/clipboard/");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      restorePaste();
    }
  });

  test("a pasted image can be removed before launch", async () => {
    const restorePaste = installImagePasteSupport();
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          containerId: null,
          status: "running",
          environmentType: "local",
          worktreePath: "/tmp/wt",
        } as Environment,
      ],
    });
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      const request = args as { worktreePath?: string; filePath?: string };
      if (command === "write_local_file") return `${request.worktreePath}/${request.filePath}`;
      throw new Error(`Unexpected command: ${command}`);
    });
    try {
      mount(() => true);
      await flush();
      await pasteImage(brief());
      const remove = screen.getByRole("button", { name: /^Remove clipboard-.*\.png$/ });
      fireEvent.click(remove);
      expect(screen.queryByRole("list", { name: "Attached images" }) === null).toBe(true);
    } finally {
      restorePaste();
    }
  });

  test("a blank canvas needs no agent and closes when opened", async () => {
    useConfigStore.setState({
      config: {
        ...originalConfig,
        global: { ...originalConfig.global, enabledAgentPlatforms: [] },
      },
    });
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);
    const { onOpenChange } = mount(createTab);
    await flush();
    expect(screen.queryByRole("textbox", { name: "Design brief" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create blank canvas" }));
    await flush();
    expect(createTab.mock.calls).toHaveLength(1);
    expect(createTab.mock.calls[0]?.[1]).toMatchObject({
      canvasId: canvas.id,
      designPlacement: "split",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("a blank name is rejected before anything is created", async () => {
    const createTab = mock(() => true);
    mount(createTab);
    await flush();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create design workspace" }));
    await flush();
    expect(screen.getByText("Enter a name for the design.")).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  test("an unavailable renderer blocks creation but not the library or import", async () => {
    const onOpenChange = mock(() => {});
    render(
      <DesignWorkspaceDialog
        open
        onOpenChange={onOpenChange}
        environmentId="env-1"
        createTab={() => true}
        loadReadiness={async () => ({
          ...legacyReady,
          renderer: { state: "missing-executable", ready: false, message: "install" },
        })}
        libraryClient={emptyLibrary}
      />,
    );
    await flush();
    const create = screen.getByRole("button", {
      name: "Create design workspace",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByText(/Creating a design needs the renderer/)).toBeTruthy();
    await switchTo("Import");
    expect(screen.getByText(/an import will be stored unvalidated/)).toBeTruthy();
    await switchTo("Open");
    await flush();
    expect(screen.getByText(/No designs yet/)).toBeTruthy();
  });
});
