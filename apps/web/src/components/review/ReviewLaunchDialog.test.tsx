import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
  // Radix puts `disabled` on the root and the trigger inherits it through
  // context, so the mock has to do the same or a disabled select is untestable.
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
import {
  REVIEW_TAB_OPTIONS,
  ReviewLaunchDialog,
  getReviewAgent,
  type ReviewLaunchSelection,
  type ReviewModelCatalog,
  type ReviewTabType,
} from "./ReviewLaunchDialog";
import { useConfigStore } from "@/stores/configStore";

/**
 * The picker renders its three choice columns side by side on desktop and as
 * pop-out submenus on mobile, so every assertion here has to pin the viewport.
 */
function setViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 767px)" ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

/**
 * `matchMedia` is a shared global, so a stub left installed decides the layout
 * of every suite that runs after this one in the same process.
 */
const originalMatchMedia = window.matchMedia;

afterEach(cleanup);
beforeEach(() => {
  setViewport(false);
  const config = useConfigStore.getState().config;
  useConfigStore.setState({
    config: {
      ...config,
      global: {
        ...config.global,
        enabledAgentPlatforms: ["claude", "codex", "cursor", "grok", "opencode"],
        favoriteModels: [{ platform: "opencode", modelId: "provider/model-a" }],
      },
    },
  });
});
afterAll(() => {
  mock.module("@/components/ui/dialog", () => realDialogSnapshot);
  mock.module("@/components/ui/select", () => realSelectSnapshot);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: originalMatchMedia,
  });
});

const catalog: ReviewModelCatalog = {
  claude: [
    { id: "claude-a", name: "Claude A", reasoningEfforts: ["low", "high"] },
    { id: "claude-b", name: "Claude B", reasoningEfforts: ["xhigh"] },
  ],
  codex: [
    { id: "codex-a", name: "Codex A", reasoningEfforts: ["medium", "high"] },
  ],
  cursor: [{ id: "cursor-a", name: "Cursor A", reasoningEfforts: [] }],
  grok: [{ id: "grok-a", name: "Grok A", reasoningEfforts: [] }],
  opencode: [
    { id: "provider/model-a", name: "OpenCode A", reasoningEfforts: ["fast", "deep"] },
  ],
};

/** A model with no reasoning efforts, and a provider whose catalog is empty. */
const sparseCatalog: ReviewModelCatalog = {
  claude: [
    { id: "claude-a", name: "Claude A", reasoningEfforts: ["low", "high"] },
    { id: "claude-fixed", name: "Claude Fixed", reasoningEfforts: [] },
  ],
  codex: [{ id: "codex-a", name: "Codex A", reasoningEfforts: ["medium"] }],
  opencode: [],
};

/** OpenCode entries carry the provider as their description, like the real catalog. */
const openCodeCatalog: ReviewModelCatalog = {
  ...catalog,
  opencode: [
    {
      id: "provider/model-a",
      name: "OpenCode A",
      description: "provider",
      reasoningEfforts: ["fast"],
    },
    {
      id: "other/model-b",
      name: "OpenCode B",
      description: "other",
      reasoningEfforts: ["fast"],
    },
  ],
};

/** The one control the dialog now offers for provider, model and reasoning. */
const picker = () => screen.getByRole("combobox", { name: "Agent, model and reasoning" });

const openPicker = () => {
  const trigger = picker();
  fireEvent.pointerDown(trigger);
  return trigger;
};

/**
 * An open menu marks the rest of the dialog `aria-hidden`, so anything queried
 * by role outside it is invisible until the menu is dismissed. Choosing an item
 * dismisses it; browsing the platform rail does not.
 */
const closePicker = () => {
  fireEvent.keyDown(document.body, { key: "Escape" });
};

const models = () => within(screen.getByRole("group", { name: "Models" }));

const modelItem = (name: RegExp) => models().getByRole("menuitemradio", { name });

const reasoningItems = () => within(screen.getByRole("group", { name: "Reasoning" }));

const showProviderModels = (agent: string) => {
  fireEvent.click(screen.getByRole("button", { name: `${agent} models` }));
};

const chooseModel = (name: RegExp, agent?: string) => {
  openPicker();
  if (agent) showProviderModels(agent);
  fireEvent.click(modelItem(name));
};

const chooseReasoning = (name: RegExp) => {
  openPicker();
  fireEvent.click(reasoningItems().getByRole("menuitemradio", { name }));
};

