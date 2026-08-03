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

afterEach(cleanup);
afterAll(() => {
  mock.module("@/components/ui/dialog", () => realDialogSnapshot);
  mock.module("@/components/ui/select", () => realSelectSnapshot);
});

const catalog: ReviewModelCatalog = {
  claude: [
    { id: "claude-a", name: "Claude A", reasoningEfforts: ["low", "high"] },
    { id: "claude-b", name: "Claude B", reasoningEfforts: ["xhigh"] },
  ],
  codex: [
    { id: "codex-a", name: "Codex A", reasoningEfforts: ["medium", "high"] },
  ],
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

function renderDialog(overrides: Partial<Parameters<typeof ReviewLaunchDialog>[0]> = {}) {
  const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
  const props = {
    open: true,
    onOpenChange: () => undefined,
    defaultTabType: "claude-native" as const,
    catalog,
    onConfirm,
    ...overrides,
  };
  return { onConfirm, props, ...render(<ReviewLaunchDialog {...props} />) };
}

describe("ReviewLaunchDialog", () => {
  test("offers only native providers and confirms a one-pass review", () => {
    const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
    render(
      <ReviewLaunchDialog
        open
        onOpenChange={() => undefined}
        defaultTabType="claude-native"
        catalog={catalog}
        preferredModels={{ claude: "claude-b" }}
        preferredReasoningEfforts={{ claude: "xhigh" }}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Configure code review" })).toBeTruthy();
    expect(
      within(screen.getByRole("radiogroup", { name: "Review provider" }))
        .getAllByRole("radio"),
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
      model: "claude-b",
      reasoningEffort: "xhigh",
    });
  });

  test("configures looped review with allowance 6 by default and supports 1 through 10", () => {
    const onConfirm = mock((_selection: ReviewLaunchSelection) => undefined);
    render(
      <ReviewLaunchDialog
        kind="looped"
        open
        onOpenChange={() => undefined}
        defaultTabType="codex-native"
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
      tabType: "codex-native",
      model: "codex-a",
      reasoningEffort: undefined,
      passAllowance: 10,
    });
  });

  test("disables dismissal and submission while a launch is busy", () => {
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
        defaultTabType="claude-native"
        catalog={catalog}
        preferredModels={{ codex: "codex-a" }}
        preferredReasoningEfforts={{ codex: "high" }}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /^Codex/ }));
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Codex A");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent).toContain("high");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "codex-native",
      model: "codex-a",
      reasoningEffort: "high",
    });
  });

  test("lets a described model trigger grow beyond its minimum height", () => {
    renderDialog({
      catalog: {
        ...catalog,
        claude: [
          {
            ...catalog.claude[0]!,
            description: "Balanced reviews for everyday code changes",
          },
        ],
      },
    });

    const trigger = screen.getByRole("combobox", { name: "Model" });
    const classes = trigger.className.split(/\s+/);
    expect(classes).toContain("min-h-11");
    expect(classes).toContain("py-2.5");
    expect(classes).toContain("data-[size=default]:h-auto");
    expect(classes).not.toContain("h-11");
    expect(trigger.textContent).toContain("Claude A");
    expect(trigger.textContent).toContain("Balanced reviews for everyday code changes");
  });

  test("manually changes reasoning effort and submits the selection", () => {
    const { onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole("option", { name: "High" }));

    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent)
      .toContain("high");
    expect(screen.getByText(/Claude Native · Claude A · high effort · one pass/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
      model: "claude-a",
      reasoningEffort: "high",
    });
  });

  test("spells xhigh out rather than showing the wire value", () => {
    const { onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole("option", { name: /Claude B/ }));

    // "Xhigh" is what a naive capitalisation would produce; the provider still
    // has to be sent the raw value.
    expect(screen.getByRole("option", { name: "Extra high" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Xhigh" })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: "Extra high" }));
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
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
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent)
      .toContain("default");

    fireEvent.click(screen.getByRole("option", { name: /Claude B/ }));

    // Claude B does. Leaving it on default here would quietly downgrade the run
    // the user configured a preference for.
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent)
      .toContain("xhigh");
    expect(screen.getByText(/Claude Native · Claude B · xhigh effort · one pass/))
      .toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
      model: "claude-b",
      reasoningEffort: "xhigh",
    });
  });

  test("applies the OpenCode preferences when OpenCode is chosen", () => {
    const { onConfirm } = renderDialog({
      preferredModels: { opencode: "provider/model-a" },
      preferredReasoningEfforts: { opencode: "deep" },
    });

    fireEvent.click(screen.getByRole("radio", { name: /^OpenCode/ }));

    expect(screen.getByRole("combobox", { name: "Model" }).textContent)
      .toContain("OpenCode A");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent)
      .toContain("deep");
    expect(screen.getByText(/OpenCode Native · OpenCode A · deep effort · one pass/))
      .toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    // The preferences are per provider, so switching must read OpenCode's own
    // rather than carrying Claude's forward or falling back to a default.
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "opencode-native",
      model: "provider/model-a",
      reasoningEffort: "deep",
    });
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
    // One header badge + four steps (looped adds the pass-allowance step).
    expect(badges).toHaveLength(5);
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
    expect(glyphs).toHaveLength(5);
    for (const glyph of glyphs) {
      expect(glyph).not.toBeNull();
      expect(glyph!.getAttribute("class")).toContain("size-4");
    }
  });

  test("drops the fourth step and its connector for a one-pass review", () => {
    const { container } = renderDialog();

    // Steps are decorative, so they are hidden from the accessibility tree.
    for (const badge of iconBadges(container).slice(1)) {
      expect(badge.closest("[aria-hidden]")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(iconBadges(container)).toHaveLength(4);
    // Three steps, connected between each pair: the last step has no connector.
    expect(container.querySelectorAll('[class~="bg-gradient-to-b"]')).toHaveLength(2);
  });

  test("connects all four steps for a looped review", () => {
    const { container } = renderDialog({ kind: "looped" });

    expect(container.querySelectorAll('[class~="bg-gradient-to-b"]')).toHaveLength(3);
  });

  test("captions every provider card with its own description", () => {
    renderDialog();

    const cards = screen.getAllByRole("radio")
      .map((radio) => radio.parentElement!.querySelector("label")!);
    expect(cards).toHaveLength(REVIEW_TAB_OPTIONS.length);

    // The card is the only place the review modes are told apart, so each one
    // carries the description declared beside its tab type rather than a
    // duplicate string maintained in the group.
    REVIEW_TAB_OPTIONS.forEach((option, index) => {
      expect(option.description.length).toBeGreaterThan(0);
      expect(cards[index]!.textContent).toContain(option.description);
      expect(screen.getByText(option.description)).toBeTruthy();
    });
    expect(new Set(REVIEW_TAB_OPTIONS.map((option) => option.description)).size)
      .toBe(REVIEW_TAB_OPTIONS.length);
  });

  test("renders a distinct icon for each provider", () => {
    renderDialog();

    const icons = screen.getAllByRole("radio").map((radio) => {
      const card = radio.parentElement!.querySelector("label")!;
      const svg = card.querySelector("svg");
      expect(svg).not.toBeNull();
      return svg!.outerHTML;
    });

    expect(icons).toHaveLength(3);
    expect(new Set(icons).size).toBe(3);
  });
});

