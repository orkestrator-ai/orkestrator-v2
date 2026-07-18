import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { mockReadImage } from "../../mocks/clipboard";

const toastSuccessMock = mock(() => {});
const toastErrorMock = mock(() => {});

mock.module("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

const { CreateEnvironmentDialog, getEncodedImageSizeError, resolveAgentDefaults } = await import("../../../apps/web/src/components/environments/CreateEnvironmentDialog");
const defaultConfig = structuredClone(useConfigStore.getState().config);

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

describe("resolveAgentDefaults", () => {
  beforeEach(() => {
    cleanup();
    useConfigStore.setState({
      config: structuredClone(defaultConfig),
      isLoading: false,
      error: null,
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

  test("uses app-level defaults when no repo config provided", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude", claudeMode: "native", opencodeMode: "terminal", codexMode: "native" },
      undefined,
    );
    expect(result.defaultAgent).toBe("claude");
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("terminal");
    expect(result.codexMode).toBe("native");
  });

  test("uses app-level defaults when repo config has no overrides", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "opencode", claudeMode: "terminal", opencodeMode: "native", codexMode: "terminal" },
      { defaultBranch: "main", prBaseBranch: "main" } as { defaultAgent?: string; agentStyle?: string },
    );
    expect(result.defaultAgent).toBe("opencode");
    expect(result.claudeMode).toBe("terminal");
    expect(result.opencodeMode).toBe("native");
    expect(result.codexMode).toBe("terminal");
  });

  test("project-level defaultAgent overrides app-level", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude", claudeMode: "terminal", opencodeMode: "terminal" },
      { defaultAgent: "opencode" },
    );
    expect(result.defaultAgent).toBe("opencode");
  });

  test("project-level agentStyle overrides both claudeMode and opencodeMode", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude", claudeMode: "terminal", opencodeMode: "terminal", codexMode: "native" },
      { agentStyle: "native" },
    );
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("native");
    expect(result.codexMode).toBe("native");
  });

  test("project-level overrides take precedence over app-level for all fields", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude", claudeMode: "terminal", opencodeMode: "terminal", codexMode: "native" },
      { defaultAgent: "codex", agentStyle: "native" },
    );
    expect(result.defaultAgent).toBe("codex");
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("native");
    expect(result.codexMode).toBe("native");
  });

  test("falls back to hardcoded defaults when both levels are undefined", () => {
    const result = resolveAgentDefaults({}, undefined);
    expect(result.defaultAgent).toBe("claude");
    expect(result.claudeMode).toBe("terminal");
    expect(result.opencodeMode).toBe("terminal");
    expect(result.codexMode).toBe("native");
  });

  test("project agentStyle does not affect defaultAgent resolution", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude" },
      { agentStyle: "native" },
    );
    // defaultAgent should still come from app-level
    expect(result.defaultAgent).toBe("claude");
    expect(result.claudeMode).toBe("native");
    expect(result.codexMode).toBe("native");
  });

  test("project defaultAgent does not affect mode resolution", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude", claudeMode: "native", opencodeMode: "native", codexMode: "terminal" },
      { defaultAgent: "opencode" },
    );
    // Modes should still come from app-level since no agentStyle override
    expect(result.defaultAgent).toBe("opencode");
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("native");
    expect(result.codexMode).toBe("terminal");
  });

  test("starts on the prompt tab and preserves values while moving between mobile sections", () => {
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />
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
    expect(screen.getByLabelText(/Initial Prompt/i).closest('[role="tabpanel"]')?.getAttribute("data-state")).toBe("active");

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

    expect((screen.getByLabelText(/Environment Name/i) as HTMLInputElement).value).toBe("mobile-tabs");
    expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe("Keep this task");
  });

  test("sets every mobile panel's animation direction from section order", () => {
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />
    );

    const panels = {
      Prompt: screen.getByLabelText(/Initial Prompt/i).closest('[role="tabpanel"]'),
      Setup: screen.getByLabelText(/Environment Name/i).closest('[role="tabpanel"]'),
      Agent: screen.getByRole("switch", { name: "Launch Agent" }).closest('[role="tabpanel"]'),
      Access: screen.getByRole("button", { name: "Restricted" }).closest('[role="tabpanel"]'),
      Ports: screen.getByRole("button", { name: /Port Configuration/ }).closest('[role="tabpanel"]'),
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
      />
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Setup" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("button", { name: /Local/ }));

    expect(screen.queryByRole("tab", { name: "Access" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Ports" })).toBeNull();
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
        />
      );

      fireEvent.mouseDown(screen.getByRole("tab", { name: tabName }), {
        button: 0,
        ctrlKey: false,
      });
      expect(screen.getByRole("tab", { name: tabName }).getAttribute("aria-selected")).toBe("true");

      fireEvent.click(screen.getByRole("button", { name: /Local/ }));

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Setup" }).getAttribute("aria-selected")).toBe("true");
      });
      expect(
        screen
          .getByLabelText(/Environment Name/i)
          .closest('[role="tabpanel"]')
          ?.getAttribute("data-mobile-transition"),
      ).toBe("backward");
      expect(screen.queryByRole("tab", { name: tabName })).toBeNull();
    },
  );

  test("moves from Prompt to Agent when launching an agent is disabled", async () => {
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />
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
      expect(screen.getByRole("tab", { name: "Prompt" }).getAttribute("aria-selected")).toBe("true");
    });
    expect(
      screen
        .getByLabelText(/Initial Prompt/i)
        .closest('[role="tabpanel"]')
        ?.getAttribute("data-mobile-transition"),
    ).toBeNull();
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
      expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe("Keep this draft");
    });
    expect((screen.getByLabelText(/Environment Name/i) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("switch", { name: "Launch Agent" }).getAttribute("aria-checked")).toBe("true");

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
      expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe("Remove this draft");
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
      expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe("Saved until creation");
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalled());
    secondRender.unmount();

    render(<CreateEnvironmentDialog open={true} {...props} />);
    expect((screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement).value).toBe("");
  });

  test("submits the selected restricted network mode", async () => {
    const onCreate = mock(async () => {});
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={onCreate}
      />
    );

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
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={onCreate}
      />
    );
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
      />
    );

    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create Environment" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Containerized/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "Launch Agent" }) as HTMLButtonElement).disabled).toBe(true);
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
          defaultAgent: "claude",
          opencodeModel: "opencode/grok-code",
          codexModel: "gpt-5.3-codex",
          codexReasoningEffort: "medium",
          opencodeMode: "terminal",
          claudeMode: "terminal",
          codexMode: "native",
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

    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={onCreate}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
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
        })
      );
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
  ] as const)(
    "submits $agentLabel $selectedMode mode from the dialog",
    async ({ agentLabel, agentType, selectedMode, expectedField, expectedMode }) => {
      const onCreate = mock(async () => {});
      render(
        <CreateEnvironmentDialog
          open={true}
          onOpenChange={() => {}}
          onCreate={onCreate}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: agentLabel }));
      fireEvent.click(screen.getByRole("button", { name: "Native" }));
      if (selectedMode === "Terminal") {
        fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
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
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={onCreate}
      />,
    );

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
          defaultAgent: "claude",
          opencodeModel: "opencode/grok-code",
          codexModel: "gpt-5.3-codex",
          codexReasoningEffort: "medium",
          opencodeMode: "terminal",
          claudeMode: "terminal",
          codexMode: "native",
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
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentType: "local",
        })
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
          defaultAgent: "claude",
          opencodeModel: "opencode/grok-code",
          codexModel: "gpt-5.3-codex",
          codexReasoningEffort: "medium",
          opencodeMode: "terminal",
          claudeMode: "terminal",
          codexMode: "native",
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

    const { rerender } = render(
      <CreateEnvironmentDialog
        open={true}
        {...props}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Containerized/ }));

    rerender(
      <CreateEnvironmentDialog
        open={false}
        {...props}
      />
    );
    rerender(
      <CreateEnvironmentDialog
        open={true}
        {...props}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentType: "local",
        })
      );
    });
  });

  test("shows pasted initial prompt image and submits it as an attachment", async () => {
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));

    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={onCreate}
      />
    );

    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();

    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(screen.getByAltText(/initial-prompt-/)).toBeTruthy();
    });

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
              id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
              base64Data: "QUJD",
              previewUrl: "data:image/png;base64,QUJD",
              name: expect.stringMatching(/^initial-prompt-.*\.png$/),
            }),
          ],
        })
      );
    });
  });

  test("removes a pasted initial prompt image before submitting", async () => {
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));

    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={onCreate}
      />
    );

    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();

    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    const removeButton = await screen.findByRole("button", {
      name: /Remove initial-prompt-/,
    });
    fireEvent.click(removeButton);

    await waitFor(() => {
      expect(screen.queryByAltText(/initial-prompt-/)).toBeNull();
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
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });

    const wasNotCancelled = document.dispatchEvent(pasteEvent);

    await waitFor(() => expect(mockReadImage).toHaveBeenCalled());
    expect(wasNotCancelled).toBe(true);
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(screen.queryByAltText(/initial-prompt-/)).toBeNull();
  });

  test("leaves paste untouched when clipboard image encoding is empty", async () => {
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
      />
    );
    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });

    const wasNotCancelled = document.dispatchEvent(pasteEvent);

    await waitFor(() => expect(mockReadImage).toHaveBeenCalled());
    expect(wasNotCancelled).toBe(true);
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(screen.queryByAltText(/initial-prompt-/)).toBeNull();
  });

  test("lets normal paste continue when the clipboard has no image", async () => {
    const onCreate = mock(async () => {});

    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={onCreate}
      />
    );

    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    const wasNotCancelled = document.dispatchEvent(pasteEvent);

    await waitFor(() => {
      expect(mockReadImage).toHaveBeenCalled();
    });
    expect(wasNotCancelled).toBe(true);
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(screen.queryByAltText(/initial-prompt-/)).toBeNull();
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
      expect(screen.queryByLabelText(/Initial Prompt/i)).toBeNull();
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
      () => new Promise((resolve) => {
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
      () => new Promise((resolve) => {
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

  test("adds, validates, updates, and removes port mappings", async () => {
    const onCreate = mock(async () => {});
    render(
      <CreateEnvironmentDialog open onOpenChange={() => {}} onCreate={onCreate} />,
    );

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
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
        portMappings: [{ containerPort: 8080, hostPort: 18080, protocol: "tcp" }],
      }));
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
    const createButton = screen.getByRole("button", { name: "Create Environment" }) as HTMLButtonElement;

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
    const createButton = screen.getByRole("button", { name: "Create Environment" }) as HTMLButtonElement;

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
    render(
      <CreateEnvironmentDialog open onOpenChange={onOpenChange} onCreate={onCreate} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