const chooseProvider = (agent: string) => {
  openPicker();
  showProviderModels(agent);
  closePicker();
};

function renderDialog(overrides: Partial<Parameters<typeof ReviewLaunchDialog>[0]> = {}) {
  const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
  const props = {
    open: true,
    onOpenChange: () => undefined,
    defaultTabType: "claude" as const,
    catalog,
    onConfirm,
    ...overrides,
  };
  return { onConfirm, props, ...render(<ReviewLaunchDialog {...props} />) };
}

describe("ReviewLaunchDialog", () => {
  test("offers every native provider in one picker and confirms a one-pass review", () => {
    const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude"
        catalog={catalog}
        preferredModels={{ claude: "claude-b" }}
        preferredReasoningEfforts={{ claude: "xhigh" }}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Configure code review" })).toBeTruthy();

    openPicker();
    // Every provider is reachable from the one control rather than from a
    // separate radio group.
    for (const option of REVIEW_TAB_OPTIONS) {
      expect(screen.getByRole("button", { name: `${option.agent} models` })).toBeTruthy();
    }
    expect(screen.getByPlaceholderText("Search models...")).toBeTruthy();
    closePicker();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-b",
      reasoningEffort: "xhigh",
    });
  });

  test("hides disabled providers and falls back from a disabled default", () => {
    const config = useConfigStore.getState().config;
    useConfigStore.setState({
      config: {
        ...config,
        global: {
          ...config.global,
          enabledAgentPlatforms: ["claude"],
        },
      },
    });
    const { onConfirm } = renderDialog({
      defaultTabType: "codex",
      preferredModels: { claude: "claude-b" },
      preferredReasoningEfforts: { claude: "xhigh" },
    });

    expect(picker().textContent).toContain("Claude B");
    openPicker();
    expect(screen.getByRole("button", { name: "claude models" })).toBeTruthy();
    for (const agent of ["codex", "cursor", "grok", "opencode"]) {
      expect(screen.queryByRole("button", { name: `${agent} models` })).toBeNull();
    }
    closePicker();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-b",
      reasoningEffort: "xhigh",
    });
  });

  test("keeps only Claude when configuration enables no platform at all", () => {
    const config = useConfigStore.getState().config;
    useConfigStore.setState({
      config: {
        ...config,
        global: { ...config.global, enabledAgentPlatforms: [] },
      },
    });
    // Malformed persisted state must still leave the dialog launchable rather
    // than offering an empty picker.
    const { onConfirm } = renderDialog({ defaultTabType: "opencode" });

    expect(picker().textContent).toContain("Claude A");
    openPicker();
    expect(screen.getByRole("button", { name: "claude models" })).toBeTruthy();
    for (const agent of ["codex", "cursor", "grok", "opencode"]) {
      expect(screen.queryByRole("button", { name: `${agent} models` })).toBeNull();
    }
    closePicker();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-a",
      reasoningEffort: undefined,
    });
  });

  test("keeps favourites from disabled providers out of the picker", () => {
    const config = useConfigStore.getState().config;
    useConfigStore.setState({
      config: {
        ...config,
        global: {
          ...config.global,
          enabledAgentPlatforms: ["claude"],
          // A favourite outlives the provider it was earned under, and the
          // favourites view reads this list rather than the model catalog.
          favoriteModels: [
            { platform: "claude", modelId: "claude-b" },
            { platform: "opencode", modelId: "provider/model-a" },
          ],
        },
      },
    });
    renderDialog();

    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
    expect(modelItem(/Claude B/)).toBeTruthy();
    expect(models().queryByRole("menuitemradio", { name: /provider\/model-a/ })).toBeNull();
    expect(models().queryByRole("menuitemradio", { name: /OpenCode/ })).toBeNull();
    closePicker();
  });

  test("captions each model row with its catalog description", () => {
    renderDialog({
      catalog: {
        ...catalog,
        claude: [
          {
            id: "claude-a",
            name: "Claude A",
            description: "Balanced reviews for everyday code changes",
            reasoningEfforts: ["low", "high"],
          },
          { id: "claude-b", name: "Claude B", reasoningEfforts: ["xhigh"] },
        ],
      },
    });

    openPicker();
    // The caption the old model list showed has to survive the move into the
    // picker, where a row's second line is the provider label.
    expect(modelItem(/Claude A/).textContent)
      .toContain("Balanced reviews for everyday code changes");
    // A model with no description still names its platform.
    expect(modelItem(/Claude B/).textContent).toContain("Claude");
    closePicker();
  });

  test("shows the model and its reasoning effort on the single trigger", () => {
    renderDialog({
      preferredModels: { claude: "claude-a" },
      preferredReasoningEfforts: { claude: "high" },
    });

    // The three former controls collapse into one labelled combobox.
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(picker().textContent).toContain("Claude A");
    expect(picker().textContent).toContain("High");
  });

  test("configures looped review with allowance 6 by default and supports 1 through 10", () => {
    const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
    render(
      <ReviewLaunchDialog
        kind="looped"
        open
        onOpenChange={() => undefined}
        defaultTabType="codex"
        catalog={catalog}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Configure looped code review" })).toBeTruthy();
    const allowance = screen.getByRole("combobox", {
      name: "Initial review-pass allowance",
    });
    expect(allowance.textContent).toContain("6");

    expect(screen.getAllByRole("option", { name: /pass/ })).toHaveLength(10);
    fireEvent.click(screen.getByRole("option", { name: /^10 passes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start looped review" }));

    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "codex",
      model: "codex-a",
      reasoningEffort: undefined,
      passAllowance: 10,
    });
  });

  test("disables dismissal, the picker, and submission while a launch is busy", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const { onConfirm } = renderDialog({
      kind: "looped",
      busy: true,
      onOpenChange,
    });

    const startButton = screen.getByRole("button", { name: "Starting looped review…" });
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect((startButton as HTMLButtonElement).disabled).toBe(true);
    expect((cancelButton as HTMLButtonElement).disabled).toBe(true);
    // The picker is a real button, so the disabled fieldset covers it too.
    expect(picker().closest("fieldset")?.disabled).toBe(true);
    expect(startButton.closest("form")?.getAttribute("aria-busy")).toBe("true");

    fireEvent.submit(startButton.closest("form")!);
    fireEvent.click(cancelButton);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("changes provider, model, and compatible effort together", () => {
    const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude"
        catalog={catalog}
        preferredModels={{ codex: "codex-a" }}
        preferredReasoningEfforts={{ codex: "high" }}
        onConfirm={onConfirm}
      />,
    );

    chooseProvider("codex");
    expect(picker().textContent).toContain("Codex A");
    expect(picker().textContent).toContain("High");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "codex",
      model: "codex-a",
      reasoningEffort: "high",
    });
  });

  test("picks another provider's model directly, without switching provider first", () => {
    const { onConfirm } = renderDialog({
      preferredReasoningEfforts: { codex: "medium" },
    });

    chooseModel(/Codex A/, "codex");

    // Provider, model and effort all move in one commit, so the effort is
    // resolved against Codex's catalog rather than Claude's.
    expect(picker().textContent).toContain("Codex A");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "codex",
      model: "codex-a",
      reasoningEffort: "medium",
    });
  });

  test("keeps the picker trigger sized like the other review controls", () => {
    renderDialog();

    const classes = picker().className.split(/\s+/);
    expect(classes).toContain("min-h-11");
    expect(classes).toContain("py-2.5");
    expect(classes).toContain("w-full");
    expect(picker().textContent).toContain("Claude A");
  });

  test("manually changes reasoning effort and submits the selection", () => {
    const { onConfirm } = renderDialog();

    chooseReasoning(/^High$/);

    expect(picker().textContent).toContain("High");
    expect(screen.getByText(/Claude Native · Claude A · high effort · one pass/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-a",
      reasoningEffort: "high",
    });
  });

  test("spells xhigh out rather than showing the wire value", () => {
    const { onConfirm } = renderDialog();

    chooseModel(/Claude B/);

    // "Xhigh" is what a naive capitalisation would produce; the provider still
    // has to be sent the raw value.
    openPicker();
    expect(reasoningItems().getByRole("menuitemradio", { name: "Extra high" })).toBeTruthy();
    expect(reasoningItems().queryByRole("menuitemradio", { name: "Xhigh" })).toBeNull();

    fireEvent.click(reasoningItems().getByRole("menuitemradio", { name: "Extra high" }));
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-b",
      reasoningEffort: "xhigh",
    });
  });

  test("restores a preferred effort when a model that offers it is chosen", () => {
    const { onConfirm } = renderDialog({
      preferredModels: { claude: "claude-a" },
      preferredReasoningEfforts: { claude: "xhigh" },
    });

    // Claude A does not offer the preferred effort, so it starts at default.
    expect(picker().textContent).toContain("Default");

    chooseModel(/Claude B/);

    // Claude B does. Leaving it on default here would quietly downgrade the run
    // the user configured a preference for.
    expect(picker().textContent).toContain("Extra high");
    expect(screen.getByText(/Claude Native · Claude B · xhigh effort · one pass/))
      .toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-b",
      reasoningEffort: "xhigh",
    });
  });

  test("applies the OpenCode preferences when OpenCode is chosen", () => {
    const { onConfirm } = renderDialog({
      preferredModels: { opencode: "provider/model-a" },
      preferredReasoningEfforts: { opencode: "deep" },
    });

    chooseProvider("opencode");

    expect(picker().textContent).toContain("OpenCode A");
    expect(picker().textContent).toContain("Deep");
    expect(screen.getByText(/OpenCode Native · OpenCode A · deep effort · one pass/))
      .toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    // The preferences are per provider, so switching must read OpenCode's own
    // rather than carrying Claude's forward or falling back to a default.
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "opencode",
      model: "provider/model-a",
      reasoningEffort: "deep",
    });
  });

  test("orders models favourites-first for every provider, not only OpenCode", () => {
    renderDialog({
      catalog: openCodeCatalog,
      preferredModels: { opencode: "provider/model-a" },
    });

    chooseProvider("opencode");
    openPicker();

    fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
    expect(modelItem(/OpenCode A/)).toBeTruthy();
    expect(models().queryByRole("menuitemradio", { name: /OpenCode B/ })).toBeNull();
    showProviderModels("opencode");
    expect(modelItem(/OpenCode B/)).toBeTruthy();
  });

  test("orders models favourites-first in the looped dialog too", () => {
    const config = useConfigStore.getState().config;
    useConfigStore.setState({
      config: {
        ...config,
        global: {
          ...config.global,
          favoriteModels: [{ platform: "opencode", modelId: "other/model-b" }],
        },
      },
    });
    renderDialog({
      kind: "looped",
      catalog: openCodeCatalog,
      preferredModels: { opencode: "provider/model-a" },
    });

    chooseProvider("opencode");
    openPicker();

    fireEvent.click(screen.getByRole("button", { name: "Favorite models" }));
    expect(modelItem(/OpenCode B/)).toBeTruthy();
    expect(models().queryByRole("menuitemradio", { name: /OpenCode A/ })).toBeNull();
  });

  test("closes without launching when cancelled", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const { onConfirm } = renderDialog({ onOpenChange });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("ReviewLaunchDialog step markers", () => {
  /** The header badge plus one marker per step, all `size-8` containers. */
  function iconBadges(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>('[class~="size-8"]'));
  }

  test("renders every icon badge as an identically shaped, non-shrinking circle", () => {
    const { container } = renderDialog({ kind: "looped" });

    const badges = iconBadges(container);
    // One header badge + two steps (looped adds the pass-allowance step).
    expect(badges).toHaveLength(3);
    for (const badge of badges) {
      expect(badge.className).toContain("rounded-full");
      // Without shrink-0 a flex sibling can squash the circle into an ellipse.
      expect(badge.className).toContain("shrink-0");
      expect(badge.className).toContain("place-items-center");
    }
  });

  test("sizes every badge glyph consistently", () => {
    const { container } = renderDialog({ kind: "looped" });

    const glyphs = iconBadges(container).map((badge) => badge.querySelector("svg"));
    expect(glyphs).toHaveLength(3);
    for (const glyph of glyphs) {
      expect(glyph).not.toBeNull();
      expect(glyph!.getAttribute("class")).toContain("size-4");
    }
  });

  test("drops the second step and its connector for a one-pass review", () => {
    const { container } = renderDialog();

    // Steps are decorative, so they are hidden from the accessibility tree.
    for (const badge of iconBadges(container).slice(1)) {
      expect(badge.closest("[aria-hidden]")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(iconBadges(container)).toHaveLength(2);
    // A single step has nothing to connect to.
    expect(container.querySelectorAll('[class~="bg-gradient-to-b"]')).toHaveLength(0);
  });

  test("connects both steps for a looped review", () => {
    const { container } = renderDialog({ kind: "looped" });

    expect(container.querySelectorAll('[class~="bg-gradient-to-b"]')).toHaveLength(1);
  });
});

describe("ReviewLaunchDialog reopen behaviour", () => {
  test("configures itself on a first open, not only on a reopen", () => {
    // Mounted closed is the real lifecycle: the dialog lives in the toolbar and
    // is rendered long before it is opened, so the false -> true edge is the
    // only one that ever runs for most users.
    const { onConfirm, props, rerender } = renderDialog({
      open: false,
      preferredModels: { claude: "claude-b" },
      preferredReasoningEfforts: { claude: "xhigh" },
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(<ReviewLaunchDialog {...props} open />);

    expect(picker().textContent).toContain("Claude B");
    expect(picker().textContent).toContain("Extra high");

    // And a cold-mounted dialog still resets what the user changed in it.
    chooseProvider("codex");
    expect(picker().textContent).toContain("Codex A");
    rerender(<ReviewLaunchDialog {...props} open={false} />);
    rerender(<ReviewLaunchDialog {...props} open />);

    expect(picker().textContent).toContain("Claude B");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-b",
      reasoningEffort: "xhigh",
    });
  });

  test("resets the selection when it is reopened", () => {
    const { props, rerender } = renderDialog({
      preferredModels: { claude: "claude-a" },
    });

    chooseModel(/Codex A/, "codex");
    expect(picker().textContent).toContain("Codex A");

    rerender(<ReviewLaunchDialog {...props} open={false} />);
    rerender(<ReviewLaunchDialog {...props} open />);

    expect(picker().textContent).toContain("Claude A");
    expect(picker().textContent).toContain("Default");
  });

  test("resets the pass allowance when it is reopened", () => {
    const { props, rerender } = renderDialog({ kind: "looped" });

    fireEvent.click(screen.getByRole("option", { name: /^10 passes/ }));
    expect(
      screen.getByRole("combobox", { name: "Initial review-pass allowance" }).textContent,
    ).toContain("10");

    rerender(<ReviewLaunchDialog {...props} open={false} />);
    rerender(<ReviewLaunchDialog {...props} open />);

    expect(
      screen.getByRole("combobox", { name: "Initial review-pass allowance" }).textContent,
    ).toContain("6");
  });

  test("keeps an in-progress selection when the catalog is refreshed while open", () => {
    const { props, rerender } = renderDialog();

    chooseProvider("codex");
    expect(picker().textContent).toContain("Codex A");

    // A parent re-render hands down an equal but fresh catalog object, which
    // changes the effect's dependencies without the dialog having reopened.
    rerender(
      <ReviewLaunchDialog {...props} catalog={structuredClone(catalog)} />,
    );

    expect(picker().textContent).toContain("Codex A");
  });

  test("falls back to the first model when a refreshed catalog drops the selected one", () => {
    const { onConfirm, props, rerender } = renderDialog({
      preferredModels: { claude: "claude-b" },
    });
    expect(picker().textContent).toContain("Claude B");

    rerender(
      <ReviewLaunchDialog
        {...props}
        catalog={{ ...catalog, claude: [catalog.claude[0]!] }}
      />,
    );

    expect(picker().textContent).toContain("Claude A");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-a",
      reasoningEffort: undefined,
    });
  });

  test("drops an effort removed by a refreshed catalog before submitting", () => {
    const { onConfirm, props, rerender } = renderDialog({
      preferredModels: { claude: "claude-a" },
      preferredReasoningEfforts: { claude: "high" },
    });
    expect(picker().textContent).toContain("High");

    rerender(
      <ReviewLaunchDialog
        {...props}
        catalog={{
          ...catalog,
          claude: [
            {
              ...catalog.claude[0]!,
              reasoningEfforts: ["low"],
            },
            catalog.claude[1]!,
          ],
        }}
      />,
    );

    expect(picker().textContent).toContain("Default");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-a",
      reasoningEffort: undefined,
    });
  });
});

