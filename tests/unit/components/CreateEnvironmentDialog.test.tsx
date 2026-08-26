import { afterEach, beforeEach, describe, test, expect, mock, spyOn } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { invoke } from "@/lib/native/backend";
import { mockReadImage } from "../../mocks/clipboard";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../mocks/sonner";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";

const { CreateEnvironmentDialog, getEncodedImageSizeError, resolveAgentDefaults } =
  await import("../../../apps/web/src/components/environments/CreateEnvironmentDialog");
const defaultConfig = structuredClone(useConfigStore.getState().config);
const defaultClaudeModels = useClaudeStore.getState().models;
const defaultCodexModels = useCodexStore.getState().models;
const defaultOpenCodeModels = useOpenCodeStore.getState().models;
const invokeMock = invoke as ReturnType<typeof mock>;

if (typeof globalThis.ImageData === "undefined") {
  (globalThis as Record<string, unknown>).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;

    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const putImageData = mock(() => {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function rgbaBuffer(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height * 4);
}

const AGENT_MODEL_PICKER_NAME = "Agent, model and reasoning";

function getAgentModelPicker() {
  return screen.getByRole("combobox", { name: AGENT_MODEL_PICKER_NAME });
}

function openAgentModelPicker() {
  const picker = getAgentModelPicker();
  if (picker.getAttribute("aria-expanded") !== "true") {
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
  }
  const platform = picker
    .querySelector("[data-native-model-platform]")
    ?.getAttribute("data-native-model-platform");
  if (platform) {
    const catalog = screen.queryByRole("button", { name: `${platform} models` });
    if (catalog && catalog.getAttribute("aria-pressed") !== "true") {
      fireEvent.click(catalog);
    }
  }
  return picker;
}

async function selectAgentPlatform(label: "Claude" | "Codex" | "Cursor" | "Grok" | "OpenCode") {
  openAgentModelPicker();
  fireEvent.click(await screen.findByRole("button", { name: `${label.toLowerCase()} models` }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(getAgentModelPicker().getAttribute("aria-expanded")).toBe("false"));
}

async function selectAgentModel(name: string | RegExp) {
  const picker = openAgentModelPicker();
  const platform = picker
    .querySelector("[data-native-model-platform]")
    ?.getAttribute("data-native-model-platform");
  if (platform) {
    fireEvent.click(screen.getByRole("button", { name: `${platform} models` }));
  }
  fireEvent.click(await screen.findByRole("menuitemradio", { name }));
}

async function selectReasoning(name: string) {
  openAgentModelPicker();
  fireEvent.click(await screen.findByRole("menuitemradio", { name }));
}

describe("resolveAgentDefaults", () => {
  beforeEach(() => {
    cleanup();
    useConfigStore.setState({
      config: structuredClone(defaultConfig),
      isLoading: false,
      error: null,
    });
    useClaudeStore.setState({ models: defaultClaudeModels });
    useCodexStore.setState({ models: defaultCodexModels });
    useOpenCodeStore.setState({ models: new Map(defaultOpenCodeModels) });
    useAgentModelCatalogStore.setState({ cursorModels: [], grokModels: [], piModels: [] });
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_preferences") {
        return Promise.resolve({ recent: [], favorite: [], variant: {} });
      }
      if (command === "get_opencode_model_catalog_cache") {
        return Promise.resolve(null);
      }
      return Promise.resolve(undefined);
    });
    mockReadImage.mockReset();
    putImageData.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    mockReadImage.mockImplementation(() => Promise.reject(new Error("no image")));
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() =>
      "data:image/png;base64,QUJD") as typeof HTMLCanvasElement.prototype.toDataURL;
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  });

  const tiers = (global: unknown, repository?: unknown) => ({ global, repository }) as never;

  test("uses app-level defaults when no repo config provided", () => {
    const result = resolveAgentDefaults(
      tiers({
        defaultAgent: "claude",
        platforms: {
          claude: { mode: "native" },
          opencode: { mode: "terminal" },
          codex: { mode: "native" },
        },
      }),
    );
    expect(result.defaultAgent).toBe("claude");
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("terminal");
    expect(result.codexMode).toBe("native");
  });

  test("disables container creation and falls back to a local worktree without Docker", async () => {
    const onCreate = mock(async () => {});
    render(
      <DockerAvailabilityProvider available={false}>
        <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />
      </DockerAvailabilityProvider>,
    );

    const container = screen.getByRole("button", { name: /Containerized/ });
    expect((container as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Unavailable while Docker is stopped")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("falls back to a local worktree when Docker stops while the dialog is open", async () => {
    const onCreate = mock(async () => {});
    const dialog = <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />;
    const view = render(
      <DockerAvailabilityProvider available>{dialog}</DockerAvailabilityProvider>,
    );

    expect(
      (screen.getByRole("button", { name: /Containerized/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    view.rerender(
      <DockerAvailabilityProvider available={false}>{dialog}</DockerAvailabilityProvider>,
    );

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /Containerized/ }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("does not force a local submission when the project has no local checkout", () => {
    const onCreate = mock(async () => {});
    render(
      <DockerAvailabilityProvider available={false}>
        <CreateEnvironmentDialog
          open
          onOpenChange={() => {}}
          onCreate={onCreate}
          localEnvironmentAvailable={false}
        />
      </DockerAvailabilityProvider>,
    );

    expect(
      (screen.getByRole("button", { name: /Containerized/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: /Local/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const submit = screen.getByRole("button", { name: "Create Environment" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(onCreate).not.toHaveBeenCalled();
  });

  test("uses app-level defaults when the repository overrides nothing", () => {
    const result = resolveAgentDefaults(
      tiers(
        {
          defaultAgent: "opencode",
          platforms: {
            claude: { mode: "terminal" },
            opencode: { mode: "native" },
            codex: { mode: "terminal" },
          },
        },
        {},
      ),
    );
    expect(result.defaultAgent).toBe("opencode");
    expect(result.claudeMode).toBe("terminal");
    expect(result.opencodeMode).toBe("native");
    expect(result.codexMode).toBe("terminal");
  });

  test("a repository default agent overrides the app one", () => {
    const result = resolveAgentDefaults(
      tiers({ defaultAgent: "claude" }, { defaultAgent: "opencode" }),
    );
    expect(result.defaultAgent).toBe("opencode");
  });

  test("a repository mode overrides only its own platform", () => {
    // The repository used to carry one `agentStyle` that moved Claude, Codex
    // and OpenCode together, so choosing Native for Claude silently moved the
    // other two. Each platform now has its own column.
    const result = resolveAgentDefaults(
      tiers(
        {
          defaultAgent: "claude",
          platforms: {
            claude: { mode: "terminal" },
            opencode: { mode: "terminal" },
            codex: { mode: "native" },
          },
        },
        { platforms: { claude: { mode: "native" } } },
      ),
    );
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("terminal");
    expect(result.codexMode).toBe("native");
  });

  test("falls back to the shipped defaults when no tier decides", () => {
    const result = resolveAgentDefaults(tiers(undefined));
    expect(result.defaultAgent).toBe("claude");
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("terminal");
    // Codex ships terminal; only Claude ships native.
    expect(result.codexMode).toBe("terminal");
  });

  test("a repository mode does not affect which agent is default", () => {
    const result = resolveAgentDefaults(
      tiers({ defaultAgent: "claude" }, { platforms: { claude: { mode: "terminal" } } }),
    );
    expect(result.defaultAgent).toBe("claude");
    expect(result.claudeMode).toBe("terminal");
  });

  test("a repository default agent does not affect mode resolution", () => {
    const result = resolveAgentDefaults(
      tiers(
        {
          defaultAgent: "claude",
          platforms: {
            claude: { mode: "native" },
            opencode: { mode: "native" },
            codex: { mode: "terminal" },
          },
        },
        { defaultAgent: "opencode" },
      ),
    );
    expect(result.defaultAgent).toBe("opencode");
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("native");
    expect(result.codexMode).toBe("terminal");
  });

  test("shows the project name in the title and presents the compact agent controls in order", () => {
    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
        projectName="Orkestrator"
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Create Ork (Environment) - Orkestrator",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Default Agent" }) === null).toBe(true);
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" }) === null).toBe(true);
    expect(getAgentModelPicker()).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "Use TUI" }) as HTMLButtonElement).getAttribute(
        "data-state",
      ),
    ).toBe("unchecked");
  });

  test("starts on the prompt tab and preserves values while moving between mobile sections", () => {
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Prompt",
      "Setup",
      "Agent",
      "Access",
      "Ports",
    ]);

    const promptTab = screen.getByRole("tab", { name: "Prompt" });
    const setupTab = screen.getByRole("tab", { name: "Setup" });
    expect(promptTab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen
        .getByLabelText(/Initial Prompt/i)
        .closest('[role="tabpanel"]')
        ?.getAttribute("data-state"),
    ).toBe("active");

    fireEvent.mouseDown(setupTab, { button: 0, ctrlKey: false });
    expect(setupTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.change(screen.getByLabelText(/Environment Name/i), {
      target: { value: "mobile-tabs" },
    });

    fireEvent.mouseDown(promptTab, { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByLabelText(/Initial Prompt/i), {
      target: { value: "Keep this task" },
    });
    fireEvent.mouseDown(setupTab, { button: 0, ctrlKey: false });

    expect((screen.getByLabelText(/Environment Name/i) as HTMLInputElement).value).toBe(
      "mobile-tabs",
    );
    expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe(
      "Keep this task",
    );
  });

  test("sets every mobile panel's animation direction from section order", () => {
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />,
    );

    const panels = {
      Prompt: screen.getByLabelText(/Initial Prompt/i).closest('[role="tabpanel"]'),
      Setup: screen.getByLabelText(/Environment Name/i).closest('[role="tabpanel"]'),
      Agent: screen.getByRole("switch", { name: "Launch Agent" }).closest('[role="tabpanel"]'),
      Access: screen.getByRole("button", { name: "Restricted" }).closest('[role="tabpanel"]'),
      Ports: screen
        .getByRole("button", { name: /Port Configuration/ })
        .closest('[role="tabpanel"]'),
    };

    for (const panel of Object.values(panels)) {
      expect(panel?.classList.contains("create-environment-mobile-tab-panel")).toBe(true);
      expect(panel?.getAttribute("data-mobile-transition")).toBeNull();
    }

    for (const tabName of ["Setup", "Agent", "Access", "Ports"] as const) {
      fireEvent.mouseDown(screen.getByRole("tab", { name: tabName }), {
        button: 0,
        ctrlKey: false,
      });
      expect(panels[tabName]?.getAttribute("data-mobile-transition")).toBe("forward");
    }

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Setup" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(panels.Setup?.getAttribute("data-mobile-transition")).toBe("backward");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Prompt" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(panels.Prompt?.getAttribute("data-mobile-transition")).toBe("backward");
  });

  test("hides container-only mobile tabs when local setup is selected", () => {
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Setup" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("button", { name: /Local/ }));

    expect(screen.queryByRole("tab", { name: "Access" }) === null).toBe(true);
    expect(screen.queryByRole("tab", { name: "Ports" }) === null).toBe(true);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Prompt",
      "Setup",
      "Agent",
    ]);
  });

  test.each(["Access", "Ports"])(
    "returns to Setup when the active %s tab becomes unavailable",
    async (tabName) => {
      render(
        <CreateEnvironmentDialog
          open={true}
          onOpenChange={() => {}}
          onCreate={mock(async () => {})}
        />,
      );

      fireEvent.mouseDown(screen.getByRole("tab", { name: tabName }), {
        button: 0,
        ctrlKey: false,
      });
      expect(screen.getByRole("tab", { name: tabName }).getAttribute("aria-selected")).toBe("true");

      fireEvent.click(screen.getByRole("button", { name: /Local/ }));

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Setup" }).getAttribute("aria-selected")).toBe(
          "true",
        );
      });
      expect(
        screen
          .getByLabelText(/Environment Name/i)
          .closest('[role="tabpanel"]')
          ?.getAttribute("data-mobile-transition"),
      ).toBe("backward");
      expect(screen.queryByRole("tab", { name: tabName }) === null).toBe(true);
    },
  );

  test("moves from Prompt to Agent when launching an agent is disabled", async () => {
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />,
    );

    expect(screen.getByRole("tab", { name: "Prompt" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Launch Agent" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Agent" }).getAttribute("aria-selected")).toBe("true");
    });
    expect(
      screen
        .getByRole("switch", { name: "Launch Agent" })
        .closest('[role="tabpanel"]')
        ?.getAttribute("data-mobile-transition"),
    ).toBe("forward");
    expect(screen.getByRole("tab", { name: "Prompt" }).hasAttribute("disabled")).toBe(true);
  });

  test("resets the selected mobile section when the dialog reopens", async () => {
    const props = {
      onOpenChange: () => {},
      onCreate: mock(async () => {}),
    };
    const { rerender } = render(<CreateEnvironmentDialog open={true} {...props} />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Setup" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole("tab", { name: "Setup" }).getAttribute("aria-selected")).toBe("true");
    expect(
      screen
        .getByLabelText(/Environment Name/i)
        .closest('[role="tabpanel"]')
        ?.getAttribute("data-mobile-transition"),
    ).toBe("forward");

    rerender(<CreateEnvironmentDialog open={false} {...props} />);
    rerender(<CreateEnvironmentDialog open={true} {...props} />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Prompt" }).getAttribute("aria-selected")).toBe(
        "true",
      );
    });
    expect(
      screen
        .getByLabelText(/Initial Prompt/i)
        .closest('[role="tabpanel"]')
        ?.getAttribute("data-mobile-transition") === null,
    ).toBe(true);
  });

  test("clears the delayed prompt autofocus when the dialog unmounts", async () => {
    const { unmount } = render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    const focus = mock(() => {});
    prompt.focus = focus;

    unmount();
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(focus).not.toHaveBeenCalled();
  });

  test("saves a trimmed draft on cancel, resets other fields, and restores the draft", async () => {
    const projectId = "draft-cancel-project";
    const onOpenChange = mock(() => {});
    const onCreate = mock(async () => {});
    const props = {
      onOpenChange,
      onCreate,
      projectId,
    };
    const { unmount } = render(<CreateEnvironmentDialog open={true} {...props} />);

    fireEvent.change(screen.getByLabelText(/Initial Prompt/i), {
      target: { value: "  Keep this draft  " },
    });
    fireEvent.change(screen.getByLabelText(/Environment Name/i), {
      target: { value: "discard-this-name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Restricted" }));
    fireEvent.click(screen.getByRole("button", { name: /Local/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Launch Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((screen.getByLabelText(/Environment Name/i) as HTMLInputElement).value).toBe("");

    unmount();
    render(<CreateEnvironmentDialog open={true} {...props} />);
    await waitFor(() => {
      expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe(
        "Keep this draft",
      );
    });
    expect((screen.getByLabelText(/Environment Name/i) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("switch", { name: "Launch Agent" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentType: "containerized",
          environmentName: "",
          launchAgent: true,
          networkAccessMode: "full",
        }),
      );
    });
  });

  test("deletes a saved draft when the prompt is cleared before cancel", async () => {
    const projectId = "draft-cleared-on-cancel-project";
    const props = {
      onOpenChange: () => {},
      onCreate: mock(async () => {}),
      projectId,
    };
    const firstRender = render(<CreateEnvironmentDialog open={true} {...props} />);
    fireEvent.change(screen.getByLabelText(/Initial Prompt/i), {
      target: { value: "Remove this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    firstRender.unmount();

    const secondRender = render(<CreateEnvironmentDialog open={true} {...props} />);
    await waitFor(() => {
      expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe(
        "Remove this draft",
      );
    });
    fireEvent.change(screen.getByLabelText(/Initial Prompt/i), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    secondRender.unmount();

    render(<CreateEnvironmentDialog open={true} {...props} />);
    expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe("");
  });

  test("clears a saved draft after successful environment creation", async () => {
    const projectId = "draft-success-project";
    const props = {
      onOpenChange: mock(() => {}),
      onCreate: mock(async () => {}),
      projectId,
    };
    const firstRender = render(<CreateEnvironmentDialog open={true} {...props} />);
    fireEvent.change(screen.getByLabelText(/Initial Prompt/i), {
      target: { value: "Saved until creation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    firstRender.unmount();

    const secondRender = render(<CreateEnvironmentDialog open={true} {...props} />);
    await waitFor(() => {
      expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe(
        "Saved until creation",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalled());
    secondRender.unmount();

    render(<CreateEnvironmentDialog open={true} {...props} />);
    expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe("");
  });

  test("submits the selected restricted network mode", async () => {
    const onCreate = mock(async () => {});
    render(<CreateEnvironmentDialog open={true} onOpenChange={() => {}} onCreate={onCreate} />);

    fireEvent.click(screen.getByRole("button", { name: "Restricted" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ networkAccessMode: "restricted" }),
      );
    });
  });

  test("submits on plain Enter but not modified Enter in the prompt", async () => {
    const onCreate = mock(async () => {});
    render(<CreateEnvironmentDialog open={true} onOpenChange={() => {}} onCreate={onCreate} />);
    const prompt = screen.getByLabelText(/Initial Prompt/i);

    for (const modifier of ["shiftKey", "metaKey", "ctrlKey", "altKey"] as const) {
      fireEvent.keyDown(prompt, { key: "Enter", [modifier]: true });
    }
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.keyDown(prompt, { key: "Enter" });
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });

  test("disables form actions and controls while environment creation is loading", () => {
    const onCreate = mock(async () => {});
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={onCreate}
        isLoading={true}
      />,
    );

    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Create Environment" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /Containerized/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("switch", { name: "Launch Agent" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  test("submits codex terminal mode from the dialog", async () => {
    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          agentSettings: {
            defaultAgent: "claude",
            platforms: {
              opencode: { model: "opencode/grok-code", mode: "terminal" },
              codex: { model: "gpt-5.3-codex", reasoningEffort: "medium", mode: "native" },
              claude: { mode: "terminal" },
            },
          },
          terminalAppearance: {
            fontFamily: "Fira Code",
            fontSize: 14,
            backgroundColor: "#000000",
          },
          terminalScrollback: 5000,
        },
        repositories: {},
      },
      isLoading: false,
      error: null,
    });

    const onCreate = mock(async () => {});

    render(<CreateEnvironmentDialog open={true} onOpenChange={() => {}} onCreate={onCreate} />);

    await selectAgentPlatform("Codex");
    fireEvent.click(screen.getByRole("checkbox", { name: "Use TUI" }));
    fireEvent.change(screen.getByLabelText(/Initial Prompt/i), {
      target: { value: "Review the migration plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "codex",
          codexMode: "terminal",
          initialPrompt: "Review the migration plan",
        }),
      );
    });
  });

  test("submits the selected model and reasoning effort", async () => {
    const onCreate = mock(async () => {});
    render(<CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    await selectAgentPlatform("Codex");
    await selectAgentModel(/GPT-5\.4-Mini/);
    await selectReasoning("High");
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "codex",
          model: "gpt-5.4-mini",
          reasoningEffort: "high",
        }),
      );
    });
  });

  test("starts a new project's environment on the configured New projects default", async () => {
    useCodexStore.setState({
      models: [
        {
          id: "codex-a",
          name: "Codex A",
          description: "First",
          reasoningEfforts: ["medium", "high"],
        },
        {
          id: "codex-b",
          name: "Codex B",
          description: "Second",
          reasoningEfforts: ["medium", "high"],
        },
      ],
    });
    const config = structuredClone(defaultConfig);
    // Deliberately different from the New projects default, so the assertion
    // distinguishes the two rather than passing on the app default agent.
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "claude" };
    config.global.enabledAgentPlatforms = ["claude", "codex"];
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, model: "codex-a" },
      },
    };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, reasoningEffort: "medium" },
      },
    };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      actionDefaults: {
        newProject: { platform: "codex", model: "codex-b", reasoningEffort: "high" },
      },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(<CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Codex B"));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "codex",
          model: "codex-b",
          reasoningEffort: "high",
        }),
      ),
    );
  });

  test("takes agent, model, and reasoning from New projects defaults, not the last agent used", async () => {
    useCodexStore.setState({
      models: [
        {
          id: "codex-a",
          name: "Codex A",
          description: "First",
          reasoningEfforts: ["medium", "high"],
        },
        {
          id: "codex-b",
          name: "Codex B",
          description: "Second",
          reasoningEfforts: ["medium", "high"],
        },
      ],
    });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "claude" };
    config.global.enabledAgentPlatforms = ["claude", "codex", "pi"];
    config.global.agentSettings = {
      ...config.global.agentSettings,
      actionDefaults: {
        newProject: { platform: "codex", model: "codex-b", reasoningEffort: "high" },
      },
    };
    config.repositories["project-1"] = {
      defaultBranch: "main",
      prBaseBranch: "main",
      // Legacy state from an earlier create must not override Settings.
      lastEnvironmentAgentSelection: {
        platform: "pi",
        mode: "native",
      },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open
        projectId="project-1"
        onOpenChange={() => {}}
        onCreate={onCreate}
      />,
    );

    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Codex B"));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "codex",
          model: "codex-b",
          reasoningEffort: "high",
        }),
      ),
    );
  });

  // The agent/model/reasoning case above deliberately parks the legacy platform
  // somewhere the dialog never renders, so it cannot see a mode regression. This
  // one puts the legacy platform in the selected column with the *opposite* mode
  // to Settings, which is the only arrangement where a reinstated
  // `withRememberedMode` would still be observable.
  test("takes the mode from Settings even when legacy state names the selected platform", async () => {
    const config = structuredClone(defaultConfig);
    config.global.enabledAgentPlatforms = ["claude", "codex"];
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, mode: "terminal" },
      },
      actionDefaults: { newProject: { platform: "codex" } },
    };
    config.repositories["project-1"] = {
      defaultBranch: "main",
      prBaseBranch: "main",
      lastEnvironmentAgentSelection: { platform: "codex", mode: "native" },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open
        projectId="project-1"
        onOpenChange={() => {}}
        onCreate={onCreate}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Use TUI" }).getAttribute("data-state")).toBe(
        "checked",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: "codex", codexMode: "terminal" }),
      ),
    );
  });

  test("uses a repository New projects action default before the app default", async () => {
    useCodexStore.setState({
      models: [{ id: "repo-codex", name: "Repo Codex", reasoningEfforts: ["high"] }],
    });
    const config = structuredClone(defaultConfig);
    config.global.enabledAgentPlatforms = ["claude", "codex"];
    config.global.agentSettings = {
      defaultAgent: "claude",
      actionDefaults: { newProject: { platform: "claude" } },
    };
    config.repositories["project-1"] = {
      agentSettings: {
        actionDefaults: {
          newProject: { platform: "codex", model: "repo-codex", reasoningEffort: "high" },
        },
      },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open
        projectId="project-1"
        onOpenChange={() => {}}
        onCreate={onCreate}
      />,
    );

    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Repo Codex"));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "codex",
          model: "repo-codex",
          reasoningEffort: "high",
        }),
      ),
    );
  });

  test("ignores a New projects default whose platform is no longer enabled", async () => {
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "claude" };
    config.global.enabledAgentPlatforms = ["claude"];
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        claude: { ...config.global.agentSettings?.platforms?.claude, model: "claude-sonnet-5" },
      },
    };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      actionDefaults: {
        newProject: { platform: "codex", model: "codex-b", reasoningEffort: "high" },
      },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(<CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    // The default is dropped whole rather than contributing its model, so the
    // dialog opens on the app default agent and that agent's configured model.
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "claude",
          model: "sonnet",
        }),
      ),
    );
  });

  test("offers the durable Cursor catalogue when creating a new environment", async () => {
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = {
      ...config.global.agentSettings,
      defaultAgent: "cursor",
      platforms: {
        ...config.global.agentSettings?.platforms,
        cursor: { mode: "terminal" },
      },
    };
    config.global.enabledAgentPlatforms = ["cursor"];
    useConfigStore.setState({ config });
    useAgentModelCatalogStore.getState().setAcpModels([
      {
        platform: "cursor",
        id: "grok-4.6",
        label: "Cursor Grok 4.6",
        providerLabel: "Cursor",
        reasoning: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
      {
        platform: "cursor",
        id: "composer-2.5",
        label: "Composer 2.5",
        providerLabel: "Cursor",
      },
    ]);
    const onCreate = mock(async () => {});

    render(<CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Cursor Grok 4.6"));
    expect(screen.getByRole("checkbox", { name: "Use TUI" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Use TUI" }));
    openAgentModelPicker();
    expect(screen.getByRole("menuitemradio", { name: /Cursor Grok 4\.6/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /Composer 2\.5/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "cursor",
          cursorMode: "native",
          model: "grok-4.6",
          reasoningEffort: "high",
        }),
      );
    });
  });

  test("seeds the Pi catalogue before creating the first environment", async () => {
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = {
      ...config.global.agentSettings,
      defaultAgent: "pi",
      platforms: {
        ...config.global.agentSettings?.platforms,
        pi: { mode: "native" },
      },
    };
    config.global.enabledAgentPlatforms = ["pi"];
    useConfigStore.setState({ config });
    invokeMock.mockImplementation((command: string) => {
      if (command === "ensure_host_pi_model_catalog") {
        return Promise.resolve([
          {
            platform: "pi",
            id: "openai-codex/gpt-5.4",
            label: "GPT-5.4",
            providerLabel: "OpenAI Codex",
            reasoning: [{ id: "high", label: "High" }],
            defaultReasoningId: "high",
            supportsSpeed: false,
            supportsMode: false,
          },
        ]);
      }
      if (command === "get_opencode_model_catalog_cache") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });

    render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
    );

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(([command]) => command === "ensure_host_pi_model_catalog"),
      ).toBe(true),
    );
    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("GPT-5.4"));
    expect(useAgentModelCatalogStore.getState().piModels.map((model) => model.id)).toEqual([
      "openai-codex/gpt-5.4",
    ]);
    // Seeding spawns a real bridge on the backend, so one attempt per opening
    // is the budget: a re-render must not buy another.
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "ensure_host_pi_model_catalog"),
    ).toHaveLength(1);
  });

  test("does not seed the Pi catalogue when Pi is not an enabled platform", async () => {
    const config = structuredClone(defaultConfig);
    config.global.enabledAgentPlatforms = ["claude", "codex"];
    useConfigStore.setState({ config });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_catalog_cache") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });

    render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
    );

    await waitFor(() => expect(getAgentModelPicker()).toBeTruthy());
    // Seeding spawns a real bridge, so a platform the user has turned off must
    // not pay for it every time the dialog opens.
    expect(
      invokeMock.mock.calls.some(([command]) => command === "ensure_host_pi_model_catalog"),
    ).toBe(false);
  });

  test("retries the Pi seed the next time the dialog is opened", async () => {
    const config = structuredClone(defaultConfig);
    config.global.enabledAgentPlatforms = ["pi"];
    useConfigStore.setState({ config });
    // A failed probe leaves the picker on its fallback rather than breaking the
    // dialog, and the attempt is not held against the next opening.
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      invokeMock.mockImplementation((command: string) => {
        if (command === "ensure_host_pi_model_catalog") {
          return Promise.reject(new Error("pi bridge entrypoint not found"));
        }
        if (command === "get_opencode_model_catalog_cache") return Promise.resolve(null);
        return Promise.resolve(undefined);
      });

      const { rerender } = render(
        <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
      );

      await waitFor(() =>
        expect(
          invokeMock.mock.calls.filter(([command]) => command === "ensure_host_pi_model_catalog"),
        ).toHaveLength(1),
      );
      expect(useAgentModelCatalogStore.getState().piModels).toEqual([]);

      rerender(
        <CreateEnvironmentDialog
          open={false}
          onOpenChange={() => {}}
          onCreate={mock(async () => {})}
        />,
      );
      rerender(
        <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
      );

      await waitFor(() =>
        expect(
          invokeMock.mock.calls.filter(([command]) => command === "ensure_host_pi_model_catalog"),
        ).toHaveLength(2),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("keeps a still-supported effort when switching models within one agent", async () => {
    // The cross-agent branch re-derives the effort from the target agent's
    // defaults. The same-agent branch must instead keep what the user chose,
    // which only shows up when the new model still supports it.
    useCodexStore.setState({
      models: [
        {
          id: "codex-a",
          name: "Codex A",
          description: "First",
          reasoningEfforts: ["medium", "high"],
        },
        {
          id: "codex-b",
          name: "Codex B",
          description: "Second",
          reasoningEfforts: ["medium", "high"],
        },
      ],
    });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "codex" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, model: "codex-a" },
      },
    };
    // Deliberately different from the effort the user picks below, so falling
    // back to the agent's configured default is distinguishable from keeping
    // the user's choice.
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, reasoningEffort: "medium" },
      },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(<CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    expect(getAgentModelPicker().textContent).toContain("Codex A");
    expect(getAgentModelPicker().textContent).toContain("Medium");

    await selectReasoning("High");
    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("High"));

    await selectAgentModel(/Codex B/);

    await waitFor(() => {
      expect(getAgentModelPicker().textContent).toContain("Codex B");
      expect(getAgentModelPicker().textContent).toContain("High");
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "codex",
          model: "codex-b",
          reasoningEffort: "high",
        }),
      );
    });
  });

  test("keeps the chosen model when the already-selected agent is picked again", async () => {
    // Selecting a platform resets that agent's model to its configured default.
    // Re-selecting the agent already in use is not a change and must not throw
    // away a model the user picked after opening the dialog.
    useCodexStore.setState({
      models: [
        {
          id: "codex-a",
          name: "Codex A",
          description: "First",
          reasoningEfforts: [],
        },
        {
          id: "codex-b",
          name: "Codex B",
          description: "Second",
          reasoningEfforts: [],
        },
      ],
    });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "codex" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, model: "codex-a" },
      },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(<CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    await selectAgentModel(/Codex B/);
    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Codex B"));

    await selectAgentPlatform("Codex");

    expect(getAgentModelPicker().textContent).toContain("Codex B");
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: "codex", model: "codex-b" }),
      );
    });
  });

  test("submits the synthetic OpenCode default as no explicit model", async () => {
    // With no cached OpenCode catalog the model select only offers the
    // synthetic `{ id: "default" }` placeholder. Submitting that id would pin a
    // model no OpenCode server knows and — because a one-shot launch option is
    // treated as authoritative downstream — suppress the user's own saved
    // OpenCode preferences. It has to submit as "no explicit choice".
    useOpenCodeStore.setState({ models: new Map() });
    // No configured default either, so nothing real gets injected into the
    // catalog and the placeholder is genuinely all there is.
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});
    render(<CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    await selectAgentPlatform("OpenCode");
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: "opencode", model: undefined }),
      );
    });
  });

  test("keeps Claude's real 'default' model id, which is not a placeholder", async () => {
    // The mirror of the test above: `CLAUDE_FALLBACK_MODELS` genuinely contains
    // an id of "default", so it must keep flowing through untouched.
    useClaudeStore.setState({ models: [] });
    const onCreate = mock(async () => {});
    render(<CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    await selectAgentPlatform("Claude");
    await selectAgentModel(/Default \(recommended\)/);
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: "claude", model: "default" }),
      );
    });
  });

  test("submits an unset reasoning effort as undefined", async () => {
    const onCreate = mock(async () => {});
    render(<CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    await selectAgentPlatform("Codex");
    await selectReasoning("Default");
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: "codex", reasoningEffort: undefined }),
      );
    });
  });

  test("omits reasoning choices when the selected model supports none", async () => {
    useOpenCodeStore.setState({ models: new Map() });
    render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
    );

    await selectAgentPlatform("OpenCode");
    expect(getAgentModelPicker().hasAttribute("disabled")).toBe(false);
    openAgentModelPicker();
    expect(screen.queryByRole("group", { name: "Reasoning" }) === null).toBe(true);
    expect(screen.getByPlaceholderText("Search models...")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(getAgentModelPicker().getAttribute("aria-expanded")).toBe("false"));
  });

  test("honors project mode defaults in the checkbox and submission", async () => {
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "claude" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        claude: { ...config.global.agentSettings?.platforms?.claude, mode: "terminal" },
      },
    };
    config.repositories["project-mode"] = {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: { platforms: { claude: { mode: "native" } } },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        projectId="project-mode"
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Use TUI" }).getAttribute("data-state")).toBe(
      "unchecked",
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: "claude", claudeMode: "native" }),
      ),
    );
  });

  test("falls back to the global Codex effort when the project has no override", async () => {
    useCodexStore.setState({
      models: [
        {
          id: "codex-preferred",
          name: "Codex Preferred",
          description: "Preferred",
          reasoningEfforts: ["medium", "high"],
        },
      ],
    });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "codex" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, model: "codex-preferred" },
      },
    };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, reasoningEffort: "high" },
      },
    };
    config.repositories["project-codex"] = {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: { defaultAgent: "codex", platforms: { codex: { model: "codex-preferred" } } },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        projectId="project-codex"
      />,
    );

    expect(getAgentModelPicker().textContent).toContain("High");
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "codex",
          model: "codex-preferred",
          reasoningEffort: "high",
        }),
      ),
    );
  });

  test("prefers a project effort and drops an unsupported configured effort", async () => {
    useCodexStore.setState({
      models: [
        {
          id: "codex-medium-only",
          name: "Codex Medium",
          description: "Medium only",
          reasoningEfforts: ["medium"],
        },
      ],
    });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "codex" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, model: "codex-medium-only" },
      },
    };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, reasoningEffort: "high" },
      },
    };
    config.repositories["project-codex"] = {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: {
        defaultAgent: "codex",
        platforms: { codex: { model: "codex-medium-only", reasoningEffort: "medium" } },
      },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    const { unmount } = render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        projectId="project-codex"
      />,
    );
    expect(getAgentModelPicker().textContent).toContain("Medium");

    unmount();
    // "high" is not in this model's catalogue, so the picker must drop it
    // rather than showing an effort the model cannot accept.
    config.repositories["project-codex"]!.agentSettings = {
      ...config.repositories["project-codex"]!.agentSettings,
      platforms: { codex: { model: "codex-medium-only", reasoningEffort: "high" } },
    };
    useConfigStore.setState({ config: structuredClone(config) });
    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        projectId="project-codex"
      />,
    );
    expect(getAgentModelPicker().textContent).toContain("Default");
  });

  test("offers live OpenCode models and a configured project variant", async () => {
    useOpenCodeStore.getState().setModels("existing-env", [
      {
        id: "provider/model-a",
        name: "Model A",
        provider: "Provider",
        variants: ["fast"],
      },
      {
        id: "provider/model-b",
        name: "Model B",
        provider: "Provider",
        variants: ["deep"],
      },
    ]);
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "opencode" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: {
          ...config.global.agentSettings?.platforms?.opencode,
          model: "provider/model-a",
        },
      },
    };
    config.repositories["project-opencode"] = {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: {
        defaultAgent: "opencode",
        platforms: { opencode: { model: "provider/model-b", reasoningEffort: "deep" } },
      },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        projectId="project-opencode"
      />,
    );

    expect(getAgentModelPicker().textContent).toContain("Model B");
    expect(getAgentModelPicker().textContent).toContain("Deep");
    fireEvent.pointerDown(getAgentModelPicker(), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("button", { name: "opencode models" }));
    expect(await screen.findByRole("menuitemradio", { name: /Model A/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Model B/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "opencode",
          model: "provider/model-b",
          reasoningEffort: "deep",
        }),
      ),
    );
  });

  test("loads the project-scoped durable OpenCode catalog, switches models, resets an incompatible effort, and submits", async () => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "opencode" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    config.repositories["durable-project"] = {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: {
        defaultAgent: "opencode",
        platforms: { opencode: { model: "provider/model-a", reasoningEffort: "fast" } },
      },
    };
    useConfigStore.setState({ config });
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_opencode_model_catalog_cache") {
        expect(args).toEqual({ projectId: "durable-project" });
        return Promise.resolve({
          schemaVersion: 2,
          projectId: "durable-project",
          catalogVersion: "catalog-v1",
          updatedAt: "2026-07-27T12:00:00.000Z",
          models: [
            {
              id: "provider/model-a",
              name: "Durable Model A",
              provider: "Provider",
              variants: ["fast"],
            },
            {
              id: "provider/model-b",
              name: "Durable Model B",
              provider: "Provider",
              variants: ["deep"],
            },
          ],
        });
      }
      if (command === "get_opencode_model_preferences") {
        return Promise.resolve({ recent: [], favorite: [], variant: {} });
      }
      return Promise.resolve(undefined);
    });
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        projectId="durable-project"
      />,
    );

    await waitFor(() => {
      expect(getAgentModelPicker().textContent).toContain("Durable Model A");
      expect(getAgentModelPicker().textContent).toContain("Fast");
    });

    fireEvent.pointerDown(getAgentModelPicker(), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("button", { name: "opencode models" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Durable Model B/ }));
    expect(getAgentModelPicker().textContent).toContain("Durable Model B");
    expect(getAgentModelPicker().textContent).toContain("Default");

    await selectReasoning("Deep");
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "opencode",
          model: "provider/model-b",
          reasoningEffort: "deep",
        }),
      );
    });
  });

  test("shows Orkestrator-owned OpenCode favorites in their configured order", async () => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    config.global.favoriteModels = [
      { platform: "opencode", modelId: "provider/model-b" },
      { platform: "opencode", modelId: "provider/model-a" },
    ];
    useConfigStore.setState({ config });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_catalog_cache") {
        return Promise.resolve({
          schemaVersion: 2,
          projectId: "favorite-project",
          catalogVersion: "catalog-v1",
          updatedAt: "2026-07-27T12:00:00.000Z",
          models: [
            { id: "provider/model-a", name: "Model A", provider: "Provider" },
            { id: "provider/model-b", name: "Model B", provider: "Provider" },
            { id: "provider/model-c", name: "Model C", provider: "Provider" },
          ],
        });
      }
      return Promise.resolve(undefined);
    });

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
        projectId="favorite-project"
      />,
    );
    await selectAgentPlatform("OpenCode");
    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Model A"));
    fireEvent.pointerDown(getAgentModelPicker(), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Favorite models" }));

    const options = await screen.findAllByRole("menuitemradio");
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain("Model B");
    expect(options[1]?.textContent).toContain("Model A");
  });

  test("preserves the target agent effort when selecting a cross-platform favorite", async () => {
    useOpenCodeStore.setState({
      models: new Map([
        [
          "existing-env",
          [
            {
              id: "provider/source",
              name: "OpenCode Source",
              provider: "Provider",
              variants: ["deep"],
            },
          ],
        ],
      ]),
    });
    useCodexStore.setState({
      models: [
        {
          id: "codex-favorite",
          name: "Codex Favorite",
          description: "Favorite",
          reasoningEfforts: ["high"],
        },
      ],
    });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "opencode" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: "provider/source" },
      },
    };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, model: "codex-favorite" },
      },
    };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, reasoningEffort: "high" },
      },
    };
    config.global.favoriteModels = [{ platform: "codex", modelId: "codex-favorite" }];
    config.repositories["cross-platform"] = {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: {
        defaultAgent: "opencode",
        platforms: { opencode: { model: "provider/source", reasoningEffort: "deep" } },
      },
    };
    useConfigStore.setState({ config });
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        projectId="cross-platform"
      />,
    );

    expect(getAgentModelPicker().textContent).toContain("OpenCode Source");
    expect(getAgentModelPicker().textContent).toContain("Deep");
    openAgentModelPicker();
    fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Codex Favorite/ }));

    await waitFor(() => {
      expect(getAgentModelPicker().textContent).toContain("Codex Favorite");
      expect(getAgentModelPicker().textContent).toContain("High");
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "codex",
          model: "codex-favorite",
          reasoningEffort: "high",
        }),
      );
    });
  });

  test("prefers a live OpenCode catalog over the durable project cache", async () => {
    useOpenCodeStore.setState({
      models: new Map([
        [
          "live-environment",
          [
            {
              id: "live/model",
              name: "Live Model",
              provider: "Live Provider",
              variants: ["live"],
            },
          ],
        ],
      ]),
    });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    useConfigStore.setState({ config });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_catalog_cache") {
        return Promise.resolve({
          schemaVersion: 2,
          projectId: "live-project",
          catalogVersion: "stale",
          updatedAt: "2026-07-27T12:00:00.000Z",
          models: [
            {
              id: "cached/model",
              name: "Cached Model",
              provider: "Cached Provider",
            },
          ],
        });
      }
      if (command === "get_opencode_model_preferences") {
        return Promise.resolve({ recent: [], favorite: [], variant: {} });
      }
      return Promise.resolve(undefined);
    });

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
        projectId="live-project"
      />,
    );
    await selectAgentPlatform("OpenCode");
    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Live Model"));
    openAgentModelPicker();
    expect(await screen.findByRole("menuitemradio", { name: /Live Model/ })).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: /Cached Model/ }) === null).toBe(true);
  });

  test("does not read an unscoped durable catalog without a project id", async () => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    useConfigStore.setState({ config });

    render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
    );
    await selectAgentPlatform("OpenCode");
    expect(invokeMock).not.toHaveBeenCalledWith("get_opencode_model_preferences");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "get_opencode_model_catalog_cache",
      expect.anything(),
    );
  });

  test("ignores a late cache response after the project changes", async () => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    useConfigStore.setState({ config });
    const projectA = deferred<Record<string, unknown>>();
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_opencode_model_catalog_cache") {
        if (args?.projectId === "project-a") return projectA.promise;
        return Promise.resolve({
          schemaVersion: 2,
          projectId: "project-b",
          catalogVersion: "b",
          updatedAt: "2026-07-27T12:00:00.000Z",
          models: [
            {
              id: "provider/model-b",
              name: "Project B Model",
              provider: "Provider",
            },
          ],
        });
      }
      if (command === "get_opencode_model_preferences") {
        return Promise.resolve({ recent: [], favorite: [], variant: {} });
      }
      return Promise.resolve(undefined);
    });
    const props = {
      open: true,
      onOpenChange: () => {},
      onCreate: mock(async () => {}),
    };
    const { rerender } = render(<CreateEnvironmentDialog {...props} projectId="project-a" />);
    await selectAgentPlatform("OpenCode");
    rerender(<CreateEnvironmentDialog {...props} projectId="project-b" />);
    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Project B Model"));

    await act(async () => {
      projectA.resolve({
        schemaVersion: 2,
        projectId: "project-a",
        catalogVersion: "a",
        updatedAt: "2026-07-27T12:00:00.000Z",
        models: [
          {
            id: "provider/model-a",
            name: "Project A Model",
            provider: "Provider",
          },
        ],
      });
      await projectA.promise;
    });
    expect(getAgentModelPicker().textContent).toContain("Project B Model");
  });

  test("clears a previous durable catalog when a repeated open returns empty", async () => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    useConfigStore.setState({ config });
    let cacheRead = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_catalog_cache") {
        cacheRead += 1;
        return Promise.resolve(
          cacheRead === 1
            ? {
                schemaVersion: 2,
                projectId: "repeat-project",
                catalogVersion: "first",
                updatedAt: "2026-07-27T12:00:00.000Z",
                models: [
                  {
                    id: "provider/old-model",
                    name: "Old Cached Model",
                    provider: "Provider",
                  },
                ],
              }
            : null,
        );
      }
      if (command === "get_opencode_model_preferences") {
        return Promise.resolve({ recent: [], favorite: [], variant: {} });
      }
      return Promise.resolve(undefined);
    });
    const props = {
      onOpenChange: () => {},
      onCreate: mock(async () => {}),
      projectId: "repeat-project",
    };
    const { rerender } = render(<CreateEnvironmentDialog open {...props} />);
    await selectAgentPlatform("OpenCode");
    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Old Cached Model"));

    rerender(<CreateEnvironmentDialog open={false} {...props} />);
    rerender(<CreateEnvironmentDialog open {...props} />);
    await waitFor(() =>
      expect(getAgentModelPicker().textContent).not.toContain("Old Cached Model"),
    );
  });

  test.each([
    {
      name: "rejected",
      cacheResult: () => Promise.reject(new Error("cache unavailable")),
    },
    {
      name: "invalid",
      cacheResult: () =>
        Promise.resolve({
          schemaVersion: 2,
          projectId: "another-project",
          models: [
            {
              id: "provider/wrong-project",
              name: "Wrong Project Model",
              provider: "Provider",
            },
          ],
        }),
    },
  ])("keeps durable state empty for a $name cache payload", async ({ cacheResult }) => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    useConfigStore.setState({ config });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_catalog_cache") return cacheResult();
      if (command === "get_opencode_model_preferences") {
        return Promise.resolve({ recent: [], favorite: [], variant: {} });
      }
      return Promise.resolve(undefined);
    });

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
        projectId="current-project"
      />,
    );
    await selectAgentPlatform("OpenCode");
    await waitFor(() =>
      expect(getAgentModelPicker().textContent).not.toContain("Wrong Project Model"),
    );
    expect(invokeMock).toHaveBeenCalledWith("get_opencode_model_catalog_cache", {
      projectId: "current-project",
    });
  });

  test("augments the durable catalog with a missing configured OpenCode model and effort", async () => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "opencode" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    config.repositories["configured-project"] = {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: {
        defaultAgent: "opencode",
        platforms: { opencode: { model: "configured/missing-model", reasoningEffort: "turbo" } },
      },
    };
    useConfigStore.setState({ config });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_catalog_cache") {
        return Promise.resolve({
          schemaVersion: 2,
          projectId: "configured-project",
          catalogVersion: "catalog-v1",
          updatedAt: "2026-07-27T12:00:00.000Z",
          models: [
            {
              id: "provider/cached-model",
              name: "Cached Model",
              provider: "Provider",
              variants: ["normal"],
            },
          ],
        });
      }
      if (command === "get_opencode_model_preferences") {
        return Promise.resolve({ recent: [], favorite: [], variant: {} });
      }
      return Promise.resolve(undefined);
    });
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        projectId="configured-project"
      />,
    );
    await waitFor(() => {
      expect(getAgentModelPicker().textContent).toContain("missing-model");
      expect(getAgentModelPicker().textContent).not.toContain("configured/missing-model");
      expect(getAgentModelPicker().textContent).toContain("Turbo");
    });
    openAgentModelPicker();
    const configuredOption = await screen.findByRole("menuitemradio", {
      name: /missing-model/,
    });
    expect(configuredOption).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /Cached Model/ })).toBeTruthy();
    fireEvent.click(configuredOption);
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "configured/missing-model",
          reasoningEffort: "turbo",
        }),
      ),
    );
  });

  test("augments an existing durable OpenCode model with a missing configured effort", async () => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "opencode" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    config.repositories["configured-effort-project"] = {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: {
        defaultAgent: "opencode",
        platforms: { opencode: { model: "provider/configured-model", reasoningEffort: "turbo" } },
      },
    };
    useConfigStore.setState({ config });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_catalog_cache") {
        return Promise.resolve({
          schemaVersion: 2,
          projectId: "configured-effort-project",
          catalogVersion: "catalog-v1",
          updatedAt: "2026-07-27T12:00:00.000Z",
          models: [
            {
              id: "provider/configured-model",
              name: "Configured Model",
              provider: "Provider",
              variants: ["normal"],
            },
          ],
        });
      }
      if (command === "get_opencode_model_preferences") {
        return Promise.resolve({ recent: [], favorite: [], variant: {} });
      }
      return Promise.resolve(undefined);
    });

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
        projectId="configured-effort-project"
      />,
    );

    await waitFor(() => {
      expect(getAgentModelPicker().textContent).toContain("Configured Model");
      expect(getAgentModelPicker().textContent).toContain("Turbo");
    });
  });

  test("keeps the durable catalog usable when loading favorites fails", async () => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "opencode" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    useConfigStore.setState({ config });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_catalog_cache") {
        return Promise.resolve({
          schemaVersion: 2,
          projectId: "prefs-project",
          catalogVersion: "catalog-v1",
          updatedAt: "2026-07-27T12:00:00.000Z",
          models: [
            {
              id: "provider/model-a",
              name: "Durable Model A",
              provider: "Provider",
            },
          ],
        });
      }
      if (command === "get_opencode_model_preferences") {
        return Promise.reject(new Error("preferences unavailable"));
      }
      return Promise.resolve(undefined);
    });

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
        projectId="prefs-project"
      />,
    );

    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Durable Model A"));
    openAgentModelPicker();
    // The catalogue still renders; there is simply no Favorites section.
    expect(await screen.findByRole("menuitemradio", { name: /Durable Model A/ })).toBeTruthy();
    expect(screen.queryByText("Favorites") === null).toBe(true);
  });

  test.each([
    { name: "malformed", preferences: { recent: "recent", favorite: [] } },
    { name: "non-object", preferences: "preferences" },
    { name: "null", preferences: null },
  ])("ignores a $name preferences payload", async ({ preferences }) => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "opencode" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: { ...config.global.agentSettings?.platforms?.opencode, model: undefined },
      },
    };
    useConfigStore.setState({ config });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_catalog_cache") {
        return Promise.resolve({
          schemaVersion: 2,
          projectId: "prefs-project",
          catalogVersion: "catalog-v1",
          updatedAt: "2026-07-27T12:00:00.000Z",
          models: [
            {
              id: "provider/model-a",
              name: "Durable Model A",
              provider: "Provider",
            },
          ],
        });
      }
      if (command === "get_opencode_model_preferences") {
        return Promise.resolve(preferences);
      }
      return Promise.resolve(undefined);
    });

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
        projectId="prefs-project"
      />,
    );

    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Durable Model A"));
    openAgentModelPicker();
    expect(await screen.findByRole("menuitemradio", { name: /Durable Model A/ })).toBeTruthy();
    expect(screen.queryByText("Favorites") === null).toBe(true);
  });

  test("keeps a model chosen before the durable catalog arrives", async () => {
    useOpenCodeStore.setState({ models: new Map() });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "opencode" };
    // A configured default is a real selectable entry before the cache lands,
    // so the user can pick it while the read is still in flight.
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        opencode: {
          ...config.global.agentSettings?.platforms?.opencode,
          model: "provider/configured",
        },
      },
    };
    useConfigStore.setState({ config });
    let resolveCache: (value: unknown) => void = () => {};
    const cacheRead = new Promise((resolve) => {
      resolveCache = resolve;
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_opencode_model_catalog_cache") return cacheRead;
      if (command === "get_opencode_model_preferences") {
        return Promise.resolve({ recent: [], favorite: [], variant: {} });
      }
      return Promise.resolve(undefined);
    });
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        projectId="race-project"
      />,
    );

    await waitFor(() => {
      expect(getAgentModelPicker().textContent).toContain("configured");
      expect(getAgentModelPicker().textContent).not.toContain("provider/configured");
    });

    await act(async () => {
      resolveCache({
        schemaVersion: 2,
        projectId: "race-project",
        catalogVersion: "catalog-v1",
        updatedAt: "2026-07-27T12:00:00.000Z",
        models: [
          { id: "provider/configured", name: "Configured", provider: "Provider" },
          { id: "provider/other", name: "Other", provider: "Provider" },
        ],
      });
      await cacheRead;
    });

    // Still valid in the arriving catalogue, so the choice survives — now
    // rendered with the catalogue's friendly name rather than the raw id.
    await waitFor(() => expect(getAgentModelPicker().textContent).toContain("Configured"));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: "provider/configured" }),
      ),
    );
  });

  test("resets effort for an incompatible model and reconciles a refreshed catalog", async () => {
    useCodexStore.setState({
      models: [
        {
          id: "codex-high",
          name: "Codex High",
          description: "High",
          reasoningEfforts: ["high"],
        },
        {
          id: "codex-low",
          name: "Codex Low",
          description: "Low",
          reasoningEfforts: ["low"],
        },
      ],
    });
    const config = structuredClone(defaultConfig);
    config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "codex" };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, model: "codex-high" },
      },
    };
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: { ...config.global.agentSettings?.platforms?.codex, reasoningEffort: "high" },
      },
    };
    useConfigStore.setState({ config });

    render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
    );

    await selectAgentModel(/Codex Low/);
    expect(getAgentModelPicker().textContent).toContain("Default");

    await act(async () => {
      useCodexStore.setState({
        models: [
          {
            id: "codex-refreshed",
            name: "Codex Refreshed",
            description: "Refreshed",
            reasoningEfforts: ["medium"],
          },
        ],
      });
    });
    await waitFor(() => {
      expect(getAgentModelPicker().textContent).toContain("Codex Refreshed");
      expect(getAgentModelPicker().textContent).toContain("Default");
    });
  });

  test.each([
    {
      agentLabel: "Claude",
      agentType: "claude",
      selectedMode: "Native",
      expectedField: "claudeMode",
      expectedMode: "native",
    },
    {
      agentLabel: "Claude",
      agentType: "claude",
      selectedMode: "Terminal",
      expectedField: "claudeMode",
      expectedMode: "terminal",
    },
    {
      agentLabel: "OpenCode",
      agentType: "opencode",
      selectedMode: "Native",
      expectedField: "opencodeMode",
      expectedMode: "native",
    },
    {
      agentLabel: "OpenCode",
      agentType: "opencode",
      selectedMode: "Terminal",
      expectedField: "opencodeMode",
      expectedMode: "terminal",
    },
    {
      agentLabel: "Codex",
      agentType: "codex",
      selectedMode: "Native",
      expectedField: "codexMode",
      expectedMode: "native",
    },
  ] as const)(
    "submits $agentLabel $selectedMode mode from the dialog",
    async ({ agentLabel, agentType, selectedMode, expectedField, expectedMode }) => {
      const onCreate = mock(async () => {});
      render(<CreateEnvironmentDialog open={true} onOpenChange={() => {}} onCreate={onCreate} />);

      await selectAgentPlatform(agentLabel);
      const useTui = screen.getByRole("checkbox", { name: "Use TUI" });
      const isTerminal = useTui.getAttribute("data-state") === "checked";
      if ((selectedMode === "Terminal") !== isTerminal) {
        fireEvent.click(screen.getByRole("checkbox", { name: "Use TUI" }));
      }
      fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            agentType,
            [expectedField]: expectedMode,
          }),
        );
      });
    },
  );

  test("submits a trimmed environment name without launching an agent", async () => {
    const onCreate = mock(async () => {});
    render(<CreateEnvironmentDialog open={true} onOpenChange={() => {}} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText(/Environment Name/i), {
      target: { value: "  local-review  " },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Launch Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentName: "local-review",
          launchAgent: false,
          initialPrompt: "",
          initialPromptAttachments: [],
        }),
      );
    });
  });

  test("defaults to the project's last created environment type", async () => {
    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          agentSettings: {
            defaultAgent: "claude",
            platforms: {
              opencode: { model: "opencode/grok-code", mode: "terminal" },
              codex: { model: "gpt-5.3-codex", reasoningEffort: "medium", mode: "native" },
              claude: { mode: "terminal" },
            },
          },
          terminalAppearance: {
            fontFamily: "Fira Code",
            fontSize: 14,
            backgroundColor: "#000000",
          },
          terminalScrollback: 5000,
        },
        repositories: {
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            lastEnvironmentType: "local",
          },
        },
      },
      isLoading: false,
      error: null,
    });

    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={onCreate}
        projectId="project-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentType: "local",
        }),
      );
    });
  });

  test("resets environment type to the saved project default when reopened", async () => {
    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          agentSettings: {
            defaultAgent: "claude",
            platforms: {
              opencode: { model: "opencode/grok-code", mode: "terminal" },
              codex: { model: "gpt-5.3-codex", reasoningEffort: "medium", mode: "native" },
              claude: { mode: "terminal" },
            },
          },
          terminalAppearance: {
            fontFamily: "Fira Code",
            fontSize: 14,
            backgroundColor: "#000000",
          },
          terminalScrollback: 5000,
        },
        repositories: {
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            lastEnvironmentType: "local",
          },
        },
      },
      isLoading: false,
      error: null,
    });

    const onCreate = mock(async () => {});
    const props = {
      onOpenChange: () => {},
      onCreate,
      projectId: "project-1",
    };

    const { rerender } = render(<CreateEnvironmentDialog open={true} {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /Containerized/ }));

    rerender(<CreateEnvironmentDialog open={false} {...props} />);
    rerender(<CreateEnvironmentDialog open={true} {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentType: "local",
        }),
      );
    });
  });

  test("shows pasted initial prompt image and submits it as an attachment", async () => {
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));

    const onCreate = mock(async () => {});

    render(<CreateEnvironmentDialog open={true} onOpenChange={() => {}} onCreate={onCreate} />);

    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    document.dispatchEvent(pasteEvent);

    await waitFor(() => {
      expect(screen.getByAltText(/initial-prompt-/)).toBeTruthy();
    });
    expect(pasteEvent.defaultPrevented).toBe(true);

    fireEvent.change(prompt, {
      target: { value: "Use this screenshot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          initialPrompt: "Use this screenshot",
          initialPromptAttachments: [
            expect.objectContaining({
              id: expect.stringMatching(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
              ),
              base64Data: "QUJD",
              previewUrl: "data:image/png;base64,QUJD",
              name: expect.stringMatching(/^initial-prompt-.*\.png$/),
            }),
          ],
        }),
      );
    });
  });

  test("uses an image supplied by the browser paste event", async () => {
    const pastedFile = new File(["image"], "browser.png", { type: "image/png" });
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));

    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />,
    );
    screen.getByLabelText(/Initial Prompt/i).focus();
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => pastedFile }],
        files: [],
      },
    });

    document.dispatchEvent(pasteEvent);

    await waitFor(() => {
      expect(mockReadImage).toHaveBeenCalledWith(pastedFile);
      expect(screen.getByAltText(/initial-prompt-/)).toBeTruthy();
    });
    expect(pasteEvent.defaultPrevented).toBe(true);
  });

  test("resizes a wide initial-prompt image before attaching it", async () => {
    const drawImage = mock(() => {});
    const width = 2001;
    const height = 1;
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => rgbaBuffer(width, height),
      size: async () => ({ width, height }),
    }));
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData,
      drawImage,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />,
    );
    screen.getByLabelText(/Initial Prompt/i).focus();

    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(screen.getByAltText(/initial-prompt-/)).toBeTruthy();
    });
    expect(drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ width: 0, height: 0 }),
      0,
      0,
      2000,
      1,
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("downscales an oversized encoded image before attaching it", async () => {
    const width = 100;
    const height = 100;
    const oversizedDataUrl = `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`;
    const drawImage = mock(() => {});
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => rgbaBuffer(width, height),
      size: async () => ({ width, height }),
    }));
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData,
      drawImage,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = function () {
      return this.width === width ? oversizedDataUrl : "data:image/png;base64,QUJD";
    };

    render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
    );
    screen.getByLabelText(/Initial Prompt/i).focus();
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    await waitFor(() => expect(screen.getByAltText(/initial-prompt-/)).toBeTruthy());
    expect(drawImage).toHaveBeenCalled();
    expect((screen.getByAltText(/initial-prompt-/) as HTMLImageElement).src).toBe(
      "data:image/png;base64,QUJD",
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("shows an error when an oversized encoded image cannot be reduced", async () => {
    const width = 100;
    const height = 100;
    const oversizedDataUrl = `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`;
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => rgbaBuffer(width, height),
      size: async () => ({ width, height }),
    }));
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData,
      drawImage: mock(() => {}),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() =>
      oversizedDataUrl) as typeof HTMLCanvasElement.prototype.toDataURL;

    render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
    );
    screen.getByLabelText(/Initial Prompt/i).focus();
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Image too large",
        expect.objectContaining({
          description: expect.stringContaining("could not be resized below the 8MB"),
        }),
      );
    });
    expect(screen.queryByAltText(/initial-prompt-/) === null).toBe(true);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("removes a pasted initial prompt image before submitting", async () => {
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));

    const onCreate = mock(async () => {});

    render(<CreateEnvironmentDialog open={true} onOpenChange={() => {}} onCreate={onCreate} />);

    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();

    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    const removeButton = await screen.findByRole("button", {
      name: /Remove initial-prompt-/,
    });
    fireEvent.click(removeButton);

    await waitFor(() => {
      expect(screen.queryByAltText(/initial-prompt-/) === null).toBe(true);
    });

    fireEvent.change(prompt, {
      target: { value: "Use text only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          initialPrompt: "Use text only",
          initialPromptAttachments: [],
        }),
      );
    });
  });

  test("rejects encoded images above the attachment size boundary", () => {
    const maxBase64Length = Math.floor((8 * 1024 * 1024 * 4) / 3);

    expect(getEncodedImageSizeError(maxBase64Length)).toBeNull();
    expect(getEncodedImageSizeError(maxBase64Length + 2)).toContain("Maximum is 8MB");
  });

  test("leaves paste untouched when a clipboard image cannot get a canvas context", async () => {
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />,
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });

    const wasNotCancelled = document.dispatchEvent(pasteEvent);

    await waitFor(() => expect(mockReadImage).toHaveBeenCalled());
    expect(wasNotCancelled).toBe(true);
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(screen.queryByAltText(/initial-prompt-/) === null).toBe(true);
  });

  test("shows an error and leaves paste untouched when clipboard image encoding is empty", async () => {
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    HTMLCanvasElement.prototype.toDataURL = (() =>
      "data:image/png;base64,") as typeof HTMLCanvasElement.prototype.toDataURL;
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />,
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });

    const wasNotCancelled = document.dispatchEvent(pasteEvent);

    await waitFor(() => expect(mockReadImage).toHaveBeenCalled());
    expect(wasNotCancelled).toBe(true);
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Image too large",
      expect.objectContaining({
        description: expect.stringContaining("could not be resized below the 8MB"),
      }),
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(screen.queryByAltText(/initial-prompt-/) === null).toBe(true);
  });

  test("lets normal paste continue when the clipboard has no image", async () => {
    const onCreate = mock(async () => {});

    render(<CreateEnvironmentDialog open={true} onOpenChange={() => {}} onCreate={onCreate} />);

    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    const wasNotCancelled = document.dispatchEvent(pasteEvent);

    await waitFor(() => {
      expect(mockReadImage).toHaveBeenCalled();
    });
    expect(wasNotCancelled).toBe(true);
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(screen.queryByAltText(/initial-prompt-/) === null).toBe(true);
  });

  test("does not inspect clipboard images when the prompt is unfocused or unavailable", async () => {
    const props = {
      onOpenChange: () => {},
      onCreate: mock(async () => {}),
    };
    const { rerender } = render(<CreateEnvironmentDialog open={true} {...props} />);

    screen.getByLabelText(/Environment Name/i).focus();
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(mockReadImage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("switch", { name: "Launch Agent" }));
    await waitFor(() => {
      expect(screen.queryByLabelText(/Initial Prompt/i) === null).toBe(true);
    });
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(mockReadImage).not.toHaveBeenCalled();

    rerender(<CreateEnvironmentDialog open={false} {...props} />);
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(mockReadImage).not.toHaveBeenCalled();
  });

  test("cancels an in-flight clipboard image when the dialog closes", async () => {
    let resolveImage!: (image: {
      rgba: () => Promise<Uint8Array>;
      size: () => Promise<{ width: number; height: number }>;
    }) => void;
    const rgba = mock(async () => new Uint8Array([255, 0, 0, 255]));
    const size = mock(async () => ({ width: 1, height: 1 }));
    mockReadImage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImage = resolve;
        }),
    );
    const onOpenChange = mock(() => {});
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={onOpenChange}
        onCreate={mock(async () => {})}
      />,
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    document.dispatchEvent(pasteEvent);
    await waitFor(() => expect(mockReadImage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    resolveImage({ rgba, size });
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(rgba).not.toHaveBeenCalled();
    expect(size).not.toHaveBeenCalled();
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("cancels an in-flight clipboard image when the dialog unmounts", async () => {
    let resolveImage!: (image: {
      rgba: () => Promise<Uint8Array>;
      size: () => Promise<{ width: number; height: number }>;
    }) => void;
    const rgba = mock(async () => new Uint8Array([255, 0, 0, 255]));
    const size = mock(async () => ({ width: 1, height: 1 }));
    mockReadImage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImage = resolve;
        }),
    );
    const { unmount } = render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />,
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    document.dispatchEvent(pasteEvent);
    await waitFor(() => expect(mockReadImage).toHaveBeenCalledTimes(1));

    unmount();
    resolveImage({ rgba, size });
    await Promise.resolve();
    await Promise.resolve();

    expect(rgba).not.toHaveBeenCalled();
    expect(size).not.toHaveBeenCalled();
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("cancels an in-flight clipboard image while reading RGBA data", async () => {
    const pendingRgba = deferred<Uint8Array>();
    const rgba = mock(() => pendingRgba.promise);
    const size = mock(async () => ({ width: 1, height: 1 }));
    mockReadImage.mockImplementation(async () => ({ rgba, size }));
    const onOpenChange = mock(() => {});
    render(
      <CreateEnvironmentDialog open onOpenChange={onOpenChange} onCreate={mock(async () => {})} />,
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(rgba).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    pendingRgba.resolve(new Uint8Array([255, 0, 0, 255]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(size).not.toHaveBeenCalled();
    expect(screen.queryByAltText(/initial-prompt-/) === null).toBe(true);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("cancels an in-flight clipboard image while reading its dimensions", async () => {
    const pendingSize = deferred<{ width: number; height: number }>();
    const rgba = mock(async () => new Uint8Array([255, 0, 0, 255]));
    const size = mock(() => pendingSize.promise);
    mockReadImage.mockImplementation(async () => ({ rgba, size }));
    const onOpenChange = mock(() => {});
    render(
      <CreateEnvironmentDialog open onOpenChange={onOpenChange} onCreate={mock(async () => {})} />,
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(size).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    pendingSize.resolve({ width: 1, height: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByAltText(/initial-prompt-/) === null).toBe(true);
    expect(putImageData).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("cancels an in-flight clipboard image when focus leaves the prompt", async () => {
    const pendingImage = deferred<{
      rgba: () => Promise<Uint8Array>;
      size: () => Promise<{ width: number; height: number }>;
    }>();
    const rgba = mock(async () => new Uint8Array([255, 0, 0, 255]));
    const size = mock(async () => ({ width: 1, height: 1 }));
    mockReadImage.mockImplementation(() => pendingImage.promise);
    render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(mockReadImage).toHaveBeenCalledTimes(1));

    screen.getByLabelText(/Environment Name/i).focus();
    pendingImage.resolve({ rgba, size });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rgba).not.toHaveBeenCalled();
    expect(size).not.toHaveBeenCalled();
    expect(screen.queryByAltText(/initial-prompt-/) === null).toBe(true);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("lets a second paste supersede an earlier in-flight clipboard read", async () => {
    const firstImage = deferred<{
      rgba: () => Promise<Uint8Array>;
      size: () => Promise<{ width: number; height: number }>;
    }>();
    const firstRgba = mock(async () => new Uint8Array([255, 0, 0, 255]));
    const firstSize = mock(async () => ({ width: 1, height: 1 }));
    let readCount = 0;
    mockReadImage.mockImplementation(() => {
      readCount += 1;
      if (readCount === 1) return firstImage.promise;
      return Promise.resolve({
        rgba: async () => new Uint8Array([0, 255, 0, 255]),
        size: async () => ({ width: 1, height: 1 }),
      });
    });
    render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={mock(async () => {})} />,
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(mockReadImage).toHaveBeenCalledTimes(1));

    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(screen.getAllByAltText(/initial-prompt-/)).toHaveLength(1));
    firstImage.resolve({ rgba: firstRgba, size: firstSize });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstRgba).not.toHaveBeenCalled();
    expect(firstSize).not.toHaveBeenCalled();
    expect(screen.getAllByAltText(/initial-prompt-/)).toHaveLength(1);
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
  });

  test("adds, validates, updates, and removes port mappings", async () => {
    const onCreate = mock(async () => {});
    render(<CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />);

    fireEvent.click(screen.getByRole("button", { name: /Port Configuration/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add Port Mapping" }));
    const containerPort = screen.getByPlaceholderText("Container");
    const hostPort = screen.getByPlaceholderText("Host");
    fireEvent.change(containerPort, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.change(containerPort, { target: { value: "8080" } });
    fireEvent.change(hostPort, { target: { value: "18080" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          portMappings: [{ containerPort: 8080, hostPort: 18080, protocol: "tcp" }],
        }),
      );
    });

    cleanup();
    onCreate.mockClear();
    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        defaultPortMappings={[{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }]}
      />,
    );
    const trashButton = document.querySelector("svg.lucide-trash-2")?.closest("button");
    expect(trashButton).toBeTruthy();
    fireEvent.click(trashButton!);
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ portMappings: [] }));
    });
  });

  test("submits a UDP port mapping", async () => {
    const onCreate = mock(async () => {});
    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        defaultPortMappings={[{ containerPort: 5353, hostPort: 5353, protocol: "tcp" }]}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Protocol" }));
    const udpOption = await screen.findByRole("option", { name: "UDP" });
    fireEvent.click(udpOption);
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          portMappings: [{ containerPort: 5353, hostPort: 5353, protocol: "udp" }],
        }),
      );
    });
  });

  test("rejects empty and out-of-range ports and accepts both boundaries", async () => {
    const onCreate = mock(async () => {});
    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        defaultPortMappings={[{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }]}
      />,
    );
    const containerPort = screen.getByPlaceholderText("Container");
    const hostPort = screen.getByPlaceholderText("Host");
    const createButton = screen.getByRole("button", {
      name: "Create Environment",
    }) as HTMLButtonElement;

    for (const invalidHostPort of ["", "0", "-1"]) {
      fireEvent.change(hostPort, { target: { value: invalidHostPort } });
      expect(createButton.disabled).toBe(true);
    }
    fireEvent.change(hostPort, { target: { value: "1" } });
    for (const invalidContainerPort of ["", "0", "-1"]) {
      fireEvent.change(containerPort, { target: { value: invalidContainerPort } });
      expect(createButton.disabled).toBe(true);
    }
    fireEvent.change(containerPort, { target: { value: "1" } });
    expect(createButton.disabled).toBe(false);

    fireEvent.change(hostPort, { target: { value: "65536" } });
    expect(createButton.disabled).toBe(true);
    fireEvent.change(hostPort, { target: { value: "65535" } });
    fireEvent.change(containerPort, { target: { value: "65536" } });
    expect(createButton.disabled).toBe(true);
    fireEvent.change(containerPort, { target: { value: "65535" } });
    expect(createButton.disabled).toBe(false);

    fireEvent.click(createButton);
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          portMappings: [{ containerPort: 65535, hostPort: 65535, protocol: "tcp" }],
        }),
      );
    });
  });

  test("rejects invalid ports again at form submission time", () => {
    const onCreate = mock(async () => {});
    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        defaultPortMappings={[{ containerPort: 0, hostPort: 3000, protocol: "tcp" }]}
      />,
    );

    const form = screen.getByRole("dialog").querySelector("form");
    expect(form).toBeTruthy();
    fireEvent.submit(form!);

    expect(onCreate).not.toHaveBeenCalled();
  });

  test("ignores hidden invalid port mappings when creating a local environment", async () => {
    const onCreate = mock(async () => {});
    render(
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        defaultPortMappings={[{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }]}
      />,
    );
    const createButton = screen.getByRole("button", {
      name: "Create Environment",
    }) as HTMLButtonElement;

    fireEvent.change(screen.getByPlaceholderText("Host"), { target: { value: "0" } });
    expect(createButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Local/ }));

    expect(createButton.disabled).toBe(false);
    fireEvent.click(createButton);
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentType: "local",
          portMappings: [],
        }),
      );
    });
  });

  test("keeps the dialog open when environment creation rejects", async () => {
    const onOpenChange = mock(() => {});
    const onCreate = mock(async () => {
      throw new Error("creation failed");
    });
    render(<CreateEnvironmentDialog open onOpenChange={onOpenChange} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("keeps the form intact when a creation preflight defers submission", async () => {
    const onOpenChange = mock(() => {});
    const onCreate = mock(async () => false);
    render(<CreateEnvironmentDialog open onOpenChange={onOpenChange} onCreate={onCreate} />);
    const nameInput = screen.getByLabelText(/Environment Name/i);
    fireEvent.change(nameInput, { target: { value: "Keep this name" } });

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect((nameInput as HTMLInputElement).value).toBe("Keep this name");
  });
});
