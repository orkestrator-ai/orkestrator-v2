import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddProjectDialog } from "./AddProjectDialog";

afterEach(cleanup);

function renderDialog(overrides: Partial<React.ComponentProps<typeof AddProjectDialog>> = {}) {
  const onOpenChange = mock((_open: boolean) => undefined);
  const onAdd = mock(async (_gitUrl: string, _localPath?: string) => undefined);
  const onCreate = mock(async (_localPath: string) => undefined);
  const validateGitUrl = mock(async (_url: string) => true);
  render(
    <AddProjectDialog
      open
      onOpenChange={onOpenChange}
      onAdd={onAdd}
      onCreate={onCreate}
      validateGitUrl={validateGitUrl}
      {...overrides}
    />,
  );
  return { onOpenChange, onAdd, onCreate, validateGitUrl };
}

describe("AddProjectDialog", () => {
  test("creates a new private project from the selected target path", async () => {
    const { onCreate, onAdd, onOpenChange } = renderDialog();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Create new" }), { button: 0 });
    expect(screen.getByText("Private origin")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Project path/), {
      target: { value: "/Users/dev/Projects/new-app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("/Users/dev/Projects/new-app");
    });
    expect(onAdd).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("keeps the dialog open and displays a creation failure", async () => {
    const onCreate = mock(async () => {
      throw new Error("GitHub CLI is not authenticated");
    });
    const { onOpenChange } = renderDialog({ onCreate });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Create new" }), { button: 0 });
    fireEvent.change(screen.getByLabelText(/Project path/), {
      target: { value: "/Users/dev/Projects/new-app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "GitHub CLI is not authenticated",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
