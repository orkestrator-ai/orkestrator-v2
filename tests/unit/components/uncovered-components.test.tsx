import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextUsageWheel } from "../../../apps/web/src/components/chat/ContextUsageWheel";
import { MessageMarkdown } from "../../../apps/web/src/components/chat/MessageMarkdown";
import { CodexPlanModeCard } from "../../../apps/web/src/components/codex/CodexPlanModeCard";
import { ErrorDetailsDialog } from "../../../apps/web/src/components/errors/ErrorDetailsDialog";
import { ProjectItem } from "../../../apps/web/src/components/projects/ProjectItem";
import { useErrorDialogStore } from "../../../apps/web/src/stores/errorDialogStore";

afterEach(() => {
  cleanup();
  useErrorDialogStore.setState({ error: null });
});

describe("previously indirect component contracts", () => {
  test("ContextUsageWheel clamps usage and omits missing snapshots", () => {
    const { rerender } = render(<ContextUsageWheel usage={null} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<ContextUsageWheel usage={{ percentUsed: 150, usedTokens: 2000, totalTokens: 1000, modelId: "model" }} />);
    expect(screen.getByRole("button", { name: "Context window 100% used" })).toBeTruthy();
  });

  test("MessageMarkdown renders GFM content and permits component overrides", () => {
    const { rerender } = render(<MessageMarkdown content={"- [x] done\n\n**bold**"} />);
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    rerender(<MessageMarkdown content="custom" components={{ p: ({ children }) => <aside>{children}</aside> }} />);
    expect(screen.getByText("custom").tagName).toBe("ASIDE");
  });

  test("CodexPlanModeCard dispatches every action and locks controls while submitting", () => {
    const approve = mock(() => undefined);
    const switchMode = mock(() => undefined);
    const dismiss = mock(() => undefined);
    const { rerender } = render(
      <CodexPlanModeCard onApproveAndBuild={approve} onSwitchToBuild={switchMode} onDismiss={dismiss} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch To Build" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve Plan" }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(switchMode).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);

    rerender(<CodexPlanModeCard isSubmitting onApproveAndBuild={approve} onSwitchToBuild={switchMode} onDismiss={dismiss} />);
    expect((screen.getByRole("button", { name: "Approve Plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("ErrorDetailsDialog renders stored details and closes", () => {
    useErrorDialogStore.getState().showError("Build failed", "compiler output", "retry prompt");
    render(<ErrorDetailsDialog />);
    expect(screen.getByText("Build failed")).toBeTruthy();
    expect(screen.getByText("compiler output")).toBeTruthy();
    expect(screen.getByText("retry prompt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useErrorDialogStore.getState().error).toBeNull();
  });

  test("ProjectItem selects and confirms deletion", () => {
    const onSelect = mock(() => undefined);
    const onDelete = mock(() => undefined);
    render(<ProjectItem
      project={{ id: "project-1", name: "Project", gitUrl: "https://github.com/acme/project", localPath: null } as never}
      isSelected
      onSelect={onSelect}
      onDelete={onDelete}
    />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]!);
    expect(onSelect).toHaveBeenCalledWith("project-1");
    fireEvent.click(buttons[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("project-1");
  });
});
