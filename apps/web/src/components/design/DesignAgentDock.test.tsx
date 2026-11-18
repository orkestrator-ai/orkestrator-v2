import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { DesignAgentPanelState } from "@/types/paneLayout";
import { sanitizeDesignAgentPanel } from "@/lib/pane-layout-embedded";
import { DesignAgentDock, DesignAgentPanelEmpty } from "./DesignAgentDock";

beforeAll(() => {
  // Happy DOM has no pointer capture; the dock only needs the calls to exist.
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.hasPointerCapture ??= () => false;
});

afterEach(() => cleanup());

function Harness({
  initial = { dock: "left", open: true },
  ownsGlobalShortcuts = true,
  onPopOut,
  hasAgent = true,
}: {
  initial?: DesignAgentPanelState;
  ownsGlobalShortcuts?: boolean;
  onPopOut?: () => void;
  hasAgent?: boolean;
}) {
  const [panel, setPanel] = useState<DesignAgentPanelState>(initial);
  return (
    <DesignAgentDock
      panel={panel}
      onPanelChange={(patch) =>
        setPanel((current) => sanitizeDesignAgentPanel({ ...current, ...patch }) ?? current)
      }
      visible
      ownsGlobalShortcuts={ownsGlobalShortcuts}
      agent={hasAgent ? { environmentId: "env-1", tabId: "agent-1", platform: "codex" } : undefined}
      {...(onPopOut ? { onPopOut } : {})}
      renderCanvas={(view) => (
        <div data-testid="canvas" data-owns={String(view.ownsGlobalShortcuts)}>
          <button type="button" onClick={view.agentPanel.onToggle}>
            Toolbar toggle {view.agentPanel.open ? "open" : "closed"}
          </button>
        </div>
      )}
      renderAgent={(view) => (
        <div
          data-testid="agent"
          data-active={String(view.isActive)}
          data-owns={String(view.ownsGlobalShortcuts)}
        />
      )}
    />
  );
}

const dock = () => document.querySelector<HTMLElement>("[data-agent-dock]")!;
const panel = () => screen.getByRole("region", { name: "Agent panel" });

