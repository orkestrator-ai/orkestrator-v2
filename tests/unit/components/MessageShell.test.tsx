import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MessageShell,
  MessageErrorAlert,
} from "../../../apps/web/src/components/chat/MessageShell";

const waitForLongPress = () => new Promise((resolve) => window.setTimeout(resolve, 550));

afterEach(() => {
  cleanup();
});

function getUserBubble(container: HTMLElement, content: string): HTMLElement {
  return Array.from(container.querySelectorAll(".rounded-xl"))
    .find((element) => element.textContent?.includes(content)) as HTMLElement;
}

describe("MessageShell", () => {
  test("renders children and header by default", () => {
    const { container } = render(
      <MessageShell
        isUser={false}
        authorLabel="Claude"
        timestampLabel="12:00 PM"
      >
        <p>Hello world</p>
      </MessageShell>,
    );

    expect(container.textContent).toContain("Claude");
    expect(container.textContent).toContain("12:00 PM");
    expect(container.textContent).toContain("Hello world");
  });

  test("keeps assistant metadata under the block when showHeader is false", () => {
    const { container } = render(
      <MessageShell
        isUser={false}
        authorLabel="Claude"
        timestampLabel="12:00 PM"
        showHeader={false}
      >
        <p>Content only</p>
      </MessageShell>,
    );

    expect(container.textContent).toContain("Claude");
    expect(container.textContent).toContain("12:00 PM");
    expect(container.textContent).toContain("Content only");
  });

  test("applies right-aligned bubble styling for user messages", () => {
    const { container } = render(
      <MessageShell isUser={true} authorLabel="You" timestampLabel="1:00 PM">
        <p>User message</p>
      </MessageShell>,
    );

    const rowDiv = container.querySelector(".justify-end") as HTMLElement;
    expect(rowDiv).not.toBeNull();

    const bubble = Array.from(container.querySelectorAll(".rounded-xl"))
      .find((element) => element.textContent?.includes("User message")) as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.className).toContain("rounded-xl");
    expect(bubble.className).toContain("bg-zinc-800/80");
  });

  test("cancels a touch long press when the finger moves to scroll", async () => {
    const onUserLongPress = mock(() => {});
    render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        onUserLongPress={onUserLongPress}
      >
        <p>Scrollable user message</p>
      </MessageShell>,
    );

    const message = screen.getByText("Scrollable user message");
    fireEvent.pointerDown(message, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(message, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 20,
      clientY: 40,
    });
    await waitForLongPress();
    fireEvent.pointerUp(message, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 20,
      clientY: 40,
    });

    expect(onUserLongPress).not.toHaveBeenCalled();
  });

  test("does not trigger a long press when a touch is released early", async () => {
    const onUserLongPress = mock(() => {});
    render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        onUserLongPress={onUserLongPress}
      >
        <p>Short press</p>
      </MessageShell>,
    );

    const message = screen.getByText("Short press");
    fireEvent.pointerDown(message, {
      pointerType: "touch",
      pointerId: 2,
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerUp(message, {
      pointerType: "touch",
      pointerId: 2,
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    await waitForLongPress();

    expect(onUserLongPress).not.toHaveBeenCalled();
  });

  test("ignores non-touch and non-primary pointer presses", async () => {
    const onUserLongPress = mock(() => {});
    render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        onUserLongPress={onUserLongPress}
      >
        <p>Primary touch only</p>
      </MessageShell>,
    );

    const message = screen.getByText("Primary touch only");
    fireEvent.pointerDown(message, {
      pointerType: "mouse",
      pointerId: 3,
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerUp(message, {
      pointerType: "mouse",
      pointerId: 3,
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerDown(message, {
      pointerType: "touch",
      pointerId: 4,
      isPrimary: false,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerUp(message, {
      pointerType: "touch",
      pointerId: 4,
      isPrimary: false,
      clientX: 20,
      clientY: 20,
    });
    await waitForLongPress();

    expect(onUserLongPress).not.toHaveBeenCalled();
  });

  test("does not install gesture-specific styles without a long-press callback", () => {
    const { container } = render(
      <MessageShell isUser={true} authorLabel="You" timestampLabel="1:00 PM">
        <p>No callback</p>
      </MessageShell>,
    );

    const bubble = getUserBubble(container, "No callback");
    expect(bubble.getAttribute("style")).toBeNull();

    fireEvent.pointerDown(bubble, {
      pointerType: "touch",
      pointerId: 5,
      isPrimary: true,
    });
    fireEvent.pointerUp(bubble, {
      pointerType: "touch",
      pointerId: 5,
      isPrimary: true,
    });
  });

  test("allows native horizontal panning and pinch zoom on copyable messages", () => {
    const { container } = render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        onUserLongPress={() => {}}
      >
        <p>Native touch navigation</p>
      </MessageShell>,
    );

    const bubble = getUserBubble(container, "Native touch navigation");
    expect(bubble.style.touchAction).toBe("");
    expect(bubble.style.WebkitTouchCallout).toBe("none");
  });

  test("keeps a long press at the movement boundary and cancels past it horizontally", async () => {
    const onUserLongPress = mock(() => {});
    render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        onUserLongPress={onUserLongPress}
      >
        <p>Movement tolerance</p>
      </MessageShell>,
    );

    const message = screen.getByText("Movement tolerance");
    fireEvent.pointerDown(message, {
      pointerType: "touch",
      pointerId: 6,
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(message, {
      pointerType: "touch",
      pointerId: 6,
      isPrimary: true,
      clientX: 30,
      clientY: 20,
    });
    await waitForLongPress();
    fireEvent.pointerUp(message, {
      pointerType: "touch",
      pointerId: 6,
      isPrimary: true,
      clientX: 30,
      clientY: 20,
    });
    expect(onUserLongPress).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(message, {
      pointerType: "touch",
      pointerId: 7,
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(message, {
      pointerType: "touch",
      pointerId: 7,
      isPrimary: true,
      clientX: 31,
      clientY: 20,
    });
    await waitForLongPress();
    fireEvent.pointerUp(message, {
      pointerType: "touch",
      pointerId: 7,
      isPrimary: true,
      clientX: 31,
      clientY: 20,
    });

    expect(onUserLongPress).toHaveBeenCalledTimes(1);
  });

  test("cancels a pending long press when the initiating pointer is cancelled", async () => {
    const onUserLongPress = mock(() => {});
    render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        onUserLongPress={onUserLongPress}
      >
        <p>Cancelled press</p>
      </MessageShell>,
    );

    const message = screen.getByText("Cancelled press");
    fireEvent.pointerDown(message, {
      pointerType: "touch",
      pointerId: 8,
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerCancel(message, {
      pointerType: "touch",
      pointerId: 8,
      isPrimary: true,
    });
    await waitForLongPress();
    fireEvent.pointerUp(message, {
      pointerType: "touch",
      pointerId: 8,
      isPrimary: true,
    });

    expect(onUserLongPress).not.toHaveBeenCalled();
  });

  test("clears a pending long-press timer when unmounted", () => {
    const onUserLongPress = mock(() => {});
    const originalClearTimeout = window.clearTimeout;
    const clearTimeoutSpy = mock((timerId: number | undefined) => {
      originalClearTimeout(timerId);
    });
    window.clearTimeout = clearTimeoutSpy as typeof window.clearTimeout;

    try {
      const { unmount } = render(
        <MessageShell
          isUser={true}
          authorLabel="You"
          timestampLabel="1:00 PM"
          onUserLongPress={onUserLongPress}
        >
          <p>Unmounted press</p>
        </MessageShell>,
      );
      fireEvent.pointerDown(screen.getByText("Unmounted press"), {
        pointerType: "touch",
        pointerId: 9,
        isPrimary: true,
      });

      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(onUserLongPress).not.toHaveBeenCalled();
    } finally {
      window.clearTimeout = originalClearTimeout;
    }
  });

  test("only lets the initiating pointer complete or cancel a long press", async () => {
    const onUserLongPress = mock(() => {});
    render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        onUserLongPress={onUserLongPress}
      >
        <p>Multi-touch press</p>
      </MessageShell>,
    );

    const message = screen.getByText("Multi-touch press");
    fireEvent.pointerDown(message, {
      pointerType: "touch",
      pointerId: 10,
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(message, {
      pointerType: "touch",
      pointerId: 11,
      isPrimary: false,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerCancel(message, {
      pointerType: "touch",
      pointerId: 11,
      isPrimary: false,
    });
    await waitForLongPress();
    fireEvent.pointerUp(message, {
      pointerType: "touch",
      pointerId: 11,
      isPrimary: false,
    });
    expect(onUserLongPress).not.toHaveBeenCalled();

    fireEvent.pointerUp(message, {
      pointerType: "touch",
      pointerId: 10,
      isPrimary: true,
    });
    expect(onUserLongPress).toHaveBeenCalledTimes(1);
  });

  test("suppresses only the click synthesized by a completed long press", async () => {
    const onUserLongPress = mock(() => {});
    const onClick = mock(() => {});
    render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        onUserLongPress={onUserLongPress}
      >
        <button type="button" onClick={onClick}>Clickable content</button>
      </MessageShell>,
    );

    const button = screen.getByRole("button", { name: "Clickable content" });
    fireEvent.pointerDown(button, {
      pointerType: "touch",
      pointerId: 12,
      isPrimary: true,
    });
    await waitForLongPress();
    fireEvent.pointerUp(button, {
      pointerType: "touch",
      pointerId: 12,
      isPrimary: true,
    });
    expect(onUserLongPress).toHaveBeenCalledTimes(1);

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("does not suppress a new primary click when no synthetic click was emitted", async () => {
    const onClick = mock(() => {});
    render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        onUserLongPress={() => {}}
      >
        <button type="button" onClick={onClick}>Later click</button>
      </MessageShell>,
    );

    const button = screen.getByRole("button", { name: "Later click" });
    fireEvent.pointerDown(button, {
      pointerType: "touch",
      pointerId: 13,
      isPrimary: true,
    });
    await waitForLongPress();
    fireEvent.pointerUp(button, {
      pointerType: "touch",
      pointerId: 13,
      isPrimary: true,
    });

    fireEvent.pointerDown(button, {
      pointerType: "mouse",
      pointerId: 14,
      isPrimary: true,
    });
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("places user metadata and actions in a hidden row below the bubble", () => {
    const { container } = render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        actions={<button type="button">Copy</button>}
      >
        <p>User message</p>
      </MessageShell>,
    );

    const bubble = Array.from(container.querySelectorAll(".rounded-xl"))
      .find((element) => element.textContent?.includes("User message")) as HTMLElement;
    expect(bubble.textContent).not.toContain("1:00 PM");

    const hiddenRow = container.querySelector(".group-hover\\:opacity-100") as HTMLElement;
    expect(hiddenRow).not.toBeNull();
    expect(hiddenRow.className).toContain("opacity-0");
    expect(hiddenRow.textContent).toContain("1:00 PM");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  test("composes the timestamp and duration in user and assistant metadata", () => {
    const user = render(
      <MessageShell
        isUser={true}
        authorLabel="You"
        timestampLabel="1:00 PM"
        durationLabel="3s"
      >
        <p>Timed user message</p>
      </MessageShell>,
    );
    expect(user.container.textContent).toContain("1:00 PM · 3s");
    user.unmount();

    const assistant = render(
      <MessageShell
        isUser={false}
        authorLabel="Claude"
        timestampLabel="1:01 PM"
        durationLabel="4s"
      >
        <p>Timed assistant message</p>
      </MessageShell>,
    );
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("1:01 PM · 4s")).toBeTruthy();
  });

  test("applies full-width content styling for non-user messages", () => {
    const { container } = render(
      <MessageShell
        isUser={false}
        authorLabel="Claude"
        timestampLabel="1:00 PM"
      >
        <p>Assistant message</p>
      </MessageShell>,
    );

    const rowDiv = container.querySelector(".justify-start") as HTMLElement;
    expect(rowDiv).not.toBeNull();

    const contentDiv = rowDiv.firstElementChild as HTMLElement;
    expect(contentDiv.className).toContain("w-full");
  });

  test("applies responsive padding classes", () => {
    const { container } = render(
      <MessageShell isUser={false} authorLabel="Claude" timestampLabel="1:00 PM">
        <p>Test</p>
      </MessageShell>,
    );

    const outerDiv = container.firstElementChild as HTMLElement;
    expect(outerDiv.className).toContain("px-3");
    expect(outerDiv.className).toContain("@sm:px-6");
  });

  test("applies min-w-0 and break-words for text wrapping", () => {
    const { container } = render(
      <MessageShell isUser={false} authorLabel="Claude" timestampLabel="1:00 PM">
        <p>Long text content</p>
      </MessageShell>,
    );

    const contentDiv = container.querySelector(".max-w-3xl") as HTMLElement;
    expect(contentDiv.className).toContain("min-w-0");

    const childrenDiv = contentDiv.querySelector(".flex.flex-col.gap-3") as HTMLElement;
    expect(childrenDiv.className).toContain("break-words");
  });

  test("merges custom className and contentClassName", () => {
    const { container } = render(
      <MessageShell
        isUser={false}
        authorLabel="Claude"
        timestampLabel="1:00 PM"
        className="custom-outer"
        contentClassName="custom-inner"
      >
        <p>Test</p>
      </MessageShell>,
    );

    const outerDiv = container.firstElementChild as HTMLElement;
    expect(outerDiv.className).toContain("custom-outer");

    const contentDiv = container.querySelector(".max-w-3xl") as HTMLElement;
    expect(contentDiv.className).toContain("custom-inner");
  });
});

describe("MessageErrorAlert", () => {
  test("renders error content and timestamp", () => {
    const { container } = render(
      <MessageErrorAlert
        content="Something went wrong"
        timestampLabel="2:00 PM"
      />,
    );

    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).toContain("2:00 PM");
  });

  test("applies responsive padding and min-w-0", () => {
    const { container } = render(
      <MessageErrorAlert content="Error" timestampLabel="2:00 PM" />,
    );

    const outerDiv = container.firstElementChild as HTMLElement;
    expect(outerDiv.className).toContain("px-2");
    expect(outerDiv.className).toContain("@sm:px-4");

    const contentDiv = outerDiv.querySelector(".max-w-3xl") as HTMLElement;
    expect(contentDiv.className).toContain("min-w-0");
  });

  test("renders with break-words for long error messages", () => {
    const { container } = render(
      <MessageErrorAlert
        content="A very long error message that should wrap properly at narrow widths"
        timestampLabel="2:00 PM"
      />,
    );

    const errorText = container.querySelector(
      ".text-destructive.break-words",
    ) as HTMLElement;
    expect(errorText).not.toBeNull();
    expect(errorText.textContent).toContain("A very long error message");
  });

  test("renders optional details and action content", () => {
    render(
      <MessageErrorAlert
        content="Authentication failed"
        details="Original API error details"
        action={<button type="button">Retry login</button>}
        timestampLabel="2:00 PM"
      />,
    );

    expect(screen.getByText("Authentication failed")).toBeTruthy();
    expect(screen.getByText("Original API error details")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry login" })).toBeTruthy();
  });
});