describe("ReviewLaunchDialog degraded catalogs", () => {
  test("hides the reasoning column for a model that has none", () => {
    const { onConfirm } = renderDialog({ catalog: sparseCatalog });

    chooseModel(/Claude Fixed/);

    expect(screen.getByText("This model uses its default reasoning setting.")).toBeTruthy();
    openPicker();
    expect(screen.queryByRole("group", { name: "Reasoning" })).toBeNull();
    closePicker();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-fixed",
      reasoningEffort: undefined,
    });
  });

  test("drops an incompatible effort when switching to a model without it", () => {
    const { onConfirm } = renderDialog({
      catalog: sparseCatalog,
      preferredModels: { claude: "claude-a" },
      preferredReasoningEfforts: { claude: "high" },
    });
    expect(picker().textContent).toContain("High");

    chooseModel(/Claude Fixed/);

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-fixed",
      reasoningEffort: undefined,
    });
  });

  test("stays usable when a provider has no models at all", () => {
    const { onConfirm } = renderDialog({ catalog: sparseCatalog });

    chooseProvider("opencode");

    expect(picker().textContent).toContain("Choose a model");
    expect(screen.getByText("This model uses its default reasoning setting.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "opencode",
      model: "default",
      reasoningEffort: undefined,
    });
  });

  test("ignores a preferred model that is not in the catalog", () => {
    const { onConfirm } = renderDialog({
      preferredModels: { claude: "claude-retired" },
      preferredReasoningEfforts: { claude: "nonsense" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude",
      model: "claude-a",
      reasoningEffort: undefined,
    });
  });
});

