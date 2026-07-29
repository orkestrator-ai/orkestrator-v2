import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  test("renders prompt metadata and sends the selected message for editing", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Second prompt" }));
    expect(onEdit).toHaveBeenCalledWith(messages[1]);
  });

  test("moves entries within bounds and removes by id", () => {
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
    fireEvent.click(moveUp[1]!);
    expect(onMove).toHaveBeenNthCalledWith(1, 0, 1);
    expect(onMove).toHaveBeenNthCalledWith(2, 1, 0);

    fireEvent.click(screen.getAllByTitle("Remove queued prompt")[1]!);
    expect(onRemove).toHaveBeenCalledWith("two");
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

  test("surfaces a terminal dispatch error and retries explicitly", async () => {
    const onRetryDispatch = mock(async () => undefined);
    render(
      <QueuedPromptsDialog
        open
        onOpenChange={() => {}}
        messages={messages}
        onEdit={() => {}}
        onMove={() => {}}
        onRemove={() => {}}
        dispatchError={{ message: "Provider rejected this prompt." }}
        onRetryDispatch={onRetryDispatch}
      />,
    );

    expect(screen.getByRole("alert").textContent)
      .toContain("Provider rejected this prompt.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetryDispatch).toHaveBeenCalledTimes(1));
  });
});