describe("ReviewLaunchDialog provider keyboard navigation", () => {
  function radios() {
    return screen.getAllByRole("radio");
  }

  function selectedModelName() {
    return screen.getByRole("combobox", { name: "Model" }).textContent;
  }

  test("moves forward with ArrowRight and ArrowDown", () => {
    renderDialog();

    // fireEvent returns false when the handler called preventDefault, which is
    // what stops the arrow key from also scrolling the dialog.
    expect(fireEvent.keyDown(radios()[0]!, { key: "ArrowRight" })).toBe(false);
    expect(selectedModelName()).toContain("Codex A");
    expect(document.activeElement).toBe(radios()[1]!);

    expect(fireEvent.keyDown(radios()[1]!, { key: "ArrowDown" })).toBe(false);
    expect(selectedModelName()).toContain("OpenCode A");
    expect(document.activeElement).toBe(radios()[2]!);
  });

  test("moves backward with ArrowLeft and ArrowUp", () => {
    renderDialog({ defaultTabType: "opencode-native" });

    expect(fireEvent.keyDown(radios()[2]!, { key: "ArrowLeft" })).toBe(false);
    expect(selectedModelName()).toContain("Codex A");

    expect(fireEvent.keyDown(radios()[1]!, { key: "ArrowUp" })).toBe(false);
    expect(selectedModelName()).toContain("Claude A");
    expect(document.activeElement).toBe(radios()[0]!);
  });

  test("wraps around both ends", () => {
    renderDialog();

    // First -> previous wraps to last.
    fireEvent.keyDown(radios()[0]!, { key: "ArrowLeft" });
    expect(selectedModelName()).toContain("OpenCode A");

    // Last -> next wraps to first.
    fireEvent.keyDown(radios()[2]!, { key: "ArrowRight" });
    expect(selectedModelName()).toContain("Claude A");
  });

  test("jumps to the ends with Home and End", () => {
    renderDialog();

    expect(fireEvent.keyDown(radios()[0]!, { key: "End" })).toBe(false);
    expect(selectedModelName()).toContain("OpenCode A");
    expect(document.activeElement).toBe(radios()[2]!);

    expect(fireEvent.keyDown(radios()[2]!, { key: "Home" })).toBe(false);
    expect(selectedModelName()).toContain("Claude A");
    expect(document.activeElement).toBe(radios()[0]!);
  });

  test("ignores every other key", () => {
    renderDialog();

    for (const key of ["a", "Enter", "Tab", "PageDown"]) {
      expect(fireEvent.keyDown(radios()[0]!, { key })).toBe(true);
      expect(selectedModelName()).toContain("Claude A");
    }
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

    expect(screen.getByRole("combobox", { name: "Model" }).textContent)
      .toContain("Claude B");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent)
      .toContain("xhigh");

    // And a cold-mounted dialog still resets what the user changed in it.
    fireEvent.click(screen.getByRole("radio", { name: /^Codex/ }));
    expect(screen.getByRole("combobox", { name: "Model" }).textContent)
      .toContain("Codex A");
    rerender(<ReviewLaunchDialog {...props} open={false} />);
    rerender(<ReviewLaunchDialog {...props} open />);

    expect(screen.getByRole("combobox", { name: "Model" }).textContent)
      .toContain("Claude B");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
      model: "claude-b",
      reasoningEffort: "xhigh",
    });
  });

  test("resets the selection when it is reopened", () => {
    const { props, rerender } = renderDialog({
      preferredModels: { claude: "claude-a" },
    });

    fireEvent.click(screen.getByRole("radio", { name: /^Codex/ }));
    fireEvent.click(screen.getByRole("option", { name: /Codex A/ }));
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Codex A");

    rerender(<ReviewLaunchDialog {...props} open={false} />);
    rerender(<ReviewLaunchDialog {...props} open />);

    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Claude A");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent)
      .toContain("default");
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

    fireEvent.click(screen.getByRole("radio", { name: /^Codex/ }));
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Codex A");

    // A parent re-render hands down an equal but fresh catalog object, which
    // changes the effect's dependencies without the dialog having reopened.
    rerender(
      <ReviewLaunchDialog {...props} catalog={structuredClone(catalog)} />,
    );

    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Codex A");
  });

  test("falls back to the first model when a refreshed catalog drops the selected one", () => {
    const { onConfirm, props, rerender } = renderDialog({
      preferredModels: { claude: "claude-b" },
    });
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Claude B");

    rerender(
      <ReviewLaunchDialog
        {...props}
        catalog={{ ...catalog, claude: [catalog.claude[0]!] }}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Claude A");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
      model: "claude-a",
      reasoningEffort: undefined,
    });
  });

  test("drops an effort removed by a refreshed catalog before submitting", () => {
    const { onConfirm, props, rerender } = renderDialog({
      preferredModels: { claude: "claude-a" },
      preferredReasoningEfforts: { claude: "high" },
    });
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent)
      .toContain("high");

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

    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent)
      .toContain("default");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
      model: "claude-a",
      reasoningEffort: undefined,
    });
  });
});

