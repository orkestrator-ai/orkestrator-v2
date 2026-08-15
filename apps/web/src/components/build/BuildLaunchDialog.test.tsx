import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createContext, useContext } from "react";
import * as realDialog from "@/components/ui/dialog";
import * as realSelect from "@/components/ui/select";

const realDialogSnapshot = { ...realDialog };
const realSelectSnapshot = { ...realSelect };
const SelectTestContext = createContext<{
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
} | null>(null);

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

mock.module("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <SelectTestContext.Provider value={{ value, onValueChange, disabled }}>
      <div>{children}</div>
    </SelectTestContext.Provider>
  ),
  SelectTrigger: ({
    id,
    className,
    children,
  }: {
    id?: string;
    className?: string;
    children: React.ReactNode;
  }) => (
    <button
      id={id}
      className={className}
      type="button"
      role="combobox"
      disabled={useContext(SelectTestContext)?.disabled ?? false}
    >
      {children}
    </button>
  ),
  SelectValue: () => <span>{useContext(SelectTestContext)?.value}</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
    const state = useContext(SelectTestContext)!;
    return (
      <button type="button" role="option" onClick={() => state.onValueChange(value)}>
        {children}
      </button>
    );
  },
}));
import { BuildLaunchDialog, type BuildLaunchSelection } from "./BuildLaunchDialog";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { useConfigStore } from "@/stores/configStore";

afterEach(cleanup);
afterAll(() => {
  mock.module("@/components/ui/dialog", () => realDialogSnapshot);
  mock.module("@/components/ui/select", () => realSelectSnapshot);
});

const catalog: AgentModelCatalog = {
  claude: [
    { id: "claude-a", name: "Claude A", reasoningEfforts: ["low", "high"] },
    { id: "claude-b", name: "Claude B", reasoningEfforts: ["xhigh"] },
  ],
  codex: [{ id: "codex-a", name: "Codex A", reasoningEfforts: ["medium", "high"] }],
  opencode: [
    { id: "provider/model-a", name: "OpenCode A", reasoningEfforts: [] },
  ],
};

function renderDialog(
  overrides: Partial<Parameters<typeof BuildLaunchDialog>[0]> = {},
) {
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

type StepLabel =
  | "All steps"
  | "Build"
  | "Review"
  | "Address issues"
  | "Verify"
  | "PR"
  | "Conflicts";

function chooseAgent(step: StepLabel, agent: string) {
  const group = screen.getByRole("radiogroup", { name: `${step} agent` });
  fireEvent.click(within(group).getByRole("radio", { name: agent }));
}

function chooseModel(step: StepLabel, model: string) {
  const trigger = screen.getByRole("combobox", { name: `${step} model` });
  fireEvent.click(within(trigger.parentElement!).getByRole("option", { name: model }));
}

function chooseEffort(step: StepLabel, effort: string) {
  const trigger = screen.getByRole("combobox", { name: `${step} reasoning effort` });
  fireEvent.click(within(trigger.parentElement!).getByRole("option", { name: effort }));
}

/** The stubbed SelectValue renders the effort the dialog currently holds. */
function effortValue(step: StepLabel) {
  return screen.getByRole("combobox", { name: `${step} reasoning effort` }).textContent;
}

function modelValue(step: StepLabel) {
  return screen.getByRole("combobox", { name: `${step} model` }).textContent;
}

function environmentSummary() {
  return screen.getByText("Environment:").parentElement?.textContent;
}

/** Unticks "use one configuration for every step" to reveal the step sections. */
function separateSteps() {
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Use one configuration for every step/ }),
  );
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Start build" }));
}

const claudeDefault = {
  agent: "claude" as const,
  model: "claude-a",
  reasoningEffort: undefined,
};

