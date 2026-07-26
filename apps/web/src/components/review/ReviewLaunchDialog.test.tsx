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
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <SelectTestContext.Provider value={{ value, onValueChange }}>
      <div>{children}</div>
    </SelectTestContext.Provider>
  ),
  SelectTrigger: ({
    id,
    children,
    disabled,
  }: {
    id?: string;
    children: React.ReactNode;
    disabled?: boolean;
  }) => <button id={id} type="button" role="combobox" disabled={disabled}>{children}</button>,
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
});
