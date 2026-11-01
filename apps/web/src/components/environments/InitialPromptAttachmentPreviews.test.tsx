import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { InitialPromptImageAttachment } from "@/lib/initial-prompt-attachments";
import { InitialPromptAttachmentPreviews } from "./InitialPromptAttachmentPreviews";

afterEach(cleanup);

const first: InitialPromptImageAttachment = {
  id: "first",
  name: "first.png",
  type: "image",
  previewUrl: "data:image/png;base64,AAAA",
  base64Data: "AAAA",
};
const notes: InitialPromptImageAttachment = {
  id: "notes",
  name: "notes.md",
  type: "file",
  base64Data: "IyBub3Rlcw==",
};
const second: InitialPromptImageAttachment = {
  id: "second",
  name: "second.png",
  // Older records omit the type; every such attachment was an image.
  previewUrl: "data:image/png;base64,BBBB",
  base64Data: "BBBB",
};

describe("InitialPromptAttachmentPreviews", () => {
  test("renders nothing without attachments", () => {
    const { container } = render(
      <InitialPromptAttachmentPreviews attachments={[]} disabled={false} onRemove={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("clicking an image thumbnail opens it in the preview modal", async () => {
    const onRemove = mock((_id: string) => {});
    render(
      <InitialPromptAttachmentPreviews
        attachments={[first, notes, second]}
        disabled={false}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText("notes.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview notes.md" }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Preview second.png" }));
    const dialog = screen.getByRole("dialog", { name: "Image preview: second.png" });
    expect(within(dialog).getByText(/2 of 2/)).toBeTruthy();
    expect(within(dialog).getByRole("img", { name: "second.png" }).getAttribute("src")).toBe(
      "data:image/png;base64,BBBB",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Previous image" }));
    expect(
      (await within(dialog).findByRole("img", { name: "first.png" })).getAttribute("src"),
    ).toBe("data:image/png;base64,AAAA");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close image preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(onRemove).not.toHaveBeenCalled();
  });

  test("the remove button removes without opening the preview", () => {
    const onRemove = mock((_id: string) => {});
    render(
      <InitialPromptAttachmentPreviews
        attachments={[first]}
        disabled={false}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove first.png" }));
    expect(onRemove).toHaveBeenCalledWith("first");
    expect(screen.queryByRole("dialog") === null).toBe(true);
  });

  test("previews stay available while the dialog is busy", () => {
    render(<InitialPromptAttachmentPreviews attachments={[first]} disabled onRemove={() => {}} />);
    expect(
      (screen.getByRole("button", { name: "Remove first.png" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview first.png" }));
    expect(screen.getByRole("dialog", { name: "Image preview: first.png" })).toBeTruthy();
  });

  test("Escape closes only the preview, not the new environment dialog around it", async () => {
    const onOuterOpenChange = mock((_open: boolean) => {});
    render(
      <Dialog open onOpenChange={onOuterOpenChange}>
        <DialogContent>
          <DialogTitle>New environment</DialogTitle>
          <DialogDescription>Create an environment.</DialogDescription>
          <InitialPromptAttachmentPreviews
            attachments={[first]}
            disabled={false}
            onRemove={() => {}}
          />
        </DialogContent>
      </Dialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview first.png" }));
    const preview = screen.getByRole("dialog", { name: "Image preview: first.png" });
    fireEvent.keyDown(preview, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Image preview: first.png" }) === null).toBe(
        true,
      ),
    );
    expect(screen.getByRole("dialog", { name: "New environment" })).toBeTruthy();
    expect(onOuterOpenChange).not.toHaveBeenCalled();
  });
});
