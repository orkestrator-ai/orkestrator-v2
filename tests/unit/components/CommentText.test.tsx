import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CommentText } from "@/components/kanban/KanbanTaskDialog";
import { uiStore } from "@/stores/uiStore";
import { filesPanelTestState, setFilesPanelTestState } from "@/test/files-panel-state";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { appCommandStore } from "../../../apps/web/src/test/app-command-store";

// `openInBrowser` reaches the browser through the desktop shell; stand in for it.
const mockOpenInBrowser = mock((_url: string) => Promise.resolve());
const originalOrkestrator = window.orkestrator;

describe("CommentText", () => {
  beforeEach(() => {
    cleanup();
    mockOpenInBrowser.mockClear();
    window.orkestrator = {
      ...originalOrkestrator,
      shell: { ...originalOrkestrator?.shell, openExternal: mockOpenInBrowser },
    } as never;
    appCommandStore(uiStore).setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });
    setFilesPanelTestState({ isOpen: false, activeTab: "changes", pullRequestTabs: {} });
  });

  afterEach(() => {
    window.orkestrator = originalOrkestrator;
  });

  test("renders plain text without links", () => {
    render(<CommentText text="Build started" />);
    expect(screen.getByText("Build started")).toBeTruthy();
    expect(screen.queryByRole("button") === null).toBe(true);
  });

  test("renders a single URL as a clickable button", () => {
    render(<CommentText text="PR raised: https://github.com/org/repo/pull/42" />);
    const button = screen.getByRole("button");
    expect(button).toBeTruthy();
    expect(button.textContent).toBe("https://github.com/org/repo/pull/42");
  });

  test("renders text before and after URL", () => {
    const { container } = render(<CommentText text="See https://example.com for details" />);
    const spans = container.querySelectorAll("span");
    expect(spans[0]!.textContent).toBe("See ");
    expect(screen.getByRole("button").textContent).toBe("https://example.com");
    expect(spans[1]!.textContent).toBe(" for details");
  });

  test("renders multiple URLs correctly", () => {
    render(<CommentText text="Link1: https://a.com and link2: https://b.com end" />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.textContent).toBe("https://a.com");
    expect(buttons[1]!.textContent).toBe("https://b.com");
  });

  test("handles URL at start of text", () => {
    render(<CommentText text="https://example.com is a link" />);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("https://example.com");
  });

  test("handles URL at end of text", () => {
    render(<CommentText text="Visit https://example.com" />);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("https://example.com");
  });

  test("handles text that is only a URL", () => {
    render(<CommentText text="https://example.com" />);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("https://example.com");
  });

  test("calls openInBrowser when URL is clicked", () => {
    render(<CommentText text="Click https://example.com here" />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(mockOpenInBrowser).toHaveBeenCalledWith("https://example.com");
  });

  test("opens a pull request link in the right-hand PR pane, leaving the view alone", () => {
    render(<CommentText text="PR raised: https://github.com/org/repo/pull/42" />);
    fireEvent.click(screen.getByRole("button"));
    expect(mockOpenInBrowser).not.toHaveBeenCalled();
    const panel = filesPanelTestState();
    expect(panel.isOpen).toBe(true);
    expect(panel.activeTab).toBe("pull-request:org/repo#42");
    expect(panel.pullRequestTabs["env-1"]?.map((tab) => tab.ref)).toEqual([
      { owner: "org", repo: "repo", number: 42 },
    ]);
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env-1");
  });

  test("Cmd-click keeps a pull request link on GitHub", () => {
    render(<CommentText text="PR raised: https://github.com/org/repo/pull/42" />);
    fireEvent.click(screen.getByRole("button"), { metaKey: true });
    expect(mockOpenInBrowser).toHaveBeenCalledWith("https://github.com/org/repo/pull/42");
    expect(useFilesPanelChromeStore.getState().isOpen).toBe(false);
  });

  test("handles http (non-https) URLs", () => {
    render(<CommentText text="Link: http://insecure.com test" />);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("http://insecure.com");
  });

  test("renders text without URLs as plain text (no spans)", () => {
    const { container } = render(<CommentText text="No links here" />);
    // When there are no URLs, CommentText returns plain text (no wrapping elements)
    expect(container.textContent).toBe("No links here");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("span")).toHaveLength(0);
  });
});
