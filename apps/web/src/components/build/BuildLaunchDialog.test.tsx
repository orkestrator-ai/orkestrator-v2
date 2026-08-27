import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentModelRef } from "@orkestrator/protocol/native-agent";
import * as realDialog from "@/components/ui/dialog";

const realDialogSnapshot = { ...realDialog };

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

import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { useConfigStore } from "@/stores/configStore";
import { BuildLaunchDialog, type BuildLaunchSelection } from "./BuildLaunchDialog";

const catalog: AgentModelCatalog = {
  claude: [
    { id: "claude-a", name: "Claude A", reasoningEfforts: ["low", "high"] },
    {
      id: "claude-b",
      name: "Claude B",
      description: "Fast implementation model",
      reasoningEfforts: ["xhigh"],
    },
  ],
  codex: [{ id: "codex-a", name: "Codex A", reasoningEfforts: ["medium", "high"] }],
  opencode: [{ id: "provider/model-a", name: "OpenCode A", reasoningEfforts: [] }],
  cursor: [{ id: "cursor-a", name: "Cursor A", reasoningEfforts: [] }],
  grok: [{ id: "grok-a", name: "Grok A", reasoningEfforts: [] }],
  pi: [{ id: "anthropic/pi-a", name: "Pi A", reasoningEfforts: ["high"] }],
};

const STEP_LABELS = [
  "Build",
  "Review",
  "Address issues",
  "Verify",
  "Pull request",
  "Resolve conflicts",
] as const;

function setFavorites(favoriteModels: AgentModelRef[]) {
  const config = useConfigStore.getState().config;
  useConfigStore.setState({
    config: { ...config, global: { ...config.global, favoriteModels } },
  });
}

function setEnabledPlatforms(enabledAgentPlatforms: AgentPlatform[]) {
  const config = useConfigStore.getState().config;
  useConfigStore.setState({
    config: { ...config, global: { ...config.global, enabledAgentPlatforms } },
  });
}

afterEach(cleanup);
beforeEach(() => {
  setFavorites([]);
  setEnabledPlatforms(["claude", "codex", "opencode"]);
});
afterAll(() => {
  mock.module("@/components/ui/dialog", () => realDialogSnapshot);
});

function renderDialog(overrides: Partial<Parameters<typeof BuildLaunchDialog>[0]> = {}) {
  const onConfirm = mock((_selection: BuildLaunchSelection) => undefined);
  const props = {
    open: true,
    onOpenChange: () => undefined,
    catalog,
    defaultAgent: "claude" as const,
    defaultEnvironmentType: "containerized" as const,
    onConfirm,
    ...overrides,
  };
  return { onConfirm, ...render(<BuildLaunchDialog {...props} />) };
}

function picker(step: (typeof STEP_LABELS)[number]) {
  return screen.getByRole("combobox", { name: `${step} step model` });
}

function openPicker(step: (typeof STEP_LABELS)[number]) {
  fireEvent.pointerDown(picker(step), { button: 0, ctrlKey: false });
}

function chooseVisibleModel(step: (typeof STEP_LABELS)[number], name: RegExp) {
  openPicker(step);
  const modelGroup = screen.getByRole("group", { name: "Models" });
  if (!within(modelGroup).queryByRole("menuitemradio", { name })) {
    fireEvent.click(screen.getByRole("button", { name: "claude models" }));
  }
  fireEvent.click(within(modelGroup).getByRole("menuitemradio", { name }));
}

function chooseFavorite(step: (typeof STEP_LABELS)[number], name: RegExp) {
  openPicker(step);
  fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "Models" })).getByRole("menuitemradio", { name }),
  );
}

function chooseReasoning(step: (typeof STEP_LABELS)[number], name: RegExp) {
  openPicker(step);
  fireEvent.click(
    within(screen.getByRole("group", { name: "Reasoning" })).getByRole("menuitemradio", { name }),
  );
}

function choosePlatform(step: (typeof STEP_LABELS)[number], platform: string) {
  openPicker(step);
  fireEvent.click(screen.getByRole("button", { name: `${platform} models` }));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Start build" }));
}

