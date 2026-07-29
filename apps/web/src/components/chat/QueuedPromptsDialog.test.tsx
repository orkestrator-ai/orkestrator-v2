import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueuedPromptsDialog } from "./QueuedPromptsDialog";
import { PromptQueueActionError } from "@/lib/prompt-queue-errors";

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

  test("reports an unresolvable failure with retry guidance", async () => {
    const onRemove = mock(async () => {
      throw new Error("Queue storage is unavailable");
    });
    render(
      <QueuedPromptsDialog
        open
        onOpenChange={() => {}}
        messages={messages}
        onEdit={() => {}}
        onMove={() => {}}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getAllByTitle("Remove queued prompt")[0]!);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not confirm the prompt queue update",
    );
  });

  test("shows an actionable refusal's own message instead of retry guidance", async () => {
    // "Wait for the queue to refresh" is wrong advice for something the user
    // has to resolve themselves, and it never stops being wrong.
    const onEdit = mock(async () => {
      throw new PromptQueueActionError("Clear the composer first.");
    });
    render(
      <QueuedPromptsDialog
        open
        onOpenChange={() => {}}
        messages={messages}
        onEdit={onEdit}
        onMove={() => {}}
        onRemove={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "First prompt" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Clear the composer first.",
    );
  });

  test("clears a stale error when the dialog is reopened", async () => {
    const onRemove = mock(async () => {
      throw new Error("Queue storage is unavailable");
    });
    const view = render(
      <QueuedPromptsDialog
        open
        onOpenChange={() => {}}
        messages={messages}
        onEdit={() => {}}
        onMove={() => {}}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getAllByTitle("Remove queued prompt")[0]!);
    expect(await screen.findByRole("alert")).toBeTruthy();

    const props = {
      messages,
      onEdit: () => {},
      onMove: () => {},
      onRemove,
      onOpenChange: () => {},
    };
    view.rerender(<QueuedPromptsDialog open={false} {...props} />);
    view.rerender(<QueuedPromptsDialog open {...props} />);

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  test("runs one queue action at a time and marks the busy control", async () => {
    /**
     * Every action re-reads the queue from the snapshot the backend returns.
     * Letting a second one start against indexes rendered from the pre-mutation
     * list would reorder or remove the wrong prompt.
     */
    let releaseRemove: (() => void) | undefined;
    const onRemove = mock(
      () => new Promise<void>((resolve) => {
        releaseRemove = resolve;
      }),
    );
    const onMove = mock(() => {});
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

    const removeButtons = screen.getAllByTitle("Remove queued prompt");
    fireEvent.click(removeButtons[0]!);

    await waitFor(() => {
      expect(removeButtons[0]!.getAttribute("aria-busy")).toBe("true");
      expect(removeButtons[1]!.hasAttribute("disabled")).toBe(true);
      expect(screen.getAllByTitle("Move down")[0]!.hasAttribute("disabled")).toBe(true);
    });

    fireEvent.click(removeButtons[1]!);
    fireEvent.click(screen.getAllByTitle("Move down")[0]!);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();

    releaseRemove?.();
    await waitFor(() => {
      expect(removeButtons[1]!.hasAttribute("disabled")).toBe(false);
    });
    expect(removeButtons[0]!.getAttribute("aria-busy")).toBe("false");
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
