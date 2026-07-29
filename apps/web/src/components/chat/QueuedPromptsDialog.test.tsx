import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueuedPromptsDialog } from "./QueuedPromptsDialog";

afterEach(() => cleanup());

const messages = [
  { id: "one", text: "First prompt", model: "fast" },
  { id: "two", text: "Second prompt", model: "deep" },
];

describe("QueuedPromptsDialog", () => {
  test("shows the empty state", () => {
    render(
      <QueuedPromptsDialog
        open
        onOpenChange={() => {}}
        messages={[]}
        onEdit={() => {}}
        onMove={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(screen.getByText("Queue is empty.")).toBeTruthy();
  });

  test("renders prompt metadata and sends the selected message for editing", async () => {
    const onEdit = mock(() => {});
    render(
      <QueuedPromptsDialog
        open
        onOpenChange={() => {}}
        messages={messages}
        renderMeta={(message) => <span>Model: {message.model}</span>}
        onEdit={onEdit}
        onMove={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(screen.getByText("Model: fast")).toBeTruthy();
    expect(screen.getByText("Model: deep")).toBeTruthy();
    const editButton = screen.getByRole("button", { name: "Second prompt" });
    fireEvent.click(editButton);
    await waitFor(() => {
      expect(onEdit).toHaveBeenCalledWith(messages[1]);
      expect(editButton.hasAttribute("disabled")).toBe(false);
    });
  });

  test("moves entries within bounds and removes by id", async () => {
    const onMove = mock(() => {});
    const onRemove = mock(() => {});
    render(
      <QueuedPromptsDialog
        open
        onOpenChange={() => {}}
        messages={messages}
        onEdit={() => {}}
        onMove={onMove}
        onRemove={onRemove}
      />,
    );

    const moveUp = screen.getAllByTitle("Move up");
    const moveDown = screen.getAllByTitle("Move down");
    expect(moveUp[0]?.hasAttribute("disabled")).toBe(true);
    expect(moveDown[1]?.hasAttribute("disabled")).toBe(true);

    fireEvent.click(moveDown[0]!);
    await waitFor(() => {
      expect(onMove).toHaveBeenNthCalledWith(1, 0, 1);
      expect(moveUp[1]?.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(moveUp[1]!);
    await waitFor(() => {
      expect(onMove).toHaveBeenNthCalledWith(2, 1, 0);
    });

    fireEvent.click(screen.getAllByTitle("Remove queued prompt")[1]!);
    await waitFor(() => {
      expect(onRemove).toHaveBeenCalledWith("two");
    });
  });

  test("forwards dialog close requests", () => {
    const onOpenChange = mock(() => {});
    render(
      <QueuedPromptsDialog
        open
        onOpenChange={onOpenChange}
        messages={messages}
        onEdit={() => {}}
        onMove={() => {}}
        onRemove={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