describe("BuildLaunchDialog", () => {
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

  test("falls back to local when Docker stops while the build dialog is open", async () => {
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
      <DockerAvailabilityProvider available>
        {dialog}
      </DockerAvailabilityProvider>,
    );
    const environment = screen.getByRole("radiogroup", { name: "Build environment" });
    expect((within(environment).getByRole("radio", { name: /^Container/ }) as HTMLInputElement).checked)
      .toBe(true);

    view.rerender(
      <DockerAvailabilityProvider available={false}>
        {dialog}
      </DockerAvailabilityProvider>,
    );
    await waitFor(() => {
      expect((within(environment).getByRole("radio", { name: /^Local/ }) as HTMLInputElement).checked)
        .toBe(true);
    });

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
    // The correction away from an unavailable option is deliberately
    // one-directional, so reopening is what re-derives the user's default.
    const view = render(dialog(true, false));
    await waitFor(() => {
      const environment = screen.getByRole("radiogroup", { name: "Build environment" });
      expect(
        (within(environment).getByRole("radio", { name: /^Container/ }) as HTMLInputElement).checked,
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
    expect((within(environment).getByRole("radio", { name: /^Container/ }) as HTMLInputElement).disabled)
      .toBe(true);
    expect((within(environment).getByRole("radio", { name: /^Local/ }) as HTMLInputElement).disabled)
      .toBe(true);
    const start = screen.getByRole("button", { name: "Start build" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(start);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("applies one configuration to every step while the toggle is ticked", () => {
    const { onConfirm } = renderDialog({
      preferredModels: { claude: "claude-b" },
      preferredReasoningEfforts: { claude: "xhigh" },
    });

    expect(screen.getByRole("heading", { name: "Configure build" })).toBeTruthy();
    // One shared section, so no per-step controls are on screen.
    expect(screen.queryByRole("radiogroup", { name: "Review agent" }) === null).toBe(true);
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

  test("asks for the environment once, outside the per-step configuration", () => {
    const { onConfirm } = renderDialog();
    const environment = screen.getByRole("radiogroup", { name: "Build environment" });

    separateSteps();
    // One environment control for the whole pipeline, six agent controls.
    expect(screen.getAllByRole("radiogroup").length).toBe(7);
    fireEvent.click(within(environment).getByRole("radio", { name: /^Local/ }));
    submit();

    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("offers source comments as optional build context when configured", () => {
    const { onConfirm } = renderDialog({ commentContext: { count: 3 } });
    const includeComments = screen.getByRole("checkbox", {
      name: "Include 3 comments in build context",
    }) as HTMLButtonElement;

    expect(includeComments.getAttribute("data-state")).toBe("checked");
    fireEvent.click(includeComments);
    submit();

    expect(onConfirm.mock.calls[0]![0].includeComments).toBe(false);
  });

  test("keeps each step's harness, model and reasoning independent", () => {
    const { onConfirm } = renderDialog();

    separateSteps();
    chooseAgent("Review", "Codex");
    chooseModel("Address issues", "Claude B");
    chooseEffort("Address issues", "Extra high");
    chooseAgent("Verify", "OpenCode");
    chooseAgent("PR", "Codex");
    chooseAgent("Conflicts", "OpenCode");
    const reviewEffort = screen.getByRole("combobox", { name: "Review reasoning effort" });
    fireEvent.click(within(reviewEffort.parentElement!).getByRole("option", { name: "High" }));
    submit();

    expect(onConfirm.mock.calls[0]![0].steps).toEqual({
      build: claudeDefault,
      review: { agent: "codex", model: "codex-a", reasoningEffort: "high" },
      address: { agent: "claude", model: "claude-b", reasoningEffort: "xhigh" },
      // OpenCode A exposes no efforts, so the step submits none.
      verify: { agent: "opencode", model: "provider/model-a", reasoningEffort: undefined },
      pr: { agent: "codex", model: "codex-a", reasoningEffort: undefined },
      "resolve-conflicts": {
        agent: "opencode",
        model: "provider/model-a",
        reasoningEffort: undefined,
      },
    });
  });

  test("re-ticking the toggle puts every step back on the build configuration", () => {
    const { onConfirm } = renderDialog();

    separateSteps();
    chooseAgent("Build", "Codex");
    chooseAgent("Verify", "OpenCode");
    // Ticking again adopts the build step, not whichever step was edited last.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Use one configuration for every step/ }),
    );
    submit();

    const shared = {
      agent: "codex" as const,
      model: "codex-a",
      reasoningEffort: undefined,
    };
    expect(onConfirm.mock.calls[0]![0].steps).toEqual({
      build: shared,
      review: shared,
      address: shared,
      verify: shared,
      pr: shared,
      "resolve-conflicts": shared,
    });
  });

  test("unticking starts every step from the shared configuration", () => {
    const { onConfirm } = renderDialog();

    chooseAgent("All steps", "Codex");
    separateSteps();
    chooseAgent("Build", "Claude");
    submit();

    const steps = onConfirm.mock.calls[0]![0].steps;
    expect(steps.build.agent).toBe("claude");
    expect(steps.review.agent).toBe("codex");
    expect(steps.address.agent).toBe("codex");
    expect(steps["resolve-conflicts"].agent).toBe("codex");
  });

  test("switching a step's harness moves it to that harness's own model", () => {
    renderDialog();

    separateSteps();
    expect(screen.getByRole("combobox", { name: "Build model" }).textContent)
      .toContain("Claude A");
    chooseAgent("Build", "Codex");
    expect(screen.getByRole("combobox", { name: "Build model" }).textContent)
      .toContain("Codex A");
    // The other steps are untouched by a build-step change.
    expect(screen.getByRole("combobox", { name: "Review model" }).textContent)
      .toContain("Claude A");
  });

  test("uses the searchable favorite-aware model picker for OpenCode", () => {
    const config = useConfigStore.getState().config;
    useConfigStore.setState({
      config: {
        ...config,
        global: {
          ...config.global,
          favoriteModels: [{ platform: "opencode", modelId: "provider/model-b" }],
        },
      },
    });
    const openCodeCatalog: AgentModelCatalog = {
      ...catalog,
      opencode: [
        {
          id: "provider/model-a",
          name: "OpenCode A",
          description: "Provider A",
          reasoningEfforts: [],
        },
        {
          id: "provider/model-b",
          name: "OpenCode B",
          description: "Provider B",
          reasoningEfforts: [],
        },
      ],
    };
    const { onConfirm } = renderDialog({
      catalog: openCodeCatalog,
      defaultAgent: "opencode",
    });

    const trigger = screen.getByRole("combobox", { name: "All steps model" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const search = screen.getByPlaceholderText("Search models...");
    fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
    expect(screen.getByRole("menuitemradio", { name: /OpenCode B/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "opencode models" }));

    fireEvent.change(search, { target: { value: "model-a" } });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /OpenCode A/ }));
    submit();
    expect(onConfirm.mock.calls[0]![0].steps.build.model).toBe("provider/model-a");
  });

  test("disables reasoning for a model that has no effort levels", () => {
    renderDialog();

    separateSteps();
    chooseAgent("Verify", "OpenCode");
    expect(
      (screen.getByRole("combobox", { name: "Verify reasoning effort" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("This model uses its default reasoning setting.")).toBeTruthy();
  });

  test("ignores a preferred model the catalog no longer offers", () => {
    const { onConfirm } = renderDialog({ preferredModels: { claude: "claude-retired" } });

    submit();
    expect(onConfirm.mock.calls[0]![0].steps.build.model).toBe("claude-a");
  });

  test("resets to the defaults each time it reopens", () => {
    const { onConfirm, rerender } = renderDialog();

    separateSteps();
    chooseAgent("Review", "Codex");
    rerender(
      <BuildLaunchDialog
        open={false}
        onOpenChange={() => undefined}
        catalog={catalog}
        defaultAgent="claude"
        defaultEnvironmentType="containerized"
        onConfirm={onConfirm}
      />,
    );
    rerender(
      <BuildLaunchDialog
        open
        onOpenChange={() => undefined}
        catalog={catalog}
        defaultAgent="claude"
        defaultEnvironmentType="containerized"
        onConfirm={onConfirm}
      />,
    );

    submit();
    expect(onConfirm.mock.calls[0]![0].steps.review.agent).toBe("claude");
  });

  test("opens on the local environment when that is the configured default", () => {
    const { onConfirm } = renderDialog({ defaultEnvironmentType: "local" });
    const environment = screen.getByRole("radiogroup", { name: "Build environment" });

    // Initial value, not the result of a click: every other test starts
    // containerized and clicks its way to local.
    expect((
      within(environment).getByRole("radio", { name: /^Local/ }) as HTMLInputElement
    ).checked).toBe(true);
    expect(environmentSummary()).toBe("Environment: Local worktree");
    submit();

    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("summarises the environment and every visible step", () => {
    renderDialog();

    expect(environmentSummary()).toBe("Environment: Container");
    expect(screen.getByText("All steps: Claude A · default effort")).toBeTruthy();

    const environment = screen.getByRole("radiogroup", { name: "Build environment" });
    fireEvent.click(within(environment).getByRole("radio", { name: /^Local/ }));
    separateSteps();
    chooseAgent("Review", "Codex");
    chooseEffort("Review", "High");

    expect(environmentSummary()).toBe("Environment: Local worktree");
    expect(screen.getByText("Build: Claude A · default effort")).toBeTruthy();
    expect(screen.getByText("Review: Codex A · high effort")).toBeTruthy();
  });

  test("disables the submit button only while a start request is in flight", () => {
    const { onConfirm, rerender } = renderDialog({ busy: true });

    expect((
      screen.getByRole("button", { name: "Start build" }) as HTMLButtonElement
    ).disabled).toBe(true);

    rerender(
      <BuildLaunchDialog
        open
        onOpenChange={() => undefined}
        catalog={catalog}
        defaultAgent="claude"
        defaultEnvironmentType="containerized"
        busy={false}
        onConfirm={onConfirm}
      />,
    );

    expect((
      screen.getByRole("button", { name: "Start build" }) as HTMLButtonElement
    ).disabled).toBe(false);
    submit();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("drops a reasoning effort the newly picked model does not offer", () => {
    const { onConfirm } = renderDialog({
      preferredReasoningEfforts: { claude: "high" },
    });

    expect(effortValue("All steps")).toBe("high");
    chooseModel("All steps", "Claude B");

    expect(modelValue("All steps")).toContain("Claude B");
    // Claude B offers "xhigh" only, so "high" cannot survive the switch.
    expect(effortValue("All steps")).toBe("default");
    // effortLabel spells this one out rather than capitalising it.
    expect(within(
      screen.getByRole("combobox", { name: "All steps reasoning effort" }).parentElement!,
    ).getByRole("option", { name: "Extra high" })).toBeTruthy();
    submit();

    expect(onConfirm.mock.calls[0]![0].steps.build).toEqual({
      agent: "claude",
      model: "claude-b",
      reasoningEffort: undefined,
    });
  });

  test("adopts the preferred effort once a model that offers it is picked", () => {
    const { onConfirm } = renderDialog({
      preferredReasoningEfforts: { claude: "xhigh" },
    });

    // Claude A has no "xhigh", so the dialog opens on the default instead.
    expect(effortValue("All steps")).toBe("default");
    chooseModel("All steps", "Claude B");

    expect(effortValue("All steps")).toBe("xhigh");
    submit();
    expect(onConfirm.mock.calls[0]![0].steps.build.reasoningEffort).toBe("xhigh");
  });

  test("seeds codex and opencode from their own preferred reasoning efforts", () => {
    const { onConfirm } = renderDialog({
      catalog: {
        ...catalog,
        opencode: [
          { id: "provider/model-a", name: "OpenCode A", reasoningEfforts: ["low", "high"] },
        ],
      },
      preferredReasoningEfforts: { codex: "high", opencode: "low" },
    });

    separateSteps();
    chooseAgent("Review", "Codex");
    chooseAgent("Verify", "OpenCode");

    expect(effortValue("Review")).toBe("high");
    expect(effortValue("Verify")).toBe("low");
    submit();

    expect(onConfirm.mock.calls[0]![0].steps.review.reasoningEffort).toBe("high");
    expect(onConfirm.mock.calls[0]![0].steps.verify.reasoningEffort).toBe("low");
  });

  test("offers a placeholder when a harness exposes no models at all", () => {
    const { onConfirm } = renderDialog({ catalog: { ...catalog, claude: [] } });

    expect(modelValue("All steps")).toContain("Choose a model");
    expect((
      screen.getByRole("combobox", { name: "All steps reasoning effort" }) as HTMLButtonElement
    ).disabled).toBe(true);
    expect(screen.getByText("All steps: default · default effort")).toBeTruthy();
    submit();

    expect(onConfirm.mock.calls[0]![0].steps.build).toEqual({
      agent: "claude",
      model: "default",
      reasoningEffort: undefined,
    });
  });

  test("keeps the selection when a catalog arrives while the dialog is open", () => {
    const { onConfirm, rerender } = renderDialog();

    separateSteps();
    chooseAgent("Review", "Codex");
    chooseModel("Build", "Claude B");

    // A late model fetch hands the dialog a different catalog object; the
    // closed→open guard is what stops that discarding the user's answers.
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

    // Still unticked and still on the picked model: no reset ran.
    expect(screen.getByRole("radiogroup", { name: "Review agent" })).toBeTruthy();
    expect(modelValue("Build")).toContain("Claude B");
    submit();

    expect(onConfirm.mock.calls[0]![0].steps.build.model).toBe("claude-b");
    expect(onConfirm.mock.calls[0]![0].steps.review.agent).toBe("codex");
  });

  test("unticking keeps the shared model and reasoning on all six steps", () => {
    const { onConfirm } = renderDialog();

    chooseAgent("All steps", "Codex");
    chooseEffort("All steps", "High");
    separateSteps();
    submit();

    const shared = {
      agent: "codex" as const,
      model: "codex-a",
      reasoningEffort: "high",
    };
    expect(onConfirm.mock.calls[0]![0].steps).toEqual({
      build: shared,
      review: shared,
      address: shared,
      verify: shared,
      pr: shared,
      "resolve-conflicts": shared,
    });
  });

  test("re-ticking copies the build step's model and reasoning over the rest", () => {
    const { onConfirm } = renderDialog();

    separateSteps();
    chooseAgent("Review", "Codex");
    chooseEffort("Review", "High");
    chooseModel("Build", "Claude B");
    chooseEffort("Build", "Extra high");
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Use one configuration for every step/ }),
    );
    submit();

    const shared = {
      agent: "claude" as const,
      model: "claude-b",
      reasoningEffort: "xhigh",
    };
    expect(onConfirm.mock.calls[0]![0].steps).toEqual({
      build: shared,
      review: shared,
      address: shared,
      verify: shared,
      pr: shared,
      "resolve-conflicts": shared,
    });
  });

  test("cancel closes without confirming", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const { onConfirm } = renderDialog({ onOpenChange });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("BuildLaunchDialog step markers", () => {
  /** The header badge plus one marker per visible step, all `size-8`. */
  function iconBadges(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>('[class~="size-8"]'));
  }

  test("renders one badge for the header, the environment and each visible step", () => {
    const { container } = renderDialog();

    // Uniform mode collapses the six steps onto one card.
    expect(iconBadges(container)).toHaveLength(3);

    separateSteps();

    // Header + environment + build, review, address, verify, PR and conflicts.
    expect(iconBadges(container)).toHaveLength(8);
  });

  test("numbers the steps from the environment onwards", () => {
    const { container } = renderDialog();
    separateSteps();

    const numbers = iconBadges(container)
      .map((badge) => badge.querySelector("span")?.textContent)
      .filter((label) => label !== undefined && label !== "");
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  test("shapes every badge identically and never lets one squash", () => {
    const { container } = renderDialog();
    separateSteps();

    for (const badge of iconBadges(container)) {
      expect(badge.className).toContain("rounded-full");
      // Without shrink-0 a flex sibling can squash the circle into an ellipse.
      expect(badge.className).toContain("shrink-0");
      expect(badge.className).toContain("place-items-center");
    }
  });

  test("draws no connector below the last step", () => {
    const { container } = renderDialog();
    separateSteps();

    // One connector between each consecutive pair, none trailing the last.
    const connectors = container.querySelectorAll('[class*="min-h-5"]');
    expect(connectors).toHaveLength(iconBadges(container).length - 2);
  });
});

describe("BuildLaunchDialog validation workspace disclosure", () => {
  const notice = /full workspace access/;

  test("discloses writable review and verification on the uniform card", () => {
    renderDialog();

    const disclosure = screen.getByRole("note");
    expect(disclosure.textContent).toMatch(notice);
    expect(disclosure.textContent).toContain("Review and verify");
    // The check covers HEAD and Git-visible paths only, so the disclosure has
    // to name that limit rather than imply the workspace is protected.
    expect(disclosure.textContent).toContain("Git-tracked or untracked path");
    expect(disclosure.textContent).toContain("Ignored files are not checked");
  });

  test("discloses only the review and verification cards when configured separately", () => {
    renderDialog();
    separateSteps();

    const disclosures = screen.getAllByRole("note");
    expect(disclosures).toHaveLength(2);
    expect(disclosures.every((entry) => entry.textContent?.match(notice))).toBe(true);
    expect(disclosures.every((entry) => entry.textContent?.includes("This step"))).toBe(true);
  });

  test("keeps the disclosure when the validation harness changes", () => {
    renderDialog();
    separateSteps();
    chooseAgent("Review", "Codex");
    chooseAgent("Verify", "OpenCode");

    expect(screen.getAllByRole("note")).toHaveLength(2);
  });
});
