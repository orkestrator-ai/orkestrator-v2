import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realContexts from "@/contexts";
import * as realStores from "@/stores";
import * as realUseFileSearch from "@/hooks/useFileSearch";
import type { FileCandidate } from "@/types";

const realContextsSnapshot = { ...realContexts };
const realStoresSnapshot = { ...realStores };
const realUseFileSearchSnapshot = { ...realUseFileSearch };
const createFileTabMock = mock((_path: string) => undefined);
const refreshMock = mock(async () => undefined);

let selectedEnvironment: {
  id: string;
  containerId: string | null;
  worktreePath?: string | null;
} | null = {
  id: "env-1",
  containerId: "container-1",
  worktreePath: null,
};
let searchResults: FileCandidate[] = [
  { filename: "src", relativePath: "src", isDirectory: true },
  { filename: "App.tsx", relativePath: "src/App.tsx", isDirectory: false },
  { filename: "index.ts", relativePath: "src/index.ts", isDirectory: false },
];
let searchError: string | null = null;
let searchAvailable = true;

mock.module("@/stores", () => ({
  ...realStoresSnapshot,
  useUIStore: <T,>(selector: (state: { selectedEnvironmentId: string | null }) => T) =>
    selector({ selectedEnvironmentId: selectedEnvironment?.id ?? null }),
  useEnvironmentStore: <T,>(selector: (state: {
    environments: typeof selectedEnvironment extends null ? never[] : Array<NonNullable<typeof selectedEnvironment>>;
  }) => T) => selector({
    environments: selectedEnvironment ? [selectedEnvironment] : [],
  }),
}));

mock.module("@/contexts", () => ({
  ...realContextsSnapshot,
  useTerminalContext: () => ({ createFileTab: createFileTabMock }),
}));

mock.module("@/hooks/useFileSearch", () => ({
  useFileSearch: () => ({
    searchFiles: () => searchResults,
    isLoading: false,
    error: searchError,
    isAvailable: searchAvailable,
    refresh: refreshMock,
  }),
}));

const { OpenFileDialog } = await import("./OpenFileDialog");

afterAll(() => {
  mock.module("@/stores", () => realStoresSnapshot);
  mock.module("@/contexts", () => realContextsSnapshot);
  mock.module("@/hooks/useFileSearch", () => realUseFileSearchSnapshot);
});

describe("OpenFileDialog", () => {
  beforeEach(() => {
    selectedEnvironment = {
      id: "env-1",
      containerId: "container-1",
      worktreePath: null,
    };
    searchResults = [
      { filename: "src", relativePath: "src", isDirectory: true },
      { filename: "App.tsx", relativePath: "src/App.tsx", isDirectory: false },
      { filename: "index.ts", relativePath: "src/index.ts", isDirectory: false },
    ];
    searchError = null;
    searchAvailable = true;
    createFileTabMock.mockClear();
    refreshMock.mockClear();
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {};
    }
  });

  afterEach(cleanup);

  test("opens from the shortcut, filters directories, and opens the keyboard selection", async () => {
    render(<OpenFileDialog />);
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });

    expect(await screen.findByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("src", { selector: ".font-medium" })).toBeNull();
    const input = screen.getByRole("textbox", { name: "Search files" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(createFileTabMock).toHaveBeenCalledWith("src/index.ts");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("reports missing and unavailable environments without opening files", async () => {
    selectedEnvironment = null;
    const { unmount } = render(<OpenFileDialog />);
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    expect(await screen.findByText("Select an environment to open files.")).toBeTruthy();
    unmount();

    selectedEnvironment = {
      id: "env-1",
      containerId: null,
      worktreePath: null,
    };
    searchAvailable = false;
    render(<OpenFileDialog />);
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    expect(await screen.findByText("Start the selected environment to search its files."))
      .toBeTruthy();
    expect(createFileTabMock).not.toHaveBeenCalled();
  });

  test("shows search errors and ignores shortcuts with extra modifiers", async () => {
    searchError = "Workspace scan failed";
    render(<OpenFileDialog />);
    fireEvent.keyDown(window, {
      key: "p",
      metaKey: true,
      shiftKey: true,
      altKey: true,
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    expect(await screen.findByText("Workspace scan failed")).toBeTruthy();
  });
});
