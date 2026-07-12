import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { mockReadImage } from "../../mocks/clipboard";
import { resolveAgentDefaults } from "../../../apps/web/src/components/environments/CreateEnvironmentDialog";

const toastSuccessMock = mock(() => {});
const toastErrorMock = mock(() => {});

mock.module("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

const { CreateEnvironmentDialog } = await import("../../../apps/web/src/components/environments/CreateEnvironmentDialog");

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

  test("shows an error and does not attach oversized pasted images", async () => {
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    HTMLCanvasElement.prototype.toDataURL = (() =>
      `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`) as typeof HTMLCanvasElement.prototype.toDataURL;

    render(
      <CreateEnvironmentDialog
        open={true}
        onOpenChange={() => {}}
        onCreate={mock(async () => {})}
      />
    );

    const prompt = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    prompt.focus();

    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Image too large",
        expect.objectContaining({
          description: expect.stringContaining("Maximum is 8MB"),
        }),
      );
    });
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
