import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as realDialog from "@/components/ui/dialog";

const realDialogSnapshot = { ...realDialog };

// The picker lives inside a portalled Radix dialog, which hides everything
// outside it from the accessibility tree — including the dropdown's own portal.
// Rendering the dialog as plain markup keeps both queryable.
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { AgentLaunchDialog, type AgentLaunchSelection } from "./AgentLaunchDialog";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { useConfigStore } from "@/stores/configStore";

afterEach(cleanup);
afterAll(() => {
  mock.module("@/components/ui/dialog", () => realDialogSnapshot);
});
beforeEach(() => {
  const config = useConfigStore.getState().config;
  useConfigStore.setState({
    config: {
      ...config,
      global: {
        ...config.global,
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        favoriteModels: [],
      },
    },
  });
});

const catalog: AgentModelCatalog = {
  claude: [
    { id: "claude-a", name: "Claude A", reasoningEfforts: ["low", "high"] },
    { id: "claude-fixed", name: "Claude Fixed", reasoningEfforts: [] },
  ],
  codex: [{ id: "codex-a", name: "Codex A", reasoningEfforts: ["medium", "high"] }],
  opencode: [{ id: "provider/model-a", name: "OpenCode A", reasoningEfforts: ["fast"] }],
};

function renderDialog(overrides: Partial<Parameters<typeof AgentLaunchDialog>[0]> = {}) {
  const onConfirm = mock((_selection: AgentLaunchSelection) => undefined);
  const props = {
    open: true,
    onOpenChange: () => undefined,
    defaultAgent: "claude" as const,
    catalog,
    enabledAgents: ["claude", "codex", "opencode"] as const satisfies readonly string[],
    targetBranch: "main",
    onConfirm,
    ...overrides,
  } as Parameters<typeof AgentLaunchDialog>[0] & { onConfirm: typeof onConfirm };
  return { onConfirm, props, ...render(<AgentLaunchDialog {...props} />) };
}

function picker() {
  return screen.getByRole("combobox", { name: "Agent, model and reasoning" });
}

function openPicker() {
  const trigger = picker();
  act(() => {
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
  });
  return trigger;
}

/**
 * Choosing a platform leaves the menu open, and an open Radix menu hides the
 * rest of the dialog from the accessibility tree, so the dialog's own controls
 * are unreachable until it is dismissed.
 */
function closePicker() {
  act(() => {
    fireEvent.keyDown(document.body, { key: "Escape" });
  });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
}

