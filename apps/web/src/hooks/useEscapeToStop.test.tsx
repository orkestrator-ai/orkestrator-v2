import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useEscapeToStop } from "./useEscapeToStop";

function Harness({
  isActive = true,
  isLoading = true,
  onStop,
  modalOpen = false,
  pane = true,
  agentScope = false,
  attachRef = true,
}: {
  isActive?: boolean;
  isLoading?: boolean;
  onStop: () => void;
  modalOpen?: boolean;
  pane?: boolean;
  agentScope?: boolean;
  attachRef?: boolean;
}) {
  const composerRef = useRef<HTMLDivElement>(null);
  useEscapeToStop({ isActive, isLoading, onStop, scopeRef: composerRef });
  return (
    <>
      <div data-pane-leaf={pane ? "" : undefined} data-agent-scope={agentScope ? "" : undefined}>
        <button type="button">Pane tab</button>
        <div ref={attachRef ? composerRef : undefined}>
          <textarea aria-label="Composer" />
        </div>
      </div>
      <div data-pane-leaf="">
        <button type="button">Sibling pane tab</button>
      </div>
      <input aria-label="Sidebar search" />
      {modalOpen ? (
        <div role="dialog" aria-modal="true">
          <input aria-label="Settings field" />
        </div>
      ) : null}
    </>
  );
}

function pressEscape(init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(window, { key: "Escape", ...init });
}

afterEach(() => cleanup());

describe("useEscapeToStop", () => {
  test("stops the turn on a plain Escape", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    pressEscape();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("only the visible tab claims the key", () => {
    // Several tabs are mounted at once; a background one must not swallow
    // Escape and interrupt a turn the user cannot even see.
    const onStop = mock(() => {});
    render(<Harness isActive={false} onStop={onStop} />);

    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });

  test("does not bind when there is no turn to interrupt", () => {
    const onStop = mock(() => {});
    render(<Harness isLoading={false} onStop={onStop} />);

    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores a key another handler already consumed", () => {
    // A dialog or the slash-command menu closing on Escape must not also stop
    // the turn behind it.
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores auto-repeat so holding Escape stops once", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    pressEscape({ repeat: true });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores modified Escape presses", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    pressEscape({ metaKey: true });
    pressEscape({ ctrlKey: true });
    pressEscape({ altKey: true });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores Escape while an IME composition is active", () => {
    // There Escape cancels the composition; treating it as a stop would abort
    // the turn out from under someone mid-word.
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    pressEscape({ isComposing: true });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores other keys", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    fireEvent.keyDown(window, { key: "Enter" });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("marks the event handled so nothing else acts on it", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  test("stops from the attached composer", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    fireEvent.keyDown(screen.getByLabelText("Composer"), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("stops from anywhere else in the tab's pane", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Pane tab" }), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("stops from a sibling control of the composer in a pane-less agent scope", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} pane={false} agentScope />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Pane tab" }), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("keeps pane-less sidebar and modal controls outside the agent scope", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} pane={false} agentScope modalOpen />);

    fireEvent.keyDown(screen.getByLabelText("Sidebar search"), { key: "Escape" });
    fireEvent.keyDown(screen.getByLabelText("Settings field"), { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("falls back to the composer when no pane or agent scope exists", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} pane={false} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Pane tab" }), { key: "Escape" });
    fireEvent.keyDown(screen.getByLabelText("Composer"), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("does not claim a focused target when the scope ref is null", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} attachRef={false} />);

    fireEvent.keyDown(screen.getByLabelText("Composer"), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Pane tab" }), { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores Escape aimed at another pane", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Sibling pane tab" }), {
      key: "Escape",
    });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores Escape aimed at a control outside the pane", () => {
    // The sidebar search, file previews and similar surfaces close on Escape
    // without always claiming the key; that must not interrupt the agent.
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    fireEvent.keyDown(screen.getByLabelText("Sidebar search"), { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores Escape that closes a modal surface over the tab", () => {
    // Fullscreen settings listens on window too, but registers after the tab,
    // so it cannot prevent the key before this handler sees it.
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} modalOpen />);

    fireEvent.keyDown(screen.getByLabelText("Settings field"), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("unbinds on unmount", () => {
    const onStop = mock(() => {});
    const { unmount } = render(<Harness onStop={onStop} />);

    unmount();
    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });
});