describe("BuildLaunchDialog", () => {
  test("shows the ordered pipeline immediately with one model picker per step", () => {
    renderDialog();

    expect(screen.getByRole("heading", { name: "Configure build" })).toBeTruthy();
    const stepList = screen.getByRole("list", { name: "Build steps" });
    const cards = within(stepList).getAllByRole("listitem");
    expect(cards).toHaveLength(6);
    expect(STEP_LABELS.map((label) => picker(label).textContent)).toEqual([
      expect.stringContaining("Claude A"),
      expect.stringContaining("Claude A"),
      expect.stringContaining("Claude A"),
      expect.stringContaining("Claude A"),
      expect.stringContaining("Claude A"),
      expect.stringContaining("Claude A"),
    ]);
    expect(screen.queryAllByText("Use one configuration for every step")).toHaveLength(0);
  });

  test("numbers the fixed step cards in pipeline order", () => {
    const { container } = renderDialog();

    const numbers = Array.from(container.querySelectorAll("[data-build-step-number]")).map(
      (node) => node.textContent,
    );
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(
      Array.from(container.querySelectorAll("[data-build-step]")).map((node) =>
        node.getAttribute("data-build-step"),
      ),
    ).toEqual(["build", "review", "address", "verify", "pr", "resolve-conflicts"]);
  });

  test("asks for the environment once, outside the step configuration", () => {
    const { onConfirm } = renderDialog();
    const environment = screen.getByRole("radiogroup", { name: "Build environment" });

    expect(screen.getAllByRole("radiogroup")).toHaveLength(1);
    fireEvent.click(within(environment).getByRole("radio", { name: /^Local/ }));
    submit();

    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("submits the configured default independently for all six steps", () => {
    const { onConfirm } = renderDialog({
      preferredModels: { claude: "claude-b" },
      preferredReasoningEfforts: { claude: "xhigh" },
    });

    submit();

    const shared = { agent: "claude", model: "claude-b", reasoningEffort: "xhigh" };
    expect(onConfirm).toHaveBeenCalledWith({
      environmentType: "containerized",
      steps: {
        build: shared,
        review: shared,
        address: shared,
        verify: shared,
        pr: shared,
        "resolve-conflicts": shared,
      },
    });
  });

  test("keeps every step's model, platform and reasoning independent", () => {
    setFavorites([
      { platform: "codex", modelId: "codex-a" },
      { platform: "opencode", modelId: "provider/model-a" },
    ]);
    const { onConfirm } = renderDialog({ preferredReasoningEfforts: { codex: "high" } });

    chooseFavorite("Review", /Codex A/);
    chooseVisibleModel("Address issues", /Claude B/);
    chooseReasoning("Address issues", /Extra high/);
    chooseFavorite("Verify", /OpenCode A/);
    choosePlatform("Pull request", "codex");
    submit();

    expect(onConfirm.mock.calls[0]![0].steps).toEqual({
      build: { agent: "claude", model: "claude-a", reasoningEffort: undefined },
      review: { agent: "codex", model: "codex-a", reasoningEffort: "high" },
      address: { agent: "claude", model: "claude-b", reasoningEffort: "xhigh" },
      verify: { agent: "opencode", model: "provider/model-a", reasoningEffort: undefined },
      pr: { agent: "codex", model: "codex-a", reasoningEffort: "high" },
      "resolve-conflicts": {
        agent: "claude",
        model: "claude-a",
        reasoningEffort: undefined,
      },
    });
  });

  test("adopts the platform of a favorite chosen from another provider", () => {
    setEnabledPlatforms(["claude", "codex", "opencode", "pi"]);
    setFavorites([{ platform: "pi", modelId: "anthropic/pi-a" }]);
    const { onConfirm } = renderDialog({ preferredReasoningEfforts: { pi: "high" } });

    chooseFavorite("Build", /Pi A/);
    submit();

    expect(onConfirm.mock.calls[0]![0].steps.build).toEqual({
      agent: "pi",
      model: "anthropic/pi-a",
      reasoningEffort: "high",
    });
  });

  test("lets a step return to default reasoning from the integrated picker", () => {
    const { onConfirm } = renderDialog({ preferredReasoningEfforts: { claude: "high" } });

    expect(picker("Review").textContent).toContain("High");
    chooseReasoning("Review", /^Default$/);
    submit();

    expect(onConfirm.mock.calls[0]![0].steps.review.reasoningEffort).toBeUndefined();
  });

  test("drops an effort that the newly selected model does not offer", () => {
    const { onConfirm } = renderDialog({ preferredReasoningEfforts: { claude: "high" } });

    chooseVisibleModel("Build", /Claude B/);
    expect(picker("Build").textContent).toContain("Default effort");
    submit();

    expect(onConfirm.mock.calls[0]![0].steps.build).toEqual({
      agent: "claude",
      model: "claude-b",
      reasoningEffort: undefined,
    });
  });

  test("does not claim an effort when a model exposes no reasoning controls", () => {
    renderDialog();

    choosePlatform("Build", "opencode");

    expect(picker("Build").textContent?.includes("effort")).toBe(false);
    expect(screen.getAllByText("This model uses its default reasoning setting.")).toHaveLength(1);
  });

  test("shows catalog descriptions as the model row caption", () => {
    renderDialog();

    openPicker("Build");
    const row = within(screen.getByRole("group", { name: "Models" })).getByRole("menuitemradio", {
      name: /Claude B/,
    });
    expect(row.textContent).toContain("Fast implementation model");
  });

  test("hides disabled platforms and their favorites", () => {
    setEnabledPlatforms(["claude", "codex"]);
    setFavorites([{ platform: "grok", modelId: "grok-a" }]);
    renderDialog();

    openPicker("Build");

    expect(screen.queryAllByRole("button", { name: "grok models" })).toHaveLength(0);
    expect(screen.queryAllByRole("menuitemradio", { name: /Grok A/ })).toHaveLength(0);
  });

  test("keeps a non-default selection when browsing the same provider", () => {
    const { onConfirm } = renderDialog();
    chooseVisibleModel("Build", /Claude B/);

    openPicker("Build");
    fireEvent.click(screen.getByRole("button", { name: "claude models" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    submit();

    expect(onConfirm.mock.calls[0]![0].steps.build).toEqual({
      agent: "claude",
      model: "claude-b",
      reasoningEffort: undefined,
    });
  });

  test("renders a missing favorite as unavailable without changing the submitted model", () => {
    setFavorites([{ platform: "claude", modelId: "claude-retired" }]);
    const { onConfirm } = renderDialog();

    openPicker("Build");
    const unavailable = screen.getByRole("menuitemradio", { name: /claude-retired/ });
    expect((unavailable as HTMLElement).getAttribute("data-disabled")).not.toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    submit();

    expect(onConfirm.mock.calls[0]![0].steps.build.model).toBe("claude-a");
  });

  test("offers source comments as optional build context when configured", () => {
    const { onConfirm } = renderDialog({ commentContext: { count: 3 } });
    const includeComments = screen.getByRole("checkbox", {
      name: "Include 3 comments in build context",
    });

    expect(includeComments.getAttribute("data-state")).toBe("checked");
    fireEvent.click(includeComments);
    submit();

    expect(onConfirm.mock.calls[0]![0].includeComments).toBe(false);
  });

  test("keeps all step controls in the scroll region and the actions outside it", () => {
    renderDialog();

    const scrollRegion = screen.getByRole("region", { name: "Build configuration" });
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(STEP_LABELS.every((label) => scrollRegion.contains(picker(label)))).toBe(true);
    expect(scrollRegion.contains(screen.getByRole("button", { name: "Start build" }))).toBe(false);
    expect(scrollRegion.getAttribute("tabindex")).toBeNull();
  });

  test("disables container builds and falls back to local while Docker is unavailable", async () => {
    const onConfirm = mock((_selection: BuildLaunchSelection) => undefined);
    render(
      <DockerAvailabilityProvider available={false}>
        <BuildLaunchDialog
          open
          onOpenChange={() => undefined}
          catalog={catalog}
          defaultAgent="claude"
          defaultEnvironmentType="containerized"
          onConfirm={onConfirm}
        />
      </DockerAvailabilityProvider>,
    );

    const environment = screen.getByRole("radiogroup", { name: "Build environment" });
    const container = within(environment).getByRole("radio", { name: /^Container/ });
    const local = within(environment).getByRole("radio", { name: /^Local/ });
    await waitFor(() => expect((local as HTMLInputElement).checked).toBe(true));
    expect((container as HTMLInputElement).disabled).toBe(true);

    submit();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("falls back to local when Docker stops while the dialog is open", async () => {
    const onConfirm = mock((_selection: BuildLaunchSelection) => undefined);
    const dialog = (
      <BuildLaunchDialog
        open
        onOpenChange={() => undefined}
        catalog={catalog}
        defaultAgent="claude"
        defaultEnvironmentType="containerized"
        onConfirm={onConfirm}
      />
    );
    const view = render(
      <DockerAvailabilityProvider available>{dialog}</DockerAvailabilityProvider>,
    );
    const environment = screen.getByRole("radiogroup", { name: "Build environment" });

    view.rerender(
      <DockerAvailabilityProvider available={false}>{dialog}</DockerAvailabilityProvider>,
    );
    await waitFor(() => {
      expect(
        (within(environment).getByRole("radio", { name: /^Local/ }) as HTMLInputElement).checked,
      ).toBe(true);
    });

    submit();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("does not force a local build when the project has no local checkout", () => {
    const onConfirm = mock((_selection: BuildLaunchSelection) => undefined);
    render(
      <DockerAvailabilityProvider available={false}>
        <BuildLaunchDialog
          open
          onOpenChange={() => undefined}
          catalog={catalog}
          defaultAgent="claude"
          defaultEnvironmentType="containerized"
          localEnvironmentAvailable={false}
          onConfirm={onConfirm}
        />
      </DockerAvailabilityProvider>,
    );

    const environment = screen.getByRole("radiogroup", { name: "Build environment" });
    expect(
      (within(environment).getByRole("radio", { name: /^Container/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (within(environment).getByRole("radio", { name: /^Local/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Start build" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("opens on the local environment when it is the configured default", () => {
    const { onConfirm } = renderDialog({ defaultEnvironmentType: "local" });
    const environment = screen.getByRole("radiogroup", { name: "Build environment" });

    expect(
      (within(environment).getByRole("radio", { name: /^Local/ }) as HTMLInputElement).checked,
    ).toBe(true);
    submit();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("restores the local default on reopen once a checkout becomes available", async () => {
    const onConfirm = mock((_selection: BuildLaunchSelection) => undefined);
    const dialog = (open: boolean, localEnvironmentAvailable: boolean) => (
      <DockerAvailabilityProvider available>
        <BuildLaunchDialog
          open={open}
          onOpenChange={() => undefined}
          catalog={catalog}
          defaultAgent="claude"
          defaultEnvironmentType="local"
          localEnvironmentAvailable={localEnvironmentAvailable}
          onConfirm={onConfirm}
        />
      </DockerAvailabilityProvider>
    );
    const view = render(dialog(true, false));
    await waitFor(() => {
      const environment = screen.getByRole("radiogroup", { name: "Build environment" });
      expect(
        (within(environment).getByRole("radio", { name: /^Container/ }) as HTMLInputElement)
          .checked,
      ).toBe(true);
    });

    view.rerender(dialog(false, true));
    view.rerender(dialog(true, true));

    await waitFor(() => {
      const environment = screen.getByRole("radiogroup", { name: "Build environment" });
      expect(
        (within(environment).getByRole("radio", { name: /^Local/ }) as HTMLInputElement).checked,
      ).toBe(true);
    });
    submit();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("resets every step to its defaults each time the dialog reopens", () => {
    setFavorites([{ platform: "codex", modelId: "codex-a" }]);
    const onConfirm = mock((_selection: BuildLaunchSelection) => undefined);
    const dialog = (open: boolean) => (
      <BuildLaunchDialog
        open={open}
        onOpenChange={() => undefined}
        catalog={catalog}
        defaultAgent="claude"
        defaultEnvironmentType="containerized"
        onConfirm={onConfirm}
      />
    );
    const view = render(dialog(true));
    chooseFavorite("Review", /Codex A/);

    view.rerender(dialog(false));
    view.rerender(dialog(true));

    expect(picker("Review").textContent).toContain("Claude A");
    submit();
    expect(onConfirm.mock.calls[0]![0].steps.review.agent).toBe("claude");
  });

  test("keeps step choices when a catalog arrives while the dialog is open", () => {
    const { onConfirm, rerender } = renderDialog();
    chooseVisibleModel("Build", /Claude B/);

    rerender(
      <BuildLaunchDialog
        open
        onOpenChange={() => undefined}
        catalog={{
          ...catalog,
          claude: [
            ...catalog.claude,
            { id: "claude-c", name: "Claude C", reasoningEfforts: ["low"] },
          ],
        }}
        defaultAgent="claude"
        defaultEnvironmentType="containerized"
        onConfirm={onConfirm}
      />,
    );

    expect(picker("Build").textContent).toContain("Claude B");
    submit();
    expect(onConfirm.mock.calls[0]![0].steps.build.model).toBe("claude-b");
  });

  test("falls back when a preferred model is no longer in the catalog", () => {
    const { onConfirm } = renderDialog({ preferredModels: { claude: "claude-retired" } });

    submit();
    expect(onConfirm.mock.calls[0]![0].steps.build.model).toBe("claude-a");
  });

  test("offers a placeholder when the default platform exposes no models", () => {
    const { onConfirm } = renderDialog({ catalog: { ...catalog, claude: [] } });

    expect(picker("Build").textContent).toContain("Choose a model");
    submit();
    expect(onConfirm.mock.calls[0]![0].steps.build).toEqual({
      agent: "claude",
      model: "default",
      reasoningEffort: undefined,
    });
  });

  test("disables the entire form and guards dismissal and submission while busy", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const onConfirm = mock((_selection: BuildLaunchSelection) => undefined);
    renderDialog({ busy: true, onOpenChange, onConfirm });

    expect(picker("Build").closest("fieldset")?.disabled).toBe(true);
    const start = screen.getByRole("button", { name: "Starting build…" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const form = start.closest("form")!;
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");

    fireEvent.submit(form);
    fireEvent.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("cancel closes without confirming", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const { onConfirm } = renderDialog({ onOpenChange });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("BuildLaunchDialog validation workspace disclosure", () => {
  test("discloses writable workspace access only on review and verification", () => {
    renderDialog();

    const disclosures = screen.getAllByRole("note");
    expect(disclosures).toHaveLength(2);
    for (const disclosure of disclosures) {
      expect(disclosure.textContent).toContain("full workspace access");
      expect(disclosure.textContent).toContain("Git-tracked or untracked path");
      expect(disclosure.textContent).toContain("Ignored files are not checked");
    }
  });
});
