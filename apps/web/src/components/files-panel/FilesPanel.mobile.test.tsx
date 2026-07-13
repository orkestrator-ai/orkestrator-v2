import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { TerminalProvider, useTerminalContext, type CreateFileTabOptions } from "@/contexts";
import { useFilesPanelStore } from "@/stores";
import { AllFilesView } from "./AllFilesView";
import { ChangesView } from "./ChangesView";

const originalMatchMedia = window.matchMedia;

function setMobileViewport(matches: boolean) {
  window.matchMedia = (query) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  });
}

function FileTabRegistrar({
  createFileTab,
}: {
  createFileTab: (path: string, options?: CreateFileTabOptions) => void;
}) {
  const { setCreateFileTab } = useTerminalContext();

  useEffect(() => {
    setCreateFileTab(createFileTab);
    return () => setCreateFileTab(null);
  }, [createFileTab, setCreateFileTab]);

  return null;
}

function renderWithFileTabs(
  children: ReactNode,
  createFileTab: (path: string, options?: CreateFileTabOptions) => void,
) {
  return render(
    <TerminalProvider>
      <FileTabRegistrar createFileTab={createFileTab} />
      {children}
    </TerminalProvider>,
  );
}

function renderWithoutFileTabs(children: ReactNode) {
  return render(<TerminalProvider>{children}</TerminalProvider>);
}

beforeEach(() => {
  useFilesPanelStore.setState({
    isOpen: true,
    fileTree: [{ name: "App.tsx", path: "src/App.tsx", isDirectory: false }],
    isLoadingTree: false,
    changes: [{
      path: "src/App.tsx",
      filename: "App.tsx",
      directory: "src",
      additions: 2,
      deletions: 1,
      status: "M",
    }],
    isLoadingChanges: false,
  });
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

describe("mobile files panel", () => {
  test("closes after opening a file from the file tree on mobile", () => {
    setMobileViewport(true);
    const createFileTab = mock(() => undefined);
    renderWithFileTabs(<AllFilesView />, createFileTab);

    fireEvent.click(screen.getByRole("button", { name: "App.tsx" }));

    expect(createFileTab).toHaveBeenCalledWith("src/App.tsx");
    expect(useFilesPanelStore.getState().isOpen).toBe(false);
  });

  test("closes after opening a diff from Changes on mobile", () => {
    setMobileViewport(true);
    const createFileTab = mock(() => undefined);
    renderWithFileTabs(<ChangesView />, createFileTab);

    fireEvent.click(screen.getByTitle("src/App.tsx"));

    expect(createFileTab).toHaveBeenCalledWith("src/App.tsx", {
      isDiff: true,
      gitStatus: "M",
    });
    expect(useFilesPanelStore.getState().isOpen).toBe(false);
  });

  test("keeps the files panel open after opening a file on desktop", () => {
    setMobileViewport(false);
    const createFileTab = mock(() => undefined);
    renderWithFileTabs(<AllFilesView />, createFileTab);

    fireEvent.click(screen.getByRole("button", { name: "App.tsx" }));

    expect(createFileTab).toHaveBeenCalledWith("src/App.tsx");
    expect(useFilesPanelStore.getState().isOpen).toBe(true);
  });

  test("keeps the files panel open after opening a diff on desktop", () => {
    setMobileViewport(false);
    const createFileTab = mock(() => undefined);
    renderWithFileTabs(<ChangesView />, createFileTab);

    fireEvent.click(screen.getByTitle("src/App.tsx"));

    expect(createFileTab).toHaveBeenCalledWith("src/App.tsx", {
      isDiff: true,
      gitStatus: "M",
    });
    expect(useFilesPanelStore.getState().isOpen).toBe(true);
  });

  test("does not close when no file-tab handler is registered", () => {
    setMobileViewport(true);
    renderWithoutFileTabs(
      <>
        <AllFilesView />
        <ChangesView />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "App.tsx" }));
    fireEvent.click(screen.getByTitle("src/App.tsx"));

    expect(useFilesPanelStore.getState().isOpen).toBe(true);
  });

  test("renders loading states for both views", () => {
    useFilesPanelStore.setState({ isLoadingTree: true, isLoadingChanges: true });
    renderWithoutFileTabs(
      <>
        <AllFilesView />
        <ChangesView />
      </>,
    );

    expect(screen.getByText("Loading files...")).toBeTruthy();
    expect(screen.getByText("Loading changes...")).toBeTruthy();
  });

  test("renders empty states for both views", () => {
    useFilesPanelStore.setState({
      fileTree: [],
      changes: [],
      isLoadingTree: false,
      isLoadingChanges: false,
    });
    renderWithoutFileTabs(
      <>
        <AllFilesView />
        <ChangesView />
      </>,
    );

    expect(screen.getByText("No files found")).toBeTruthy();
    expect(screen.getByText("No changes")).toBeTruthy();
  });
});