describe("DesignAgentDock", () => {
  test("shows the agent in a panel on the left of the canvas by default", () => {
    renderInAppCommandScope(<Harness />);
    expect(dock().dataset.agentDock).toBe("left");
    expect(panel().style.order).toBe("0");
    expect(panel().style.flexBasis).toBe("40%");
    expect(screen.getByTestId("canvas").parentElement!.style.order).toBe("2");
    expect(screen.getByTestId("agent").dataset.active).toBe("true");
    // The header names the agent's platform until its conversation has a title.
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  test("the toolbar toggle, the close button and Ctrl/⌘+. hide and show the panel", () => {
    renderInAppCommandScope(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Hide agent panel" }));
    expect(panel().classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("agent").dataset.active).toBe("false");
    expect(screen.queryByRole("separator", { name: "Resize agent panel" }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Toolbar toggle closed" }));
    expect(panel().classList.contains("hidden")).toBe(false);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", ctrlKey: true }));
    });
    expect(panel().classList.contains("hidden")).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", metaKey: true }));
    });
    expect(panel().classList.contains("hidden")).toBe(false);
  });

  test("the shortcut belongs to the focused design tab only", () => {
    renderInAppCommandScope(<Harness ownsGlobalShortcuts={false} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", ctrlKey: true }));
    });
    expect(panel().classList.contains("hidden")).toBe(false);
  });

  test("arrow keys on the move handle dock the panel to any edge", () => {
    renderInAppCommandScope(<Harness />);
    const handle = screen.getByRole("button", { name: "Move agent panel" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(dock().dataset.agentDock).toBe("right");
    expect(panel().style.order).toBe("2");
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(dock().dataset.agentDock).toBe("bottom");
    expect(dock().className).toContain("flex-col");
    // A new axis starts from that axis's default size.
    expect(panel().style.flexBasis).toBe("40%");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(dock().dataset.agentDock).toBe("top");
    expect(panel().style.order).toBe("0");
  });

  test("dragging the move handle previews the edge and docks there on release", () => {
    renderInAppCommandScope(<Harness />);
    dock().getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 }) as DOMRect;
    const handle = screen.getByRole("button", { name: "Move agent panel" });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500, clientY: 590 });
    expect(document.querySelector("[data-dock-preview]")?.textContent).toBe("Dock bottom");
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 500, clientY: 590 });
    expect(dock().dataset.agentDock).toBe("bottom");
    expect(document.querySelector("[data-dock-preview]") === null).toBe(true);

    // Escape abandons a drag where it is.
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 500, clientY: 590 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 990, clientY: 300 });
    expect(document.querySelector("[data-dock-preview]")?.textContent).toBe("Dock right");
    fireEvent.keyDown(handle, { key: "Escape" });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 990, clientY: 300 });
    expect(dock().dataset.agentDock).toBe("bottom");
  });

  test("the position menu docks the panel too", async () => {
    renderInAppCommandScope(<Harness />);
    const trigger = screen.getByRole("button", { name: "Agent panel position: Left" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Top" }));
    expect(dock().dataset.agentDock).toBe("top");
  });

  test("the separator resizes the panel from the keyboard and the pointer", () => {
    renderInAppCommandScope(<Harness />);
    const separator = screen.getByRole("separator", { name: "Resize agent panel" });
    expect(separator.getAttribute("aria-valuenow")).toBe("40");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("42");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator.getAttribute("aria-valuenow")).toBe("80");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator.getAttribute("aria-valuenow")).toBe("15");

    dock().getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 }) as DOMRect;
    panel().getBoundingClientRect = () => ({ width: 150, height: 600 }) as DOMRect;
    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 150, clientY: 10 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 400, clientY: 10 });
    expect(separator.getAttribute("aria-valuenow")).toBe("40");
    fireEvent.pointerUp(separator, { pointerId: 1, clientX: 400, clientY: 10 });
    expect(panel().style.flexBasis).toBe("40%");
  });

  test("shortcuts go to whichever side was last used", () => {
    renderInAppCommandScope(<Harness />);
    expect(screen.getByTestId("canvas").dataset.owns).toBe("true");
    expect(screen.getByTestId("agent").dataset.owns).toBe("false");
    fireEvent.pointerDown(screen.getByTestId("agent"));
    expect(screen.getByTestId("canvas").dataset.owns).toBe("false");
    expect(screen.getByTestId("agent").dataset.owns).toBe("true");
    fireEvent.pointerDown(screen.getByTestId("canvas"));
    expect(screen.getByTestId("canvas").dataset.owns).toBe("true");
  });

  test("an empty open panel returns shortcuts to the canvas after pop out", () => {
    const view = renderInAppCommandScope(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("agent"));
    expect(screen.getByTestId("canvas").dataset.owns).toBe("false");
    view.rerender(<Harness hasAgent={false} />);
    expect(screen.getByTestId("canvas").dataset.owns).toBe("true");
    expect(screen.getByTestId("agent").dataset.owns).toBe("false");
  });

  test("pop out is offered only when the caller can do it", () => {
    const onPopOut = mock(() => {});
    renderInAppCommandScope(<Harness onPopOut={onPopOut} />);
    fireEvent.click(screen.getByRole("button", { name: "Open agent in its own tab" }));
    expect(onPopOut).toHaveBeenCalledTimes(1);
    cleanup();
    renderInAppCommandScope(<Harness />);
    expect(screen.queryByRole("button", { name: "Open agent in its own tab" }) === null).toBe(true);
  });
});

describe("DesignAgentPanelEmpty", () => {
  test("offers to show a linked open conversation here", () => {
    const onEmbed = mock((_tabId: string) => {});
    renderInAppCommandScope(
      <DesignAgentPanelEmpty
        candidates={[{ tabId: "tab-9", label: "Design chat · Claude" }]}
        onEmbed={onEmbed}
      />,
    );
    expect(screen.getByText("No agent in this design")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show here" }));
    expect(onEmbed).toHaveBeenCalledWith("tab-9");
  });
});
