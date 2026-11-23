import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  cleanupNodeScopes,
  FakeNodeClient,
  renderInAppCommandScope,
  renderInNodeScope,
} from "@/test/render-in-node-scope";
import { MODAL_MODEL_PICKER_TRIGGER_CLASS_NAME } from "@/components/ui/modal-theme";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { configStore } from "@/stores/configStore";
import { agentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { useHostPathPickerStore } from "@/lib/host-path-picker";
import { CreateEnvironmentDialog, type ClaudeOptions } from "./CreateEnvironmentDialog";
import { appCommandStore } from "@/test/app-command-store";
import * as backend from "@/lib/backend";
import { configureLogger, resetLogger } from "@orkestrator/protocol/logger";
import type { ComponentProps } from "react";
import type { BuildIntent } from "@/lib/feature-build-launch";

const baseConfig = appCommandStore(configStore).getState().config;

afterEach(() => {
  cleanup();
  appCommandStore(configStore).setState({ config: baseConfig });
  appCommandStore(agentModelCatalogStore).setState({
    cursorModels: [],
    grokModels: [],
    piModels: [],
  });
});

/**
 * Every class the shared picker theme promises must survive `cn`'s tailwind-merge
 * against `AgentModelPicker`'s own base classes, so asserting the constant token by
 * token is what stops one call site drifting from the other.
 */
function expectModelPickerTheme(picker: HTMLElement): void {
  const applied = picker.className.split(/\s+/);
  for (const token of MODAL_MODEL_PICKER_TRIGGER_CLASS_NAME.split(/\s+/)) {
    expect(applied).toContain(token);
  }
}

describe("CreateEnvironmentDialog initial prompt attachments", () => {
  test("shows and submits every capability exposed by the selected Cursor model", async () => {
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        global: {
          ...baseConfig.global,
          enabledAgentPlatforms: ["cursor"],
          favoriteModels: [],
          agentSettings: {
            ...baseConfig.global.agentSettings,
            defaultAgent: "cursor",
            platforms: {
              ...baseConfig.global.agentSettings?.platforms,
              cursor: { mode: "native", model: "grok-4.6" },
            },
          },
        },
      },
    });
    appCommandStore(agentModelCatalogStore).setState({
      cursorModels: [
        {
          platform: "cursor",
          id: "grok-4.6",
          label: "Cursor Grok 4.6",
          reasoning: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
          defaultReasoningId: "high",
          supportsSpeed: true,
        },
      ],
      grokModels: [],
      piModels: [],
    });
    const onCreate = mock(async (_options: ClaudeOptions) => true);

    renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={() => undefined}
          onCreate={onCreate}
          projectId="project-1"
        />
      </DockerAvailabilityProvider>,
    );

    const picker = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
    await act(async () => fireEvent.pointerDown(picker));
    expect(screen.getByRole("group", { name: "Reasoning", hidden: true })).toBeTruthy();
    const speed = screen.getByRole("group", { name: "Speed mode", hidden: true });
    fireEvent.click(within(speed).getByRole("menuitemradio", { name: /Fast/, hidden: true }));
    act(() => fireEvent.keyDown(document.body, { key: "Escape" }));

    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        agentType: "cursor",
        model: "grok-4.6",
        fastMode: true,
      }),
    );
  });

  test("feature rows open on the saved platform model and submit it without customization", async () => {
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        global: {
          ...baseConfig.global,
          enabledAgentPlatforms: ["cursor"],
          agentSettings: {
            ...baseConfig.global.agentSettings,
            defaultAgent: "cursor",
            platforms: {
              ...baseConfig.global.agentSettings?.platforms,
              cursor: { mode: "native", model: "cursor-saved" },
            },
            actionDefaults: {},
          },
        },
      },
    });
    appCommandStore(agentModelCatalogStore).setState({
      cursorModels: [
        { platform: "cursor", id: "cursor-first", label: "First model" },
        { platform: "cursor", id: "cursor-saved", label: "Saved model" },
      ],
    });
    const onCreateFeatureBuild = mock(async (_request: unknown) => undefined);
    renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={() => undefined}
          onCreate={mock(async () => true)}
          onCreateFeatureBuild={onCreateFeatureBuild}
          projectId="project-1"
        />
      </DockerAvailabilityProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: "Test inherited defaults" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    const customize = screen.getByRole("switch", { name: "Customize models" });
    fireEvent.click(customize);
    const group = screen.getByRole("group", { name: "Pipeline model customization" });
    for (const picker of within(group).getAllByLabelText(/agent, model and reasoning$/)) {
      expect(picker.textContent).toContain("Saved model");
    }
    fireEvent.click(customize);
    expect(customize.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(onCreateFeatureBuild).toHaveBeenCalledTimes(1));
    expect(onCreateFeatureBuild.mock.calls[0]?.[0]).toMatchObject({
      steps: {
        review: { agent: "cursor", model: "cursor-saved" },
        verify: { agent: "cursor", model: "cursor-saved" },
        pr: { agent: "cursor", model: "cursor-saved" },
      },
      reviewers: [
        { agent: "cursor", model: "cursor-saved" },
        { agent: "cursor", model: "cursor-saved" },
      ],
      reviewPreparation: { agent: "cursor", model: "cursor-saved" },
    });
  });

  test("labels an unqualified configured OpenCode model across environment and feature pickers", async () => {
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        global: {
          ...baseConfig.global,
          enabledAgentPlatforms: ["opencode"],
          favoriteModels: [],
          agentSettings: {
            ...baseConfig.global.agentSettings,
            defaultAgent: "opencode",
            platforms: {
              ...baseConfig.global.agentSettings?.platforms,
              opencode: { mode: "native", model: "unqualified-model" },
            },
            actionDefaults: {
              ...baseConfig.global.agentSettings?.actionDefaults,
              newProject: { platform: "opencode", model: "unqualified-model" },
            },
          },
        },
      },
    });

    renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={() => undefined}
          onCreate={mock(async () => true)}
          projectId="project-1"
        />
      </DockerAvailabilityProvider>,
    );

    const picker = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
    await waitFor(() => expect(picker.textContent).toContain("unqualified-model"));
    await act(async () => {
      fireEvent.pointerDown(picker);
    });

    const row = within(screen.getByRole("group", { name: "Models", hidden: true })).getByRole(
      "menuitemradio",
      { name: /unqualified-model/, hidden: true },
    );
    expect(row.textContent).toContain("Configured default");
    act(() => fireEvent.keyDown(document.body, { key: "Escape" }));

    fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Customize models" }));
    const buildPicker = screen.getByRole("combobox", {
      name: "Build agent, model and reasoning",
    });
    await act(async () => {
      fireEvent.pointerDown(buildPicker);
    });
    const buildRow = within(screen.getByRole("group", { name: "Models", hidden: true })).getByRole(
      "menuitemradio",
      { name: /unqualified-model/, hidden: true },
    );
    expect(buildRow.textContent).toContain("Configured default");
    act(() => fireEvent.keyDown(document.body, { key: "Escape" }));
  });

  test("uses the compact themed layout with equally sized name and agent controls", () => {
    renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={mock(() => undefined)}
          onCreate={mock(async () => true)}
          projectId="project-1"
          projectName="orkestrator-v2"
        />
      </DockerAvailabilityProvider>,
    );

    expect(
      screen.getByRole("heading", {
        name: "Create Ork (environment) - orkestrator-v2",
      }),
    ).toBeTruthy();
    expect(screen.getByText("orkestrator-v2")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Containerized environment" })).toBeTruthy();

    const containerTypeButton = screen.getByRole("button", { name: "Containerized" });
    const localTypeButton = screen.getByRole("button", { name: "Local" });
    expect(containerTypeButton.className).toContain("font-bold");
    expect(localTypeButton.className).toContain("font-normal");
    expect(localTypeButton.className).toContain("h-8");
    fireEvent.click(localTypeButton);
    expect(screen.getByRole("img", { name: "Local environment" })).toBeTruthy();
    expect(localTypeButton.className).toContain("font-bold");
    expect(containerTypeButton.className).toContain("font-normal");

    expect(screen.getByRole("button", { name: "Task" }).className).toContain("font-bold");
    expect(screen.getByRole("button", { name: "Pipeline" }).className).toContain("font-normal");
    expect(screen.getByRole("button", { name: "Create environment" }).className).toContain(
      "font-bold",
    );
    expect(screen.getByRole("button", { name: "Cancel" }).dataset.variant).toBe("outline");

    const name = screen.getByLabelText("Environment name (optional)");
    const agent = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
    const launch = screen.getByRole("checkbox", { name: "Launch agent" });
    const prompt = screen.getByLabelText("Initial prompt (optional)");
    expect(name.className).toContain("h-9");
    expect(name.className).toContain("px-3");
    expect(name.className).toContain("bg-input-surface");
    expectModelPickerTheme(agent);
    expect(agent.parentElement).toBe(launch.parentElement?.parentElement ?? null);
    expect(agent.parentElement?.className).toContain("sm:grid-cols-[minmax(0,1fr)_7rem]");
    expect(name.parentElement?.className).toContain("sm:grid-cols-[minmax(0,1fr)_7rem]");
    expect(name.closest("div.border-b")?.className).toContain(
      "sm:grid-cols-[7.5rem_minmax(0,1fr)]",
    );
    expect(name.closest("div.border-b")?.className).toContain("sm:px-6");
    expect(name.closest("div.border-b")?.className).toContain("py-3");
    expect(agent.closest("div.border-b")?.className).toContain(
      "sm:grid-cols-[7.5rem_minmax(0,1fr)]",
    );
    const promptField = document.querySelector<HTMLElement>('[data-slot="initial-prompt-field"]');
    const promptLabel = document.querySelector<HTMLLabelElement>('label[for="initial-prompt"]');
    expect(promptField?.contains(prompt)).toBe(true);
    expect(promptField?.className).toContain("sm:grid-cols-[7.5rem_minmax(0,1fr)]");
    expect(promptLabel?.htmlFor).toBe(prompt.id);
    expect(promptLabel?.textContent).toContain("Initial prompt");
    expect(promptLabel?.querySelector(".sr-only")?.textContent).toBe("(optional)");
    expect(promptLabel?.className).toContain("text-muted-foreground");
    expect(prompt.getAttribute("aria-label")).toBeNull();

    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    const header = document.querySelector<HTMLElement>('[data-slot="dialog-header"]');
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("[--modal-max-width:56rem]");
    expect(dialog.className).toContain("bg-background");
    expect(dialog.className).toContain("sm:p-0");
    expect(dialog.style.getPropertyValue("--color-background")).toBe("");
    expect(header?.className).toContain("bg-background");
    expect(overlay?.className).toContain("bg-black/75");
    expect(overlay?.className).toContain("backdrop-blur-md");
  });

  test("creates a local environment in a folder picked next to its name", async () => {
    const onCreate = mock(async (_options: ClaudeOptions) => true);
    renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={() => undefined}
          onCreate={onCreate}
          projectId="project-1"
        />
      </DockerAvailabilityProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Containerized" }));
    expect(screen.queryByRole("button", { name: "Choose worktree location" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose worktree location" }));
    await waitFor(() => expect(useHostPathPickerStore.getState().request?.mode).toBe("directory"));
    act(() => useHostPathPickerStore.getState().settle("/srv/trees"));
    await waitFor(() => expect(screen.getByText("Worktree in /srv/trees")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ environmentType: "local", worktreeBaseDir: "/srv/trees" }),
    );
  });

  test("pins a local environment to the exact base commit resolved while the dialog is open", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const readTip = spyOn(backend, "getProjectBaseBranchTip").mockImplementation(async () => ({
      branch: "main",
      commit,
      ref: "origin/main",
      fetched: true,
      launchEligible: true,
      fetchedAt: new Date().toISOString(),
    }));
    try {
      const onCreate = mock(async (_options: ClaudeOptions) => true);
      renderInAppCommandScope(
        <DockerAvailabilityProvider available>
          <CreateEnvironmentDialog
            open
            onOpenChange={() => undefined}
            onCreate={onCreate}
            projectId="project-1"
          />
        </DockerAvailabilityProvider>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Containerized" }));
      // A container clones from the remote, so it never reads the base here.
      expect(screen.queryByTestId("launch-base-row") === null).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Local" }));
      await waitFor(() =>
        expect(screen.getByTestId("launch-base-row").textContent).toContain(commit),
      );
      expect(readTip).toHaveBeenCalledWith("project-1", false);

      fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(onCreate.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          environmentType: "local",
          launchBase: { branch: "main", commit },
        }),
      );
    } finally {
      readTip.mockRestore();
    }
  });

  test("submitting during the base refresh carries the pending request to start", async () => {
    const readTip = spyOn(backend, "getProjectBaseBranchTip").mockImplementation(
      () => new Promise(() => {}),
    );
    try {
      const onCreate = mock(async (_options: ClaudeOptions) => true);
      renderInAppCommandScope(
        <DockerAvailabilityProvider available>
          <CreateEnvironmentDialog
            open
            onOpenChange={() => {}}
            onCreate={onCreate}
            projectId="project-1"
          />
        </DockerAvailabilityProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Local" }));
      await waitFor(() => expect(readTip).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(onCreate.mock.calls[0]?.[0].launchBase).toEqual({ pending: true });
    } finally {
      readTip.mockRestore();
    }
  });

  test("a container create carries no pinned base", async () => {
    const readTip = spyOn(backend, "getProjectBaseBranchTip").mockImplementation(async () => ({
      branch: "main",
      commit: "a".repeat(40),
      ref: "origin/main",
      fetched: true,
      launchEligible: true,
    }));
    try {
      const onCreate = mock(async (_options: ClaudeOptions) => true);
      renderInAppCommandScope(
        <DockerAvailabilityProvider available>
          <CreateEnvironmentDialog
            open
            onOpenChange={() => undefined}
            onCreate={onCreate}
            projectId="project-1"
          />
        </DockerAvailabilityProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Containerized" }));
      fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(onCreate.mock.calls[0]?.[0]?.launchBase).toBeUndefined();
    } finally {
      readTip.mockRestore();
    }
  });

  test("Cmd+Enter or Ctrl+Enter anywhere in the dialog creates the environment", async () => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const onCreate = mock(async (_options: ClaudeOptions) => true);
      renderInAppCommandScope(
        <DockerAvailabilityProvider available>
          <CreateEnvironmentDialog
            open
            onOpenChange={() => undefined}
            onCreate={onCreate}
            projectId="project-1"
          />
        </DockerAvailabilityProvider>,
      );

      const prompt = screen.getByRole("textbox", { name: /Initial prompt/ });
      fireEvent.change(prompt, { target: { value: "first line" } });
      fireEvent.keyDown(prompt, { key: "Enter", ...modifier });
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(onCreate.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ initialPrompt: "first line" }),
      );
      cleanup();
    }
  });

  test("plain Enter never creates the environment", async () => {
    const onCreate = mock(async (_options: ClaudeOptions) => true);
    renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={() => undefined}
          onCreate={onCreate}
          projectId="project-1"
        />
      </DockerAvailabilityProvider>,
    );

    // The prompt is multi-line: Enter is left to the textarea to insert a newline.
    const prompt = screen.getByRole("textbox", { name: /Initial prompt/ });
    fireEvent.change(prompt, { target: { value: "first line" } });
    expect(fireEvent.keyDown(prompt, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(prompt, { key: "Enter", shiftKey: true })).toBe(true);

    // The name is single-line: Enter is swallowed so it cannot submit the form.
    const name = screen.getByRole("textbox", { name: "Environment name (optional)" });
    expect(fireEvent.keyDown(name, { key: "Enter" })).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.keyDown(name, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });

  test("ignores repeated, composing, prevented, Shift and Alt chords", async () => {
    const onCreate = mock(async () => true);
    renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog open onOpenChange={() => undefined} onCreate={onCreate} />
      </DockerAvailabilityProvider>,
    );
    const prompt = screen.getByRole("textbox", { name: /Initial prompt/ });
    for (const extra of [
      { repeat: true },
      { isComposing: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      fireEvent.keyDown(prompt, { key: "Enter", ctrlKey: true, ...extra });
    }
    const prevented = createEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    prevented.preventDefault();
    fireEvent(prompt, prevented);
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });

  for (const reason of ["loading", "ports", "blank feature", "missing feature handler"] as const) {
    test(`shortcut respects disabled submission: ${reason}`, () => {
      const onCreate = mock(async () => true);
      const onCreateFeatureBuild = mock(async () => undefined);
      renderInAppCommandScope(
        <DockerAvailabilityProvider available>
          <CreateEnvironmentDialog
            open
            onOpenChange={() => undefined}
            onCreate={onCreate}
            isLoading={reason === "loading"}
            defaultPortMappings={
              reason === "ports" ? [{ containerPort: 0, hostPort: 3000, protocol: "tcp" }] : []
            }
            onCreateFeatureBuild={
              reason === "missing feature handler" ? undefined : onCreateFeatureBuild
            }
          />
        </DockerAvailabilityProvider>,
      );
      if (reason.includes("feature")) {
        fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
        if (reason === "missing feature handler") {
          fireEvent.change(screen.getByLabelText(/^Description/), {
            target: { value: "Build a feature" },
          });
        }
      }
      expect(
        (screen.getByRole("button", { name: "Create environment" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ...modifier });
      }
      expect(onCreate).not.toHaveBeenCalled();
      expect(onCreateFeatureBuild).not.toHaveBeenCalled();
    });
  }

  test("Cmd+Enter does nothing while Create environment is disabled", async () => {
    const onCreate = mock(async (_options: ClaudeOptions) => true);
    renderInAppCommandScope(
      <DockerAvailabilityProvider available={false}>
        <CreateEnvironmentDialog
          open
          onOpenChange={() => undefined}
          onCreate={onCreate}
          projectId="project-1"
          localEnvironmentAvailable={false}
        />
      </DockerAvailabilityProvider>,
    );

    expect(
      (screen.getByRole("button", { name: "Create environment" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCreate).not.toHaveBeenCalled();
  });

  test("keeps disabled environment-type explanations visible and associated", () => {
    renderInAppCommandScope(
      <DockerAvailabilityProvider available={false}>
        <CreateEnvironmentDialog
          open
          onOpenChange={mock(() => undefined)}
          onCreate={mock(async () => true)}
          projectId="project-1"
          localEnvironmentAvailable={false}
        />
      </DockerAvailabilityProvider>,
    );

    const containerized = screen.getByRole("button", { name: "Containerized" });
    const local = screen.getByRole("button", { name: "Local" });
    expect(containerized.getAttribute("aria-describedby")).toBe("containerized-unavailable");
    expect(local.getAttribute("aria-describedby")).toBe("local-unavailable");
    expect(screen.getByText("Containers unavailable while Docker stopped")).toBeTruthy();
    expect(screen.getByText("Unavailable without a local project checkout")).toBeTruthy();
  });

  test("themes customized build model selectors like the dialog agent selector", () => {
    renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={mock(() => undefined)}
          onCreate={mock(async () => true)}
          projectId="project-1"
        />
      </DockerAvailabilityProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Customize models" }));

    const customization = screen.getByRole("group", {
      name: "Pipeline model customization",
    });
    // Match on the label rather than the combobox role: the picker only takes
    // that role when it is given an id, so a picker added without one would
    // silently drop out of a role-based query instead of failing the theme
    // assertions below.
    const customizedPickers = within(customization).getAllByLabelText(
      /agent, model and reasoning$/,
    );
    const labels = customizedPickers.map((picker) => picker.getAttribute("aria-label"));

    // The first step row, the reviewer rows, and the step rows rendered after
    // the reviewer block are three separate render paths in FeatureBuildFields.
    expect(labels).toContain("Build agent, model and reasoning");
    expect(labels).toContain("Review preparation & consolidation agent, model and reasoning");
    expect(labels).toContain("Review 1 agent, model and reasoning");
    expect(labels).toContain("Review 2 agent, model and reasoning");
    expect(labels).toContain("Resolve conflicts agent, model and reasoning");
    expect(within(customization).getAllByRole("combobox").length).toBe(customizedPickers.length);

    for (const picker of customizedPickers) {
      expectModelPickerTheme(picker);
    }
  });

  test("attaches a dropped markdown file and includes it in the create request", async () => {
    const onCreate = mock(async (_options: ClaudeOptions) => true);
    renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={mock(() => undefined)}
          onCreate={onCreate}
          projectId="project-1"
        />
      </DockerAvailabilityProvider>,
    );

    const dialog = screen.getByRole("dialog");
    const file = new File(["# Requirements\n\nShip the drag-and-drop flow."], "requirements.md", {
      type: "text/markdown",
    });
    const dataTransfer = {
      files: [file],
      types: ["Files"],
      dropEffect: "copy",
    };

    fireEvent.dragEnter(dialog, { dataTransfer });
    expect(screen.getByText("Drop files to attach them to the initial prompt")).toBeTruthy();
    fireEvent.drop(dialog, { dataTransfer });

    await screen.findByText("requirements.md");
    fireEvent.change(screen.getByLabelText(/Initial prompt/), {
      target: { value: "Implement the attached requirements." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        initialPrompt: "Implement the attached requirements.",
        initialPromptAttachments: [
          expect.objectContaining({
            name: "requirements.md",
            type: "file",
            base64Data: btoa("# Requirements\n\nShip the drag-and-drop flow."),
          }),
        ],
      }),
    );
  });
});

test("local feature builds hide and clear a previously picked worktree folder", async () => {
  renderInAppCommandScope(
    <DockerAvailabilityProvider available>
      <CreateEnvironmentDialog
        open
        onOpenChange={() => {}}
        onCreate={async () => true}
        projectId="project-1"
      />
    </DockerAvailabilityProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Local" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose worktree location" }));
  await waitFor(() => expect(useHostPathPickerStore.getState().request?.mode).toBe("directory"));
  act(() => useHostPathPickerStore.getState().settle("/srv/trees"));
  await waitFor(() => expect(screen.getByText("Worktree in /srv/trees")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
  expect(screen.queryByRole("button", { name: "Choose worktree location" }) === null).toBe(true);
  expect(screen.queryByText("Worktree in /srv/trees") === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Task" }));
  expect(screen.getByRole("button", { name: "Choose worktree location" })).toBeTruthy();
  expect(screen.queryByText("Worktree in /srv/trees") === null).toBe(true);
});

describe("CreateEnvironmentDialog root setup step warning", () => {
  const RESTRICTED_HINT = "Only GitHub, npm, and agent APIs";
  const ROOT_WARNING = /orkestrator-ai\.json has root setup steps/;

  afterEach(() => {
    mock.restore();
  });

  function answer(rootSteps: number | null) {
    return spyOn(backend, "getProjectSetupRequirements").mockImplementation(async () => ({
      rootSteps,
    }));
  }

  function renderDialog(onCreate = mock(async (_options: ClaudeOptions) => true)) {
    renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={() => undefined}
          onCreate={onCreate}
          projectId="project-1"
        />
      </DockerAvailabilityProvider>,
    );
    return onCreate;
  }

  test("a container under Restricted warns in place of the restricted hint", async () => {
    const read = answer(2);
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Restricted" }));
    await waitFor(() => expect(screen.getByText(ROOT_WARNING)).toBeTruthy());
    expect(read).toHaveBeenCalledWith("project-1");
    expect(screen.getByText(ROOT_WARNING).closest("[role='status']")).toBeTruthy();
    expect(screen.queryByText(RESTRICTED_HINT) === null).toBe(true);
  });

  test("Full access shows no warning", async () => {
    const read = answer(2);
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Restricted" }));
    await waitFor(() => expect(screen.getByText(ROOT_WARNING)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Full access" }));
    expect(screen.queryByText(ROOT_WARNING) === null).toBe(true);
    expect(screen.getByText("Unrestricted internet access")).toBeTruthy();
    expect(read).toHaveBeenCalled();
  });

  test("a local environment neither warns nor reads the requirements", async () => {
    const read = answer(2);
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Restricted" }));
    await waitFor(() => expect(screen.getByText(ROOT_WARNING)).toBeTruthy());
    read.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(ROOT_WARNING) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Restricted" }) === null).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  test("no root steps, or a machine that cannot tell, keeps the restricted hint", async () => {
    for (const rootSteps of [0, null]) {
      const read = answer(rootSteps);
      renderDialog();
      fireEvent.click(screen.getByRole("button", { name: "Restricted" }));
      await waitFor(() => expect(read).toHaveBeenCalled());
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(RESTRICTED_HINT)).toBeTruthy();
      expect(screen.queryByText(ROOT_WARNING) === null).toBe(true);
      cleanup();
      mock.restore();
    }
  });

  test("a failed read keeps the restricted hint", async () => {
    const read = spyOn(backend, "getProjectSetupRequirements").mockImplementation(async () => {
      throw new Error("Unknown backend command: get_project_setup_requirements");
    });
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Restricted" }));
    await waitFor(() => expect(read).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(RESTRICTED_HINT)).toBeTruthy();
    expect(screen.queryByText(ROOT_WARNING) === null).toBe(true);
  });

  test("declared Debian packages are named beside the network hint (to-do 7770)", async () => {
    spyOn(backend, "getProjectSetupRequirements").mockImplementation(async () => ({
      rootSteps: 0,
      aptPackages: { packages: ["libvips-dev", "ffmpeg"], refused: [], invalid: false },
    }));
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Restricted" }));
    const restricted =
      "Setup installs 2 Debian packages from Debian's archive (libvips-dev, ffmpeg), so this environment can also reach deb.debian.org.";
    await waitFor(() => expect(screen.getByText(restricted)).toBeTruthy());
    expect(screen.getByText(RESTRICTED_HINT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Full access" }));
    expect(
      screen.getByText(
        "Setup installs 2 Debian packages from Debian's archive (libvips-dev, ffmpeg).",
      ),
    ).toBeTruthy();
  });

  test("the warning does not change the network choice that is submitted", async () => {
    answer(1);
    const onCreate = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Restricted" }));
    await waitFor(() => expect(screen.getByText(ROOT_WARNING)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0].networkAccessMode).toBe("restricted");
  });
});

describe("CreateEnvironmentDialog remembered Build choice", () => {
  const projectId = "remembered-choice-project";

  afterEach(() => {
    cleanupNodeScopes();
    mock.restore();
    resetLogger();
  });

  function configWithIntent(lastBuildIntent?: BuildIntent, id = projectId) {
    return {
      ...baseConfig,
      repositories: {
        ...baseConfig.repositories,
        [id]: {
          defaultBranch: "main",
          prBaseBranch: "main",
          ...(lastBuildIntent ? { lastBuildIntent } : {}),
        },
      },
    };
  }

  function rememberBuildIntent(lastBuildIntent?: BuildIntent) {
    appCommandStore(configStore).getState().setConfig(configWithIntent(lastBuildIntent));
  }

  function spyOnPatch() {
    return spyOn(backend, "patchRepositorySettings").mockImplementation(async (id, updates) =>
      configWithIntent(updates.lastBuildIntent, id),
    );
  }

  function dialog(props: Partial<ComponentProps<typeof CreateEnvironmentDialog>>) {
    return (
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={() => undefined}
          onCreate={props.onCreate ?? mock(async () => true)}
          projectId={projectId}
          {...props}
        />
      </DockerAvailabilityProvider>
    );
  }

  function renderDialog(props: Partial<ComponentProps<typeof CreateEnvironmentDialog>>) {
    return renderInAppCommandScope(dialog(props));
  }

  function pressed(name: string): string | null {
    return screen.getByRole("button", { name }).getAttribute("aria-pressed");
  }

  test("opens on the choice the project last created with", () => {
    rememberBuildIntent("interactive");
    renderDialog({});
    expect(pressed("Interactive")).toBe("true");
    expect(pressed("Task")).toBe("false");
  });

  test("opens on Pipeline when it was last used and this dialog can launch one", () => {
    rememberBuildIntent("feature");
    renderDialog({ onCreateFeatureBuild: mock(async () => undefined) });
    expect(pressed("Pipeline")).toBe("true");
  });

  test("falls back to Task with nothing remembered or no pipeline launcher", () => {
    rememberBuildIntent("feature");
    renderDialog({});
    expect(pressed("Task")).toBe("true");
    cleanup();
    rememberBuildIntent();
    renderDialog({});
    expect(pressed("Task")).toBe("true");
  });

  test("records a changed choice once the environment is created", async () => {
    rememberBuildIntent("task");
    const patch = spyOnPatch();
    const onCreate = mock(async (_options: ClaudeOptions) => true);
    renderDialog({ onCreate });
    fireEvent.click(screen.getByRole("button", { name: "Interactive" }));
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ interactionMode: "interactive" });
    expect(patch).toHaveBeenCalledWith(projectId, { lastBuildIntent: "interactive" }, []);
  });

  test("records Pipeline after a pipeline launch", async () => {
    rememberBuildIntent("task");
    const patch = spyOnPatch();
    const onCreateFeatureBuild = mock(async (_request: unknown) => undefined);
    renderDialog({ onCreateFeatureBuild });
    fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: "Remember me" } });
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(projectId, { lastBuildIntent: "feature" }, []);
  });

  test("records each success, including an initially unchanged choice that finishes last", async () => {
    rememberBuildIntent("task");
    const patch = spyOnPatch();
    const taskCreate = Promise.withResolvers<boolean>();
    const interactiveSave = Promise.withResolvers<typeof baseConfig>();
    patch.mockImplementationOnce(() => interactiveSave.promise);
    const onTaskCreate = mock(() => taskCreate.promise);
    renderDialog({ onCreate: onTaskCreate });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create environment" })),
    );
    expect(onTaskCreate).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
    cleanup();

    renderDialog({});
    fireEvent.click(screen.getByRole("button", { name: "Interactive" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create environment" })),
    );
    expect(patch).toHaveBeenNthCalledWith(1, projectId, { lastBuildIntent: "interactive" }, []);
    await act(async () => taskCreate.resolve(true));
    expect(patch).toHaveBeenCalledTimes(1);
    await act(async () => interactiveSave.resolve(configWithIntent("interactive")));

    expect(patch).toHaveBeenNthCalledWith(2, projectId, { lastBuildIntent: "task" }, []);
    expect(
      appCommandStore(configStore).getState().config.repositories[projectId]?.lastBuildIntent,
    ).toBe("task");
  });

  test("reopens on the just-used choice before the patch and refresh, and keeps a manual selection", async () => {
    rememberBuildIntent("task");
    const save = Promise.withResolvers<typeof baseConfig>();
    spyOnPatch().mockImplementation(() => save.promise);
    const onOpenChange = mock(() => undefined);
    const view = renderDialog({ onOpenChange });
    fireEvent.click(screen.getByRole("button", { name: "Interactive" }));
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    view.rerender(dialog({ open: false }));
    view.rerender(dialog({}));
    expect(pressed("Interactive")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    await act(async () => save.resolve(configWithIntent("interactive")));
    expect(pressed("Task")).toBe("true");

    // The patch response should bridge the gap until the resource refresh.
    view.rerender(dialog({ open: false }));
    view.rerender(dialog({}));
    expect(pressed("Interactive")).toBe("true");
    act(() => rememberBuildIntent("task"));
    expect(pressed("Interactive")).toBe("true");
  });

  test("restores a prompt-only draft with the remembered choice", () => {
    rememberBuildIntent("task");
    const id = "prompt-only-draft";
    const view = renderDialog({ projectId: id });
    const prompt = () => screen.getByLabelText<HTMLTextAreaElement>("Initial prompt (optional)");
    fireEvent.change(prompt(), { target: { value: "Restore my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    view.rerender(dialog({ projectId: id, open: false }));
    act(() =>
      appCommandStore(configStore).getState().setConfig(configWithIntent("interactive", id)),
    );
    view.rerender(dialog({ projectId: id }));
    expect(prompt().value).toBe("Restore my draft");
    expect(pressed("Interactive")).toBe("true");
  });

  test("patches only the leaf's project and reopens on that leaf's choice", async () => {
    rememberBuildIntent("task");
    const commandPatch = spyOnPatch();
    const leafProject = "leaf-project";
    const client = new FakeNodeClient({
      invoke: { patch_repository_settings: () => configWithIntent("interactive", leafProject) },
    });
    const leafDialog = (open: boolean) => dialog({ open, projectId: leafProject });
    const view = renderInNodeScope(leafDialog(false), { client, role: "leaf" });
    const leafConfig = view.scope.store(configStore);
    act(() => leafConfig.getState().setConfig(configWithIntent("task", leafProject)));
    view.rerender(leafDialog(true));
    expect(pressed("Task")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Interactive" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create environment" })),
    );

    expect(client.calls("patch_repository_settings").map(({ args }) => args)).toEqual([
      { projectId: leafProject, updates: { lastBuildIntent: "interactive" } },
    ]);
    expect(commandPatch).not.toHaveBeenCalled();
    expect(appCommandStore(configStore).getState().config.repositories).not.toHaveProperty(
      leafProject,
    );
    view.rerender(leafDialog(false));
    view.rerender(leafDialog(true));
    expect(pressed("Interactive")).toBe("true");
  });

  test("a refused create leaves the remembered choice alone", async () => {
    rememberBuildIntent("task");
    const patch = spyOnPatch();
    const refused = mock(async (_options: ClaudeOptions) => false);
    renderDialog({ onCreate: refused });
    fireEvent.click(screen.getByRole("button", { name: "Interactive" }));
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(refused).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(patch).not.toHaveBeenCalled();
  });

  test("logs a rejected preference patch and still closes after a successful create", async () => {
    rememberBuildIntent("task");
    spyOnPatch().mockRejectedValue(new Error("preference store unavailable"));
    const sink = mock(() => undefined);
    configureLogger({ sink });
    const onOpenChange = mock(() => undefined);
    const view = renderDialog({ onOpenChange });
    fireEvent.click(screen.getByRole("button", { name: "Interactive" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create environment" })),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "warn",
        line: expect.stringContaining("create.build-intent-save-failed"),
      }),
    );
    view.rerender(dialog({ open: false }));
    view.rerender(dialog({}));
    expect(pressed("Task")).toBe("true");
  });
});

test("container and pipeline admission keep an Antigravity opening draft and use an eligible agent", async () => {
  appCommandStore(configStore).setState({
    config: {
      ...baseConfig,
      global: {
        ...baseConfig.global,
        enabledAgentPlatforms: ["antigravity", "claude"],
        agentSettings: { ...baseConfig.global.agentSettings, defaultAgent: "antigravity" },
      },
      repositories: {
        ...baseConfig.repositories,
        ["ag-review"]: {
          defaultBranch: "main",
          prBaseBranch: "main",
          lastEnvironmentType: "local",
        },
      },
    },
  });
  const onCreate = mock(async (_options: ClaudeOptions) => false);
  const onCreateFeatureBuild = mock(async (_options: unknown) => false);
  renderInAppCommandScope(
    <DockerAvailabilityProvider available>
      <CreateEnvironmentDialog
        open
        projectId="ag-review"
        localEnvironmentAvailable
        onOpenChange={() => {}}
        onCreate={onCreate}
        onCreateFeatureBuild={onCreateFeatureBuild}
      />
    </DockerAvailabilityProvider>,
  );
  const picker = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
  const submit = screen.getByRole("button", { name: "Create environment" }) as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText(/Initial prompt/), {
    target: { value: "Keep the draft" },
  });
  expect(picker.textContent).toContain("Antigravity");
  fireEvent.click(screen.getByRole("button", { name: "Containerized" }));
  expect(screen.getByText(/available in local environments only/)).toBeTruthy();
  expect(submit.disabled).toBe(true);
  await act(async () => fireEvent.pointerDown(picker));
  expect(await screen.findByRole("button", { name: /^claude models/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^antigravity models/ }) === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /^claude models/ }));
  act(() => fireEvent.keyDown(document.body, { key: "Escape" }));
  fireEvent.click(submit);
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "claude",
        environmentType: "containerized",
        initialPrompt: "Keep the draft",
      }),
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Local" }));
  await act(async () => fireEvent.pointerDown(picker));
  fireEvent.click(await screen.findByRole("button", { name: /^antigravity models/ }));
  act(() => fireEvent.keyDown(document.body, { key: "Escape" }));
  expect(picker.textContent).toContain("Antigravity");

  fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
  expect(picker.textContent).not.toContain("Antigravity");
  expect((screen.getByLabelText(/^Description/) as HTMLTextAreaElement).value).toBe(
    "Keep the draft",
  );
  fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
  fireEvent.click(screen.getByRole("switch", { name: "Customize models" }));
  const group = screen.getByRole("group", { name: "Pipeline model customization" });
  const reviewer = within(group).getByRole("combobox", {
    name: "Review 1 agent, model and reasoning",
  });
  await act(async () => fireEvent.pointerDown(reviewer));
  expect(await screen.findByRole("button", { name: /^claude models/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^antigravity models/ }) === null).toBe(true);
  act(() => fireEvent.keyDown(document.body, { key: "Escape" }));
  fireEvent.click(submit);
  await waitFor(() =>
    expect(onCreateFeatureBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "claude",
        reviewers: expect.arrayContaining([expect.objectContaining({ agent: "claude" })]),
      }),
    ),
  );
});
