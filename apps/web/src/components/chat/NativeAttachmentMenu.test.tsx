import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { FileCandidate } from "@/types";
import {
  createWorkspaceAttachment,
  NativeAttachmentMenu,
  type NativeAttachmentFileSearch,
} from "./NativeAttachmentMenu";

const workspaceFiles: FileCandidate[] = [
  {
    filename: "architecture.md",
    relativePath: "docs/architecture.md",
    isDirectory: false,
    extension: ".md",
  },
  {
    filename: "screenshots",
    relativePath: "docs/screenshots",
    isDirectory: true,
  },
  {
    filename: "button.tsx",
    relativePath: "src/components/button.tsx",
    isDirectory: false,
    extension: ".tsx",
  },
];

function createFileSearch(
  overrides: Partial<NativeAttachmentFileSearch> = {},
): NativeAttachmentFileSearch {
  return {
    searchFiles: (query, limit = 30, options) =>
      workspaceFiles
        .filter((file) => !options?.filesOnly || !file.isDirectory)
        .filter((file) =>
          file.relativePath.toLowerCase().includes(query.toLowerCase()),
        )
        .slice(0, limit),
    isLoading: false,
    error: null,
    refresh: mock(() => {}),
    isAvailable: true,
    ...overrides,
  };
}

async function openFilePicker() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: "Attach file from workspace",
    }),
  );
  return screen.findByRole("dialog");
}