/**
 * The picker lays its choices out as three desktop columns or as mobile
 * drill-in views, and the dialog is a phone surface too, so the mobile route to
 * a provider, a model and an effort needs its own coverage.
 */
describe("ReviewLaunchDialog on a phone", () => {
  test("chooses provider, model and reasoning through the mobile views", async () => {
    setViewport(true);
    const { onConfirm } = renderDialog({
      preferredReasoningEfforts: { codex: "medium" },
    });

    openPicker();
    expect(screen.getByRole("group", { name: "Agent platforms" })).toBeTruthy();
    // Desktop's side-by-side columns do not exist here.
    expect(screen.queryByRole("group", { name: "Models" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex A/ }));
    expect(picker().textContent).toContain("Codex A");
    expect(picker().textContent).toContain("Medium");

    // Reasoning is behind a drill-in view rather than a visible column.
    openPicker();
    fireEvent.click(document.querySelector<HTMLElement>(
      "[data-native-mobile-reasoning-trigger]",
    )!);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));

    expect(picker().textContent).toContain("High");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "codex",
      model: "codex-a",
      reasoningEffort: "high",
    });
  });

  test("omits the reasoning view for a model that has no efforts", () => {
    setViewport(true);
    renderDialog({ catalog: sparseCatalog });

    openPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude Fixed/ }));

    expect(screen.getByText("This model uses its default reasoning setting.")).toBeTruthy();
    openPicker();
    expect(document.querySelector("[data-native-mobile-reasoning-trigger]")).toBeNull();
    closePicker();
  });
});

