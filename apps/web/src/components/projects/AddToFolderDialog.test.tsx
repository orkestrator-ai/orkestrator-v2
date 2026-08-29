import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddToFolderDialog } from "./AddToFolderDialog";

afterEach(cleanup);

function renderDialog(overrides: Partial<Parameters<typeof AddToFolderDialog>[0]> = {}): {
  onSubmit: ReturnType<typeof mock>;
} {
  const onSubmit = mock(async () => {});
  render(
    <AddToFolderDialog
      open
      onOpenChange={() => {}}
      projectName="Project One"
      currentFolder={null}
      existingFolders={[]}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onSubmit };
}

describe("AddToFolderDialog", () => {
  test("submits the normalized name", async () => {
    const { onSubmit } = renderDialog();

    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "  Work  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Folder" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Work"));
  });

  test("refuses a blank name rather than creating a folder with no name", () => {
    const { onSubmit } = renderDialog();

    const submit = screen.getByRole("button", { name: "Add to Folder" });
    expect(submit.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "   " } });
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("says when a typed name will join an existing folder instead of creating one", () => {
    renderDialog({ existingFolders: ["Work"] });

    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "work" } });

    expect(screen.getByText(/Adds to the existing/)).toBeTruthy();
  });

  test("an existing folder chip fills the field with that folder's own spelling", async () => {
    const { onSubmit } = renderDialog({ existingFolders: ["Work"] });

    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to Folder" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Work"));
  });

  test("keeps the dialog open and reports a failed submission", async () => {
    const onSubmit = mock(async () => {
      throw new Error("Backend unavailable");
    });
    const onOpenChange = mock(() => {});
    render(
      <AddToFolderDialog
        open
        onOpenChange={onOpenChange}
        projectName="Project One"
        currentFolder={null}
        existingFolders={[]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Folder" }));

    expect(await screen.findByText("Backend unavailable")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("opens showing the folder the project is already in", () => {
    renderDialog({ currentFolder: "Work", existingFolders: ["Work"] });

    expect(screen.getByLabelText("Folder name").getAttribute("value")).toBe("Work");
  });
});
