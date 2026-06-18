import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalProvider } from "../../../src/contexts/TerminalContext";
import { useFilesPanelStore } from "../../../src/stores/filesPanelStore";
import type { GitFileChange } from "../../../src/lib/tauri";
import * as realHooks from "@/hooks";

const realHooksSnapshot = { ...realHooks };
const refreshMock = mock(() => {});

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useFilesPanel: () => ({
    refresh: refreshMock,
    loadChanges: mock(() => {}),
    loadFileTree: mock(() => {}),
    isAvailable: true,
    containerId: "container-1",
    worktreePath: null,
    isLocalEnvironment: false,
  }),
}));

const { ChangedFileItem } = await import("../../../src/components/files-panel/ChangedFileItem");
const { FilesPanelHeader } = await import("../../../src/components/files-panel/FilesPanelHeader");
const { FilesPanel } = await import("../../../src/components/files-panel/FilesPanel");

const change: GitFileChange = {
  path: "src/components/Button.tsx",
  filename: "Button.tsx",
  directory: "src/components",
  additions: 12,
  deletions: 3,
  status: "M",
};

describe("Files panel components", () => {
  afterEach(() => {
    cleanup();
    refreshMock.mockClear();
    useFilesPanelStore.setState({
      isOpen: false,
      activeTab: "changes",
      changes: [],
      isLoadingChanges: false,
      fileTree: [],
      isLoadingTree: false,
    });
  });

  afterAll(() => {
    mock.module("@/hooks", () => realHooksSnapshot);
  });

  test("ChangedFileItem renders directory, filename, stats, and click target", () => {
    const onClick = mock(() => {});
    render(<ChangedFileItem change={change} onClick={onClick} />);

    expect(screen.getByText("src/components/")).toBeTruthy();
    expect(screen.getByText("Button.tsx")).toBeTruthy();
    expect(screen.getByText("+12").className).toContain("text-green-500");
    expect(screen.getByText("-3").className).toContain("text-red-400");

    fireEvent.click(screen.getByTitle("src/components/Button.tsx"));
    expect(onClick).toHaveBeenCalledWith("src/components/Button.tsx");
  });

  test("FilesPanelHeader shows changed count and refresh loading state", () => {
    useFilesPanelStore.setState({
      activeTab: "changes",
      changes: [change],
      isLoadingChanges: true,
      isLoadingTree: false,
    });

    render(<FilesPanelHeader />);

    expect(screen.getByText("1")).toBeTruthy();
    const refreshButton = screen.getAllByRole("button").find((button) =>
      button.querySelector(".animate-spin"),
    ) as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(true);
  });

  test("FilesPanel renders the panel surface and switches between tab views", () => {
    useFilesPanelStore.setState({
      activeTab: "all-files",
      fileTree: [],
      changes: [change],
    });

    const { container, rerender } = render(
      <TerminalProvider>
        <FilesPanel />
      </TerminalProvider>,
    );

    expect(container.firstElementChild?.className).toContain("bg-zinc-900");
    expect(screen.getByText("No files found")).toBeTruthy();

    useFilesPanelStore.setState({ activeTab: "changes" });
    rerender(
      <TerminalProvider>
        <FilesPanel />
      </TerminalProvider>,
    );
    expect(screen.getByText("src/components/")).toBeTruthy();
  });
});
