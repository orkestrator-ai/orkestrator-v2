import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import * as realContexts from "@/contexts";
import * as realStores from "@/stores";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";

const realContextsSnapshot = { ...realContexts };
const realStoresSnapshot = { ...realStores };
const createFileTabMock = mock((_path: string) => undefined);
let client: FakeNodeClient;

let selectedEnvironment: {
  id: string;
  containerId: string | null;
  worktreePath?: string | null;
} | null = {
  id: "env-1",
  containerId: "container-1",
  worktreePath: null,
};
mock.module("@/stores", () => ({
  ...realStoresSnapshot,
  useUIStore: <T,>(selector: (state: { selectedEnvironmentId: string | null }) => T) =>
    selector({ selectedEnvironmentId: selectedEnvironment?.id ?? null }),
  useEnvironmentStore: <T,>(
    selector: (state: {
      environments: typeof selectedEnvironment extends null
        ? never[]
        : Array<NonNullable<typeof selectedEnvironment>>;
    }) => T,
  ) =>
    selector({
      environments: selectedEnvironment ? [selectedEnvironment] : [],
    }),
}));

mock.module("@/contexts", () => ({
  ...realContextsSnapshot,
  useTerminalContext: () => ({ createFileTab: createFileTabMock }),
}));

const { OpenFileDialog } = await import("./OpenFileDialog");

afterAll(() => {
  mock.module("@/stores", () => realStoresSnapshot);
  mock.module("@/contexts", () => realContextsSnapshot);
});

describe("OpenFileDialog", () => {
  beforeEach(() => {
    selectedEnvironment = {
      id: "env-1",
      containerId: "container-1",
      worktreePath: null,
    };
    client = new FakeNodeClient({
      invoke: {
        get_file_tree: [
          {
            name: "src",
            path: "src",
            isDirectory: true,
            children: [
              { name: "App.tsx", path: "src/App.tsx", isDirectory: false },
              { name: "index.ts", path: "src/index.ts", isDirectory: false },
            ],
          },
        ],
      },
    });
    createFileTabMock.mockClear();
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {};
    }
  });

  afterEach(cleanupNodeScopes);

  test("keeps mobile and sm viewport gutters while capping the dialog at 42rem", async () => {
    renderInNodeScope(<OpenFileDialog />, { client });
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Open file" });
    expect(dialog.classList.contains("max-w-(--modal-limit)")).toBe(true);
    expect(dialog.classList.contains("[--modal-max-width:42rem]")).toBe(true);
    expect(
      dialog.classList.contains("sm:[--modal-limit:min(var(--modal-max-width),calc(100%-2rem))]"),
    ).toBe(true);
  });

  test("reads independently once per opening and opens the current keyboard selection", async () => {
    renderInNodeScope(<OpenFileDialog />, { client });
    expect(client.calls("get_file_tree")).toHaveLength(0);
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });

    expect(await screen.findByText("index.ts")).toBeTruthy();
    expect(client.calls("get_file_tree").map((call) => call.args)).toEqual([
      { containerId: "container-1" },
    ]);
    expect(screen.queryByText("src", { selector: ".font-medium" }) === null).toBe(true);
    const input = screen.getByRole("textbox", { name: "Search files" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(createFileTabMock).toHaveBeenCalledWith("src/index.ts");
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(client.calls("get_file_tree")).toHaveLength(1);

    client.respond("get_file_tree", [{ name: "new.ts", path: "src/new.ts", isDirectory: false }]);
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    expect(await screen.findByText("new.ts")).toBeTruthy();
    expect(screen.queryByText("index.ts") === null).toBe(true);
    expect(client.calls("get_file_tree").map((call) => call.args)).toEqual([
      { containerId: "container-1" },
      { containerId: "container-1" },
    ]);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search files" }), { key: "Enter" });
    expect(createFileTabMock).toHaveBeenLastCalledWith("src/new.ts");
  });

  test("reports missing and unavailable environments without opening files", async () => {
    selectedEnvironment = null;
    const { unmount } = renderInNodeScope(<OpenFileDialog />, { client });
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    expect(await screen.findByText("Select an environment to open files.")).toBeTruthy();
    unmount();

    selectedEnvironment = {
      id: "env-1",
      containerId: null,
      worktreePath: null,
    };
    renderInNodeScope(<OpenFileDialog />, { client });
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    expect(
      await screen.findByText("Start the selected environment to search its files."),
    ).toBeTruthy();
    expect(createFileTabMock).not.toHaveBeenCalled();
  });

  test("shows search errors and ignores shortcuts with extra modifiers", async () => {
    client.respond("get_file_tree", () => {
      throw new Error("Workspace scan failed");
    });
    renderInNodeScope(<OpenFileDialog />, { client });
    fireEvent.keyDown(window, {
      key: "p",
      metaKey: true,
      shiftKey: true,
      altKey: true,
    });
    expect(screen.queryByRole("dialog") === null).toBe(true);

    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    expect(await screen.findByText("Workspace scan failed")).toBeTruthy();
  });
});