describe("ReviewLaunchDialog degraded catalogs", () => {
  test("disables reasoning effort for a model that has none", () => {
    const { onConfirm } = renderDialog({ catalog: sparseCatalog });

    fireEvent.click(screen.getByRole("option", { name: /Claude Fixed/ }));

    const effort = screen.getByRole("combobox", { name: "Reasoning effort" });
    expect(effort.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("This model uses its default reasoning setting.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
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
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent)
      .toContain("high");

    fireEvent.click(screen.getByRole("option", { name: /Claude Fixed/ }));

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "claude-native",
      model: "claude-fixed",
      reasoningEffort: undefined,
    });
  });

  test("stays usable when a provider has no models at all", () => {
    const { onConfirm } = renderDialog({ catalog: sparseCatalog });

    fireEvent.click(screen.getByRole("radio", { name: /^OpenCode/ }));

    expect(screen.getByRole("combobox", { name: "Model" }).textContent)
      .toContain("Choose a model");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).hasAttribute("disabled"))
      .toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledWith({
      tabType: "opencode-native",
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
      tabType: "claude-native",
      model: "claude-a",
      reasoningEffort: undefined,
    });
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

  test("names the provider chosen by keyboard in the summary", () => {
    renderDialog();

    fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "End" });

    expect(screen.getByText(/OpenCode Native · OpenCode A · default effort · one pass/))
      .toBeTruthy();
  });
});

test("review tab mapping is native-only", () => {
  expect(REVIEW_TAB_OPTIONS.map((option) => option.mode)).toEqual([
    "native",
    "native",
    "native",
  ]);
  expect(getReviewAgent("claude-native")).toBe("claude");
  expect(getReviewAgent("codex-native")).toBe("codex");
  expect(getReviewAgent("opencode-native")).toBe("opencode");
  expect(getReviewAgent("unsupported" as ReviewTabType)).toBe("claude");
});