describe("ReviewLaunchDialog summary", () => {
  test("summarises a one-pass review", () => {
    renderDialog({
      preferredModels: { claude: "claude-a" },
      preferredReasoningEfforts: { claude: "high" },
    });

    expect(screen.getByText(/Claude Native · Claude A · high effort · one pass/)).toBeTruthy();
  });

  test("summarises a looped review and tracks the pass allowance", () => {
    renderDialog({ kind: "looped" });

    expect(
      screen.getByText(/Claude Native · Claude A · default effort · 6 initial passes/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: /^3 passes/ }));
    expect(
      screen.getByText(/Claude Native · Claude A · default effort · 3 initial passes/),
    ).toBeTruthy();
  });

  test("names the provider chosen in the picker in the summary", () => {
    renderDialog();

    chooseProvider("opencode");

    expect(screen.getByText(/OpenCode Native · OpenCode A · default effort · one pass/))
      .toBeTruthy();
  });
});

test("review tab mapping is native-only", () => {
  expect(REVIEW_TAB_OPTIONS.map((option) => option.mode)).toEqual([
    "native",
    "native",
    "native",
    "native",
    "native",
  ]);
  expect(getReviewAgent("claude")).toBe("claude");
  expect(getReviewAgent("codex")).toBe("codex");
  expect(getReviewAgent("opencode")).toBe("opencode");
  expect(getReviewAgent("cursor")).toBe("cursor");
  expect(getReviewAgent("grok")).toBe("grok");
  expect(getReviewAgent("unsupported" as ReviewTabType)).toBe("claude");
});