describe("NativeAttachmentMenu", () => {
  afterEach(cleanup);

  test("portals its menu, dismisses it, refreshes, focuses search, and returns a file", async () => {
    const onSelectFile = mock(() => {});
    const onCloseAutoFocus = mock(() => {});
    const fileSearch = createFileSearch();
    const { container } = render(
      <div data-testid="scroll-toolbar" className="overflow-x-auto">
        <NativeAttachmentMenu
          fileSearch={fileSearch}
          onSelectFile={onSelectFile}
          onCloseAutoFocus={onCloseAutoFocus}
        />
      </div>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));

    const menu = await screen.findByRole("menu");
    expect(
      container.querySelector("[data-testid=scroll-toolbar]")!.contains(menu),
    ).toBe(false);
    expect(
      screen
        .getByRole("menuitem", { name: /Paste image into the input/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Attach file from workspace" }),
    );

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(fileSearch.refresh).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Search workspace files" }),
    );
    expect(screen.queryByText("screenshots")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /architecture\.md/ }));

    await waitFor(() => {
      expect(onSelectFile).toHaveBeenCalledWith(workspaceFiles[0]);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
    });
  });

  test("passes query, cap, and files-only filtering to search", async () => {
    const searchFiles = mock<
      NativeAttachmentFileSearch["searchFiles"]
    >(() => []);
    render(
      <NativeAttachmentMenu
        fileSearch={createFileSearch({ searchFiles })}
        onSelectFile={() => {}}
      />,
    );

    await openFilePicker();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search workspace files" }),
      { target: { value: "component" } },
    );

    await waitFor(() => {
      expect(searchFiles).toHaveBeenLastCalledWith(
        "component",
        100,
        { filesOnly: true },
      );
    });
  });

  test("uses keyboard navigation with clamped bounds and Enter selection", async () => {
    const onSelectFile = mock(() => {});
    render(
      <NativeAttachmentMenu
        fileSearch={createFileSearch()}
        onSelectFile={onSelectFile}
      />,
    );

    await openFilePicker();
    const input = screen.getByRole("textbox", {
      name: "Search workspace files",
    });

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onSelectFile).toHaveBeenCalledWith(workspaceFiles[2]);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  test("scrolls the selected row into view during keyboard navigation", async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = mock(() => {});
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      render(
        <NativeAttachmentMenu
          fileSearch={createFileSearch()}
          onSelectFile={() => {}}
        />,
      );

      await openFilePicker();
      const callsBeforeNavigation = scrollIntoView.mock.calls.length;

      fireEvent.keyDown(
        screen.getByRole("textbox", { name: "Search workspace files" }),
        { key: "ArrowDown" },
      );

      await waitFor(() => {
        expect(scrollIntoView.mock.calls.length).toBeGreaterThan(
          callsBeforeNavigation,
        );
        expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
      });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test("ignores Enter and arrow keys when there are no results", async () => {
    const onSelectFile = mock(() => {});
    render(
      <NativeAttachmentMenu
        fileSearch={createFileSearch({ searchFiles: () => [] })}
        onSelectFile={onSelectFile}
      />,
    );

    await openFilePicker();
    const input = screen.getByRole("textbox", {
      name: "Search workspace files",
    });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelectFile).not.toHaveBeenCalled();
    expect(screen.getByText("No files match that search.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("resets query and selection when closed and refreshes when reopened", async () => {
    const fileSearch = createFileSearch();
    const onSelectFile = mock(() => {});
    render(
      <NativeAttachmentMenu
        fileSearch={fileSearch}
        onSelectFile={onSelectFile}
      />,
    );

    await openFilePicker();
    const input = screen.getByRole("textbox", {
      name: "Search workspace files",
    });
    fireEvent.change(input, { target: { value: "button" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openFilePicker();

    expect(
      (screen.getByRole("textbox", {
        name: "Search workspace files",
      }) as HTMLInputElement).value,
    ).toBe("");
    expect(fileSearch.refresh).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search workspace files" }),
      { key: "Enter" },
    );
    await waitFor(() => {
      expect(onSelectFile).toHaveBeenCalledWith(workspaceFiles[0]);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  test("contains a rejected refresh promise and keeps the picker usable", async () => {
    const refresh = mock(() =>
      Promise.reject(new Error("Workspace scan failed")),
    );
    render(
      <NativeAttachmentMenu
        fileSearch={createFileSearch({ refresh })}
        onSelectFile={() => {}}
      />,
    );

    await openFilePicker();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Search workspace files" }),
    );
  });

  test("renders loading, error, and empty states", async () => {
    const onSelectFile = mock(() => {});
    const { rerender } = render(
      <NativeAttachmentMenu
        fileSearch={createFileSearch({ isLoading: true })}
        onSelectFile={onSelectFile}
      />,
    );

    await openFilePicker();
    expect(screen.getByText("Loading files...")).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search workspace files" }),
      { key: "Enter" },
    );
    expect(onSelectFile).not.toHaveBeenCalled();

    rerender(
      <NativeAttachmentMenu
        fileSearch={createFileSearch({
          error: "Could not scan workspace",
        })}
        onSelectFile={onSelectFile}
      />,
    );
    expect(screen.getByText("Could not scan workspace")).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search workspace files" }),
      { key: "Enter" },
    );
    expect(onSelectFile).not.toHaveBeenCalled();

    rerender(
      <NativeAttachmentMenu
        fileSearch={createFileSearch({ searchFiles: () => [] })}
        onSelectFile={onSelectFile}
      />,
    );
    expect(screen.getByText("No files match that search.")).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search workspace files" }),
      { key: "Enter" },
    );
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  test("disables unavailable actions and reports an environment that becomes unavailable", async () => {
    const { rerender } = render(
      <NativeAttachmentMenu
        fileSearch={createFileSearch({ isAvailable: false })}
        onSelectFile={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
    expect(
      (await screen.findByRole("menuitem", {
        name: "Attach file from workspace",
      })).getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });

    rerender(
      <NativeAttachmentMenu
        fileSearch={createFileSearch()}
        onSelectFile={() => {}}
      />,
    );
    await openFilePicker();

    rerender(
      <NativeAttachmentMenu
        fileSearch={createFileSearch({ isAvailable: false })}
        onSelectFile={() => {}}
      />,
    );

    expect(
      screen.getByText("Start the environment to attach workspace files."),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", {
        name: "Search workspace files",
      }).getAttribute("disabled"),
    ).not.toBeNull();
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search workspace files" }),
      { key: "Enter" },
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("supports disabled trigger, closes when disabled, and uses custom labels", async () => {
    const { rerender } = render(
      <NativeAttachmentMenu
        disabled
        fileSearch={createFileSearch()}
        onSelectFile={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Add attachment" });
    expect(trigger.getAttribute("disabled")).not.toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();

    rerender(
      <NativeAttachmentMenu
        fileSearch={createFileSearch()}
        onSelectFile={() => {}}
        fileActionLabel="Choose project file"
        filePickerTitle="Choose source"
        filePickerDescription="Pick one project file."
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Choose project file" }),
    );
    expect(await screen.findByText("Choose source")).toBeTruthy();
    expect(screen.getByText("Pick one project file.")).toBeTruthy();

    rerender(
      <NativeAttachmentMenu
        disabled
        fileSearch={createFileSearch()}
        onSelectFile={() => {}}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("createWorkspaceAttachment", () => {
  test("resolves local and container paths and normalizes separators", () => {
    expect(
      createWorkspaceAttachment(
        workspaceFiles[0]!,
        undefined,
        "/tmp/worktree///",
      ),
    ).toEqual(expect.objectContaining({
      type: "file",
      path: "/tmp/worktree/docs/architecture.md",
      name: "architecture.md",
    }));

    expect(
      createWorkspaceAttachment(
        {
          filename: "mockup.PNG",
          relativePath: "\\assets\\mockup.PNG",
          isDirectory: false,
        },
        "container-1",
      ),
    ).toEqual(expect.objectContaining({
      type: "image",
      path: "/workspace/assets/mockup.PNG",
      name: "mockup.PNG",
    }));

    expect(
      createWorkspaceAttachment(
        {
          filename: "main.ts",
          relativePath: "/src/main.ts",
          isDirectory: false,
        },
        undefined,
        "C:\\project\\\\",
      ),
    ).toEqual(expect.objectContaining({
      path: "C:/project/src/main.ts",
    }));

    expect(
      createWorkspaceAttachment(
        {
          filename: "root.txt",
          relativePath: "root.txt",
          isDirectory: false,
        },
        undefined,
        "/",
      ),
    ).toEqual(expect.objectContaining({ path: "/root.txt" }));
  });

  test("rejects missing roots, empty paths, directories, empty segments, and traversal", () => {
    const file: FileCandidate = {
      filename: "secret.txt",
      relativePath: "secret.txt",
      isDirectory: false,
    };

    expect(createWorkspaceAttachment(file)).toBeNull();
    expect(
      createWorkspaceAttachment({ ...file, relativePath: "" }, "container-1"),
    ).toBeNull();
    expect(
      createWorkspaceAttachment({ ...file, isDirectory: true }, "container-1"),
    ).toBeNull();
    expect(
      createWorkspaceAttachment(
        { ...file, relativePath: "nested//secret.txt" },
        "container-1",
      ),
    ).toBeNull();
    expect(
      createWorkspaceAttachment(
        { ...file, relativePath: "../secret.txt" },
        "container-1",
      ),
    ).toBeNull();
    expect(
      createWorkspaceAttachment(
        { ...file, relativePath: "nested\\..\\secret.txt" },
        "container-1",
      ),
    ).toBeNull();
  });

  test("does not infer image types from extensionless names or dotfiles", () => {
    for (const filename of ["png", "jpg", ".png"]) {
      expect(
        createWorkspaceAttachment(
          { filename, relativePath: filename, isDirectory: false },
          "container-1",
        ),
      ).toEqual(expect.objectContaining({ type: "file" }));
    }

    expect(
      createWorkspaceAttachment(
        {
          filename: "preview.PNG",
          relativePath: "preview.PNG",
          isDirectory: false,
        },
        "container-1",
      ),
    ).toEqual(expect.objectContaining({ type: "image" }));

    expect(
      createWorkspaceAttachment(
        {
          filename: "preview.data",
          relativePath: "preview.data",
          extension: ".WEBP",
          isDirectory: false,
        },
        "container-1",
      ),
    ).toEqual(expect.objectContaining({ type: "image" }));
  });
});
