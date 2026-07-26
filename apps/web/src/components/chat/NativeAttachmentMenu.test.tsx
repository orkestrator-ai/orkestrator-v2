import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createWorkspaceAttachment,
  NativeAttachmentMenu,
  type NativeAttachmentFileSearch,
} from "./NativeAttachmentMenu";

const workspaceFiles = [
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
];

function createFileSearch(): NativeAttachmentFileSearch {
  return {
    searchFiles: (query) =>
      workspaceFiles.filter((file) =>
        file.relativePath.toLowerCase().includes(query.toLowerCase()),
      ),
    isLoading: false,
    error: null,
    refresh: mock(() => {}),
    isAvailable: true,
  };
}

describe("NativeAttachmentMenu", () => {
  afterEach(cleanup);

  test("portals its menu and returns a selected workspace file", async () => {
    const onSelectFile = mock(() => {});
    const { container } = render(
      <div data-testid="scroll-toolbar" className="overflow-x-auto">
        <NativeAttachmentMenu
          fileSearch={createFileSearch()}
          onSelectFile={onSelectFile}
        />
      </div>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));

    const menu = await screen.findByRole("menu");
    expect(container.querySelector("[data-testid=scroll-toolbar]")!.contains(menu)).toBe(false);
    expect(
      screen.getByRole("menuitem", { name: /Paste image into the input/ }).getAttribute("aria-disabled"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("menuitem", { name: "Attach file from workspace" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByText("screenshots")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /architecture\.md/ }));

    await waitFor(() => {
      expect(onSelectFile).toHaveBeenCalledWith(workspaceFiles[0]);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  test("resolves local and container attachment paths and image types", () => {
    expect(
      createWorkspaceAttachment(
        workspaceFiles[0]!,
        undefined,
        "/tmp/worktree/",
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
          relativePath: "assets/mockup.PNG",
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
          filename: "secret.txt",
          relativePath: "../secret.txt",
          isDirectory: false,
        },
        "container-1",
      ),
    ).toBeNull();
  });
});
