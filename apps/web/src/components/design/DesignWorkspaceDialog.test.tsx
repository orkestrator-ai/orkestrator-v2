import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import { invoke } from "@/lib/native/backend";
import { useHostPathPickerStore } from "@/lib/host-path-picker";
import { createSessionKey } from "@/lib/utils";
import { useConfigStore } from "@/stores";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  nativeComposeDraft,
  useNativeComposeStore,
} from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import type {
  CreatableTabType,
  CreateTabOptions,
} from "@/contexts/TerminalContext";
import type { DesignReadinessView } from "./design-launch";
import { DesignWorkspaceDialog } from "./DesignWorkspaceDialog";
import {
  deferred,
  dispatchImagePaste,
  installImagePasteSupport,
  pasteImage,
  settlePaste,
} from "./design-paste-test-support";

// `@/lib/native/backend` is mocked once in tests/setup.ts; vary its behavior here.
const invokeMock = invoke as unknown as Mock<
  (command: string, args?: unknown) => Promise<unknown>
>;

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
  useNativeComposeStore.setState({ drafts: new Map() });
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args?: unknown) => {
    const action = (args as { action?: string } | undefined)?.action;
    if (command === "design_action" && action === "create_canvas")
      return canvas;
    if (command === "design_action" && action === "delete_canvas")
      return { deleted: true };
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

function mount(
  createTab: (type: CreatableTabType, options?: CreateTabOptions) => boolean,
) {
  const onOpenChange = mock((_open: boolean) => {});
  const loadReadiness = mock(async (_probe: boolean) => legacyReady);
  render(
    <DesignWorkspaceDialog
      open
      onOpenChange={onOpenChange}
      environmentId="env-1"
      createTab={createTab}
      loadReadiness={loadReadiness}
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

const brief = () =>
  screen.getByRole("textbox", { name: "Design brief" }) as HTMLTextAreaElement;

describe("DesignWorkspaceDialog", () => {
  function supportPaste(write?: Promise<string>) {
    const restore = installImagePasteSupport();
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
    invokeMock.mockImplementation(async (command, args) => {
      const request = args as { action?: string; filePath?: string };
      if (command === "write_local_file")
        return write ?? `/tmp/wt/${request.filePath}`;
      if (request.action === "create_canvas") return canvas;
      if (request.action === "delete_canvas") return { deleted: true };
      throw new Error(`Unexpected command: ${command}`);
    });
    return restore;
  }

  test("blocks immediate submission during decoding and writing, then transfers once and freezes pastes", async () => {
    const write = deferred<string>();
    const createCanvas = deferred<DesignCanvas>();
    const restore = supportPaste(write.promise);
    const handler = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command, args) => {
      if (
        command === "design_action" &&
        (args as { action: string }).action === "create_canvas"
      )
        return createCanvas.promise;
      return handler(command, args);
    });
    let attachments: unknown[] = [];
    const createTab = mock(
      (type: CreatableTabType, options?: CreateTabOptions) => {
        if (type === "claude")
          attachments = nativeComposeDraft(
            useNativeComposeStore.getState(),
            createSessionKey("env-1", options!.tabId!),
          ).attachments;
        usePaneLayoutStore
          .getState()
          .addTab("pane-1", { id: options!.tabId!, type: "plain" }, "env-1");
        return true;
      },
    );
    try {
      mount(createTab);
      await flush();
      const submit = screen.getByRole("button", {
        name: "Create design workspace",
      }) as HTMLButtonElement;
      act(() => {
        dispatchImagePaste(brief());
        fireEvent.submit(submit.closest("form")!);
      });
      expect(submit.disabled).toBe(true);
      await settlePaste();
      expect(createTab).not.toHaveBeenCalled();
      expect(
        invokeMock.mock.calls.some(([command]) => command === "design_action"),
      ).toBe(false);
      await act(async () => write.resolve("/tmp/wt/shot.png"));
      expect(submit.disabled).toBe(false);
      fireEvent.click(submit);
      await pasteImage(brief());
      expect(
        invokeMock.mock.calls.filter(
          ([command]) => command === "write_local_file",
        ),
      ).toHaveLength(1);
      await act(async () => createCanvas.resolve(canvas));
      expect(attachments).toHaveLength(1);
      expect(
        createTab.mock.calls.filter(([type]) => type === "claude"),
      ).toHaveLength(1);
    } finally {
      restore();
    }
  });

  for (const failure of ["false", "throw"] as const) {
    test(`clears the seeded image draft when agent tab creation ${failure === "false" ? "returns false" : "throws"}`, async () => {
      const restore = supportPaste();
      let key = "";
      const createTab = mock(
        (type: CreatableTabType, options?: CreateTabOptions) => {
          if (type === "claude") {
            key = createSessionKey("env-1", options!.tabId!);
            expect(
              nativeComposeDraft(useNativeComposeStore.getState(), key)
                .attachments,
            ).toHaveLength(1);
            if (failure === "throw") throw new Error("tab creation failed");
            return false;
          }
          usePaneLayoutStore
            .getState()
            .addTab("pane-1", { id: options!.tabId!, type: "plain" }, "env-1");
          return true;
        },
      );
      try {
        const { onOpenChange } = mount(createTab);
        await flush();
        await pasteImage(brief());
        fireEvent.click(
          screen.getByRole("button", { name: "Create design workspace" }),
        );
        await flush();
        expect(key).not.toBe("");
        expect(useNativeComposeStore.getState().drafts.has(key)).toBe(false);
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(screen.getByRole("alert")).toBeTruthy();
        expect(
          screen
            .getByRole("list", { name: "Attached images" })
            .querySelectorAll("img"),
        ).toHaveLength(1);
      } finally {
        restore();
      }
    });
  }

  test("refuses launch visibly when the draft merge rejects the images", async () => {
    const restore = supportPaste();
    // Exercise the defensive boundary independently of the paste-cap gate.
    const module = await import("./design-prompt-images");
    const merge = spyOn(module, "addDesignImagesToDraft").mockReturnValue(
      false,
    );
    const createTab = mock(
      (_type: CreatableTabType, options?: CreateTabOptions) => {
        usePaneLayoutStore
          .getState()
          .addTab("pane-1", { id: options!.tabId!, type: "plain" }, "env-1");
        return true;
      },
    );
    try {
      const { onOpenChange } = mount(createTab);
      await flush();
      await pasteImage(brief());
      fireEvent.click(
        screen.getByRole("button", { name: "Create design workspace" }),
      );
      await flush();
      expect(merge).toHaveBeenCalledTimes(1);
      expect(createTab.mock.calls.some(([type]) => type === "claude")).toBe(
        false,
      );
      expect(screen.getByRole("alert").textContent).toContain(
        "Too many images",
      );
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      merge.mockRestore();
      restore();
    }
  });

  test("clears staged images and discards a pending completion when environment changes", async () => {
    const restore = supportPaste();
    const loadReadiness = async () => legacyReady;
    const props = {
      open: true,
      onOpenChange: mock(),
      createTab: () => true,
      loadReadiness,
    };
    const view = render(
      <DesignWorkspaceDialog {...props} environmentId="env-1" />,
    );
    try {
      await flush();
      await pasteImage(brief());
      const old = deferred<string>();
      invokeMock.mockImplementationOnce(() => old.promise);
      await pasteImage(brief());
      view.rerender(<DesignWorkspaceDialog {...props} environmentId="env-2" />);
      await flush();
      expect(
        screen.queryByRole("list", { name: "Attached images" }) === null,
      ).toBe(true);
      await act(async () => old.resolve("/tmp/wt/stale.png"));
      expect(
        screen.queryByRole("list", { name: "Attached images" }) === null,
      ).toBe(true);
    } finally {
      restore();
    }
  });

  test("probes readiness once when opened", async () => {
    const { loadReadiness } = mount(() => true);
    await flush();
    expect(loadReadiness.mock.calls).toEqual([[true]]);
    expect(screen.queryByLabelText("Design readiness") === null).toBe(true);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "New design",
      "Open design",
    ]);
  });

  test("switching modes preserves the draft brief", async () => {
    mount(() => true);
    await flush();
    fireEvent.change(brief(), { target: { value: "A calmer checkout" } });
    await switchTo("Open design");
    expect(
      screen.queryByRole("textbox", { name: "Design brief" }) === null,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Choose .orkdes file…" }),
    ).toBeTruthy();
    await switchTo("New design");
    expect(brief().value).toBe("A calmer checkout");
  });

  test("Open design uses the host path picker and offers recovery after its tab cannot open", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "design_import_host_file") return canvas;
      throw new Error(`Unexpected command: ${command}`);
    });
    let canOpen = false;
    const createTab = mock(() => canOpen);
    const { onOpenChange } = mount(createTab);
    await flush();
    await switchTo("Open design");
    fireEvent.click(
      screen.getByRole("button", { name: "Choose .orkdes file…" }),
    );
    const request = useHostPathPickerStore.getState().request;
    expect(request?.mode).toBe("file");
    await act(async () =>
      useHostPathPickerStore
        .getState()
        .settle("/home/me/designs/import.orkdes"),
    );
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("design_import_host_file", {
      environmentId: "env-1",
      path: "/home/me/designs/import.orkdes",
    });
    expect(screen.getByRole("status").textContent).toContain("Opened");
    canOpen = true;
    fireEvent.click(screen.getByRole("button", { name: "Open design" }));
    expect(createTab).toHaveBeenLastCalledWith("design-canvas", {
      canvasId: canvas.id,
      designPlacement: "split",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "design_import_host_file",
      ),
    ).toHaveLength(1);
  });

  test("Open design rejects a picked file that is not .orkdes", async () => {
    mount(() => true);
    await flush();
    await switchTo("Open design");
    fireEvent.click(
      screen.getByRole("button", { name: "Choose .orkdes file…" }),
    );
    await act(async () =>
      useHostPathPickerStore.getState().settle("/home/me/notes.txt"),
    );
    await flush();
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose an .orkdes design file.",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("layout failure before the agent exists rolls back and keeps the brief", async () => {
    const createTab = mock(
      (_type: CreatableTabType, _options?: CreateTabOptions) => false,
    );
    const { onOpenChange } = mount(createTab);
    await flush();
    fireEvent.change(brief(), { target: { value: "Keep me" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Create design workspace" }),
    );
    await flush();
    expect(createTab.mock.calls.map((call) => call[0])).toEqual([
      "design-canvas",
    ]);
    expect(
      invokeMock.mock.calls.map(
        (call) => (call[1] as { action?: string }).action,
      ),
    ).toEqual(["create_canvas", "delete_canvas"]);
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not open a tab",
    );
    expect(screen.queryByRole("button", { name: "Open design" }) === null).toBe(
      true,
    );
    expect(brief().value).toBe("Keep me");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("failure after the agent tab exists offers to open the kept design", async () => {
    const createTab = mock(
      (type: CreatableTabType, options?: CreateTabOptions) => {
        if (type === "design-canvas") return true;
        usePaneLayoutStore
          .getState()
          .addTab("pane-1", { id: options!.tabId!, type: "plain" }, "env-1");
        throw new Error("agent mount failed");
      },
    );
    const { onOpenChange } = mount(createTab);
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Create design workspace" }),
    );
    await flush();
    const agentCall = createTab.mock.calls.find((call) => call[0] === "claude");
    expect(agentCall?.[1]).toMatchObject({
      agentLaunchMode: "native",
      displayTitle: "Design",
    });
    expect(agentCall?.[1]?.initialPrompt).toContain(canvas.id);
    expect(
      invokeMock.mock.calls.some(
        (call) => (call[1] as { action?: string }).action === "delete_canvas",
      ),
    ).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain(
      "Your design was created",
    );
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
      const request = args as {
        action?: string;
        worktreePath?: string;
        filePath?: string;
      };
      if (command === "design_action" && request.action === "create_canvas")
        return canvas;
      if (command === "write_local_file")
        return `${request.worktreePath}/${request.filePath}`;
      throw new Error(`Unexpected command: ${command}`);
    });
    let draftAtLaunch: ReturnType<typeof nativeComposeDraft> | null = null;
    const createTab = mock(
      (type: CreatableTabType, options?: CreateTabOptions) => {
        if (type === "claude")
          draftAtLaunch = nativeComposeDraft(
            useNativeComposeStore.getState(),
            createSessionKey("env-1", options!.tabId!),
          );
        usePaneLayoutStore
          .getState()
          .addTab("pane-1", { id: options!.tabId!, type: "plain" }, "env-1");
        return true;
      },
    );
    try {
      const { onOpenChange } = mount(createTab);
      await flush();
      fireEvent.change(brief(), { target: { value: "Match this screenshot" } });
      await pasteImage(brief());

      const attached = screen.getByRole("list", { name: "Attached images" });
      expect(attached.querySelectorAll("img")).toHaveLength(1);
      expect(brief().value).toBe("Match this screenshot");

      fireEvent.click(
        screen.getByRole("button", { name: "Create design workspace" }),
      );
      await flush();

      const agentCall = createTab.mock.calls.find(
        (call) => call[0] === "claude",
      );
      expect(agentCall?.[1]?.initialPrompt).toContain("Match this screenshot");
      expect(draftAtLaunch).not.toBeNull();
      expect(draftAtLaunch!.attachments).toHaveLength(1);
      expect(draftAtLaunch!.attachments[0]).toMatchObject({ type: "image" });
      expect(draftAtLaunch!.attachments[0]!.path).toStartWith(
        "/tmp/wt/.orkestrator/clipboard/",
      );
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
      if (command === "write_local_file")
        return `${request.worktreePath}/${request.filePath}`;
      throw new Error(`Unexpected command: ${command}`);
    });
    try {
      mount(() => true);
      await flush();
      await pasteImage(brief());
      const remove = screen.getByRole("button", {
        name: /^Remove clipboard-.*\.png$/,
      });
      fireEvent.click(remove);
      expect(
        screen.queryByRole("list", { name: "Attached images" }) === null,
      ).toBe(true);
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
    const createTab = mock(
      (_type: CreatableTabType, _options?: CreateTabOptions) => true,
    );
    const { onOpenChange } = mount(createTab);
    await flush();
    expect(
      screen.queryByRole("textbox", { name: "Design brief" }) === null,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Create blank canvas" }),
    );
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
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "   " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create design workspace" }),
    );
    await flush();
    expect(screen.getByText("Enter a name for the design.")).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  test("an unavailable renderer blocks creation but not opening", async () => {
    const onOpenChange = mock(() => {});
    render(
      <DesignWorkspaceDialog
        open
        onOpenChange={onOpenChange}
        environmentId="env-1"
        createTab={() => true}
        loadReadiness={async () => ({
          ...legacyReady,
          renderer: {
            state: "missing-executable",
            ready: false,
            message: "install",
          },
        })}
      />,
    );
    await flush();
    const create = screen.getByRole("button", {
      name: "Create design workspace",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(
      screen.getByText(/Creating a design needs the renderer/),
    ).toBeTruthy();
    await switchTo("Open design");
    expect(
      screen.getByText(/an opened design will be stored unvalidated/),
    ).toBeTruthy();
  });
});
