import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

type StepLabel = "All steps" | "Build" | "Review" | "Verify" | "PR" | "Conflicts";

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
  test("applies one configuration to every step while the toggle is ticked", () => {
    const { onConfirm } = renderDialog({
      preferredModels: { claude: "claude-b" },
      preferredReasoningEfforts: { claude: "xhigh" },
    });

    expect(screen.getByRole("heading", { name: "Configure build" })).toBeTruthy();
    // One shared section, so no per-step controls are on screen.
    expect(screen.queryByRole("radiogroup", { name: "Review agent" })).toBeNull();
    submit();

    const shared = { agent: "claude", model: "claude-b", reasoningEffort: "xhigh" };
    expect(onConfirm).toHaveBeenCalledWith({
      environmentType: "containerized",
      steps: {
        build: shared,
        review: shared,
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
    // One environment control for the whole pipeline, five agent controls.
    expect(screen.getAllByRole("radiogroup").length).toBe(6);
    fireEvent.click(within(environment).getByRole("radio", { name: /^Local/ }));
    submit();

    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("keeps each step's harness, model and reasoning independent", () => {
    const { onConfirm } = renderDialog();

    separateSteps();
    chooseAgent("Review", "Codex");
    chooseAgent("Verify", "OpenCode");
    chooseAgent("PR", "Codex");
    chooseAgent("Conflicts", "OpenCode");
    const reviewEffort = screen.getByRole("combobox", { name: "Review reasoning effort" });
    fireEvent.click(within(reviewEffort.parentElement!).getByRole("option", { name: "High" }));
    submit();

    expect(onConfirm.mock.calls[0]![0].steps).toEqual({
      build: claudeDefault,
      review: { agent: "codex", model: "codex-a", reasoningEffort: "high" },
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

  test("unticking keeps the shared model and reasoning on all five steps", () => {
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

    // Uniform mode collapses the five steps onto one card.
    expect(iconBadges(container)).toHaveLength(3);

    separateSteps();

    // Header + environment + build, review, verify, PR and conflicts.
    expect(iconBadges(container)).toHaveLength(7);
  });

  test("numbers the steps from the environment onwards", () => {
    const { container } = renderDialog();
    separateSteps();

    const numbers = iconBadges(container)
      .map((badge) => badge.querySelector("span")?.textContent)
      .filter((label) => label !== undefined && label !== "");
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6"]);
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