describe("AgentLaunchDialog", () => {
  test("adapts the shared model picker for conflict resolution", () => {
    const { onConfirm } = renderDialog({
      kind: "resolve-conflicts",
      targetBranch: "release",
    });

    expect(screen.getByRole("heading", { name: "Configure conflict resolution" })).toBeTruthy();
    expect(screen.getByText(/merge conflicts against/).textContent).toContain("release");
    expect(screen.getByText(/against release/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "claude",
        model: "claude-a",
      }),
    );
  });

  test("launches the preferred model and effort of the default agent", () => {
    const { onConfirm } = renderDialog({
      preferredModels: { claude: "claude-a" },
      preferredReasoningEfforts: { claude: "high" },
    });

    expect(screen.getByRole("heading", { name: "Configure pull request" })).toBeTruthy();
    expect(picker().textContent).toContain("Claude A");
    expect(picker().textContent).toContain("High");
    expect(screen.getByText(/Claude · Claude A · high effort · into main/)).toBeTruthy();

    submit();
    expect(onConfirm).toHaveBeenCalledWith({
      agent: "claude",
      model: "claude-a",
      reasoningEffort: "high",
    });
  });

  /**
   * Configuration persists a Claude model in its resolved space
   * (`claude-sonnet-5`) while the catalogue is keyed by alias (`sonnet`), so the
   * preference has to be matched through `resolvedModel`. A miss here is silent:
   * the dialog would simply open on the catalogue's first entry.
   */
  test("matches a preferred model stored in the agent's resolved id space", () => {
    const { onConfirm } = renderDialog({
      catalog: {
        ...catalog,
        claude: [
          {
            id: "opus",
            name: "Claude Opus",
            reasoningEfforts: ["low", "high"],
            resolvedModel: "claude-opus-5",
          },
          {
            id: "sonnet",
            name: "Claude Sonnet",
            reasoningEfforts: ["low", "high"],
            resolvedModel: "claude-sonnet-5",
          },
        ],
      },
      preferredModels: { claude: "claude-sonnet-5" },
      preferredReasoningEfforts: { claude: "high" },
    });

    expect(picker().textContent).toContain("Claude Sonnet");

    // The catalogue id, not the resolved one, is what the launch must carry.
    submit();
    expect(onConfirm).toHaveBeenCalledWith({
      agent: "claude",
      model: "sonnet",
      reasoningEffort: "high",
    });
  });

  test("names the base branch the pull request will target", () => {
    renderDialog({ targetBranch: "release/2.10" });

    expect(screen.getByText(/against/).textContent).toContain("release/2.10");
    expect(screen.getByText(/into release\/2\.10/)).toBeTruthy();
  });

  test("switches provider, model and effort together from the picker", () => {
    const { onConfirm } = renderDialog({
      preferredModels: { codex: "codex-a" },
      preferredReasoningEfforts: { codex: "medium" },
    });

    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    closePicker();

    expect(picker().textContent).toContain("Codex A");
    expect(picker().textContent).toContain("Medium");

    submit();
    expect(onConfirm).toHaveBeenCalledWith({
      agent: "codex",
      model: "codex-a",
      reasoningEffort: "medium",
    });
  });

  test("adopts the provider of a model chosen from another catalogue", () => {
    const { onConfirm } = renderDialog();

    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "opencode models" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /OpenCode A/ }));

    submit();
    expect(onConfirm).toHaveBeenCalledWith({
      agent: "opencode",
      model: "provider/model-a",
      reasoningEffort: undefined,
    });
  });

  test("selects a reasoning effort offered by the chosen model", () => {
    const { onConfirm } = renderDialog({ preferredModels: { claude: "claude-a" } });

    openPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));

    expect(picker().textContent).toContain("High");
    submit();
    expect(onConfirm).toHaveBeenCalledWith({
      agent: "claude",
      model: "claude-a",
      reasoningEffort: "high",
    });
  });

  test("drops an effort the newly chosen model does not offer", () => {
    const { onConfirm } = renderDialog({
      preferredModels: { claude: "claude-a" },
      preferredReasoningEfforts: { claude: "high" },
    });

    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "claude models" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude Fixed/ }));

    expect(screen.getByText("This model uses its default reasoning setting.")).toBeTruthy();
    submit();
    expect(onConfirm).toHaveBeenCalledWith({
      agent: "claude",
      model: "claude-fixed",
      reasoningEffort: undefined,
    });
  });

  test("offers only the providers the user has enabled", () => {
    renderDialog({ enabledAgents: ["claude", "codex"] });

    openPicker();
    expect(screen.getByRole("button", { name: "claude models" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "opencode models" }) === null).toBe(true);
  });

  test("closes without launching when cancelled", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const { onConfirm } = renderDialog({ onOpenChange });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("shows a launch error and disables confirmation while the target is invalid", () => {
    const { onConfirm } = renderDialog({
      confirmDisabled: true,
      error: "The environment is no longer running.",
    });

    expect(screen.getByRole("alert").textContent).toContain("no longer running");
    const confirm = screen.getByRole("button", { name: "Create pull request" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.submit(confirm.closest("form")!);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("presents a launch in flight as progress rather than a fault", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const { onConfirm } = renderDialog({
      kind: "resolve-conflicts",
      busy: true,
      onOpenChange,
    });

    // The user submitted successfully a moment ago. A destructive alert here
    // would tell them their own launch had failed for as long as it took.
    expect(screen.getByRole("status").textContent).toContain("Launching");
    expect(screen.queryByRole("alert") === null).toBe(true);

    const confirm = screen.getByRole("button", { name: "Resolve conflicts" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect(picker().closest("fieldset")?.disabled).toBe(true);
    expect(confirm.closest("form")?.getAttribute("aria-busy")).toBe("true");

    fireEvent.click(confirm);
    fireEvent.submit(confirm.closest("form")!);
    fireEvent.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("lets a retry in flight supersede the error it is retrying", () => {
    renderDialog({
      kind: "resolve-conflicts",
      busy: true,
      error: "The environment may no longer be ready or the maximum tab count was reached.",
    });

    expect(screen.getByRole("status").textContent).toContain("Launching");
    expect(screen.queryByRole("alert") === null).toBe(true);
  });

  test("reconfigures itself on every open, including the first", () => {
    const { props, rerender } = renderDialog({
      open: false,
      preferredModels: { claude: "claude-fixed" },
    });
    expect(screen.queryByRole("dialog") === null).toBe(true);

    rerender(<AgentLaunchDialog {...props} open />);
    expect(picker().textContent).toContain("Claude Fixed");

    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    closePicker();
    expect(picker().textContent).toContain("Codex A");

    rerender(<AgentLaunchDialog {...props} open={false} />);
    rerender(<AgentLaunchDialog {...props} open />);
    expect(picker().textContent).toContain("Claude Fixed");
  });

  test("keeps an in-progress choice when the catalogue is refreshed while open", () => {
    const { props, rerender } = renderDialog();

    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    closePicker();
    expect(picker().textContent).toContain("Codex A");

    rerender(<AgentLaunchDialog {...props} catalog={structuredClone(catalog)} />);

    expect(picker().textContent).toContain("Codex A");
  });
});
