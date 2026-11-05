import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileActionDialog, type PendingFileAction } from "./FileActionDialog";

afterEach(cleanup);

function renderDialog(action: PendingFileAction) {
  const onConfirm = mock(async () => undefined);
  render(
    <FileActionDialog
      action={action}
      targetRef="main"
      isPending={false}
      onCancel={() => undefined}
      onConfirm={onConfirm}
    />,
  );
  return onConfirm;
}

test("confirms a folder deletion with folder wording", async () => {
  const onConfirm = renderDialog({
    environmentId: "env-1",
    kind: "delete-folder",
    paths: ["docs/guides"],
  });

  expect(screen.getByRole("alertdialog", { name: "Delete folder?" })).toBeTruthy();
  expect(screen.getByText("docs/guides")).toBeTruthy();
  expect(screen.getByText(/everything inside it/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
});

test("keeps file wording for file deletions", () => {
  renderDialog({ environmentId: "env-1", kind: "delete", paths: ["a.txt", "b.txt"] });

  expect(screen.getByRole("alertdialog", { name: "Delete files?" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete files" })).toBeTruthy();
});
