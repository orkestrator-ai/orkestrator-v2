import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueuedPromptsDialog, WEB_ANNOTATION_QUEUE_REMOVE_WARNING } from "./QueuedPromptsDialog";
import {
  PromptQueueActionError,
  WEB_ANNOTATION_QUEUE_ITEM_FROZEN_MESSAGE,
} from "@/lib/prompt-queue-errors";

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

    await act(async () => {
      fireEvent.click(moveDown[0]!);
    });
    expect(onMove).toHaveBeenNthCalledWith(1, 0, 1);
    expect(moveUp[1]?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(moveUp[1]!);
    });
    expect(onMove).toHaveBeenNthCalledWith(2, 1, 0);

    await act(async () => {
      fireEvent.click(screen.getAllByTitle("Remove queued prompt")[1]!);
    });
    expect(onRemove).toHaveBeenCalledWith("two");
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

    expect((await screen.findByRole("alert")).textContent).toBe("Clear the composer first.");
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
      expect(screen.queryByRole("alert") === null).toBe(true);
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
      () =>
        new Promise<void>((resolve) => {
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

    expect(screen.getByRole("alert").textContent).toContain("Provider rejected this prompt.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetryDispatch).toHaveBeenCalledTimes(1));
  });

  test("labels the in-flight retry and refuses a second dispatch until it settles", async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onRetryDispatch = mock(() => inFlight);
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

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    const retrying = await screen.findByRole("button", { name: "Retrying…" });
    expect(retrying.hasAttribute("disabled")).toBe(true);
    // Retrying clears the backend latch; a second dispatch would race the first.
    fireEvent.click(retrying);
    expect(onRetryDispatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await inFlight;
    });
    expect(screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled")).toBe(false);
  });

  test("reports a failed retry and allows another attempt", async () => {
    const onRetryDispatch = mock(async () => {
      throw new Error("backend unavailable");
    });
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

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("backend unavailable");
    });
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.hasAttribute("disabled")).toBe(false);

    fireEvent.click(retry);
    await waitFor(() => expect(onRetryDispatch).toHaveBeenCalledTimes(2));
  });

  test("still explains the dispatch error when no retry is wired up", () => {
    render(
      <QueuedPromptsDialog
        open
        onOpenChange={() => {}}
        messages={messages}
        onEdit={() => {}}
        onMove={() => {}}
        onRemove={() => {}}
        dispatchError={{ message: "Provider rejected this prompt." }}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("Queued prompt was not sent");
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
  });
});

describe("QueuedPromptsDialog web annotation requests", () => {
  const annotationItem = {
    id: "annotation-item",
    text: "Fix the header spacing",
    origin: { kind: "web-annotation", requestId: "req-1", bodyHash: "hash-1" },
  };
  const mixed = [messages[0]!, annotationItem, messages[1]!];

  function renderDialog(overrides: Partial<Parameters<typeof QueuedPromptsDialog>[0]> = {}) {
    const props = {
      open: true,
      onOpenChange: mock(() => {}),
      messages: mixed,
      onEdit: mock(() => {}),
      onMove: mock(() => {}),
      onRemove: mock(() => {}),
      onOpenWebAnnotationRequest: mock(() => Promise.resolve({ ok: true as const })),
      ...overrides,
    };
    render(<QueuedPromptsDialog {...(props as Parameters<typeof QueuedPromptsDialog>[0])} />);
    return props;
  }

  test("renders the item distinctly and never offers it for editing", () => {
    const props = renderDialog();

    expect(screen.getByText("Web annotation request")).toBeTruthy();
    // The text is static: no edit button carries it.
    expect(screen.queryByRole("button", { name: "Fix the header spacing" }) === null).toBe(true);
    fireEvent.click(screen.getByText("Fix the header spacing"));
    expect(props.onEdit).not.toHaveBeenCalled();
    // Ordinary prompts keep their edit affordance.
    expect(screen.getByRole("button", { name: "First prompt" })).toBeTruthy();
    const row = document.querySelector('[data-web-annotation-request="true"]');
    expect(row?.textContent).toContain("Fix the header spacing");
  });

  test("links to the annotation thread and closes on success", async () => {
    const props = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Open note" }));

    await waitFor(() => {
      expect(props.onOpenWebAnnotationRequest).toHaveBeenCalledWith("req-1");
      expect(props.onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("shows why the note could not be opened", async () => {
    const props = renderDialog({
      onOpenWebAnnotationRequest: mock(() =>
        Promise.resolve({ ok: false as const, error: "This request has no annotations." }),
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "Open note" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("This request has no annotations.");
    });
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  test("keeps reordering available", async () => {
    const props = renderDialog();

    const upButtons = screen.getAllByTitle("Move up");
    fireEvent.click(upButtons[1]!);
    await waitFor(() => expect(props.onMove).toHaveBeenCalledWith(1, 0));
  });

  test("removal says it cancels the request and asks first", async () => {
    const props = renderDialog();

    const remove = screen.getByRole("button", {
      name: "Remove and cancel the web annotation request",
    });
    fireEvent.click(remove);
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("group", { name: "Confirm cancelling the web annotation request" })
        .textContent,
    ).toContain(WEB_ANNOTATION_QUEUE_REMOVE_WARNING);

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByText(WEB_ANNOTATION_QUEUE_REMOVE_WARNING) === null).toBe(true);
    expect(props.onRemove).not.toHaveBeenCalled();

    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(props.onRemove).toHaveBeenCalledWith("annotation-item"));
  });

  test("ordinary prompts are still removed without a confirmation", async () => {
    const props = renderDialog();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove queued prompt" })[0]!);
    await waitFor(() => expect(props.onRemove).toHaveBeenCalledWith("one"));
  });

  test("translates the backend's frozen-item refusal into guidance", async () => {
    renderDialog({
      onMove: mock(() =>
        Promise.reject(
          new Error(
            "Web annotation queue item is frozen: annotation-item is a frozen request snapshot; it cannot be edited or moved into a draft. Remove it to cancel the request.",
          ),
        ),
      ),
    });

    fireEvent.click(screen.getAllByTitle("Move up")[1]!);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(WEB_ANNOTATION_QUEUE_ITEM_FROZEN_MESSAGE);
    });
  });
});
