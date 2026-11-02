import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import { DesignCanvasContext, type DesignCanvasActions } from "./design-canvas-context";
import { DesignFrameView } from "./DesignFrameView";
import { DesignFrameBridge } from "./frame-bridge";

const frame: DesignFrame = {
  id: "frame-1",
  name: "Hero",
  x: 0,
  y: 0,
  width: 320,
  height: 200,
  html: "<main>Hero</main>",
  revision: 1,
};

/**
 * Window `message` listeners currently attached. Each live bridge holds one,
 * and through it the frame's `Window`, so this is the leak the harness saw.
 */
let messageListeners: Set<EventListenerOrEventListenerObject>;
let registered: Map<string, DesignFrameBridge | null>;
let restoreSpies: () => void;

function actions(): DesignCanvasActions {
  const noop = () => undefined;
  return {
    controller: {} as DesignCanvasActions["controller"],
    environmentId: "env-1",
    canvasId: "canvas-1",
    beginSelection: () => 0,
    select: () => true,
    submitGeometry: noop,
    submitElementResize: noop,
    registerBridge: (frameId, bridge) => registered.set(frameId, bridge),
    frameRendered: noop,
    pin: noop,
    reportError: noop,
    exitPreview: noop,
    frameAction: noop,
    focusFrame: noop,
    selectFrame: noop,
  };
}

function view(live: boolean, value = actions()) {
  return (
    <DesignCanvasContext.Provider value={value}>
      <DesignFrameView
        frame={frame}
        committed={frame}
        live={live}
        zoom={1}
        mode="inspect"
        selected={null}
        pending={false}
        canRestorePrevious={false}
        focused={false}
      />
    </DesignCanvasContext.Provider>
  );
}

/** Dispatches native `load` events without letting React render in between. */
function loadTwiceBeforeRender(iframe: HTMLIFrameElement) {
  act(() => {
    iframe.dispatchEvent(new Event("load"));
    iframe.dispatchEvent(new Event("load"));
  });
}

beforeEach(() => {
  messageListeners = new Set();
  registered = new Map();
  type Listen = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  const realAdd = EventTarget.prototype.addEventListener;
  const realRemove = EventTarget.prototype.removeEventListener;
  const track: Listen = function (this: Window, type, listener, options) {
    if (type === "message" && listener) messageListeners.add(listener);
    realAdd.call(this, type, listener, options);
  };
  const untrack: Listen = function (this: Window, type, listener, options) {
    if (type === "message" && listener) messageListeners.delete(listener);
    realRemove.call(this, type, listener, options);
  };
  const add = spyOn(window, "addEventListener").mockImplementation(track);
  const remove = spyOn(window, "removeEventListener").mockImplementation(untrack);
  // Render asks never settle on their own here; the frame runtime is not loaded.
  const ask = spyOn(DesignFrameBridge.prototype, "ask").mockImplementation(
    () => new Promise<never>(() => undefined),
  );
  restoreSpies = () => {
    add.mockRestore();
    remove.mockRestore();
    ask.mockRestore();
  };
});

afterEach(() => {
  cleanup();
  restoreSpies();
});

describe("DesignFrameView bridge lifetime", () => {
  test("Strict Mode keeps the loaded bridge usable without a second iframe load", async () => {
    // Strict Mode replays mount effects before the asynchronous load creates a
    // bridge. Use real asks here: a listener count alone could hide a closed
    // bridge registered after replay.
    spyOn(DesignFrameBridge.prototype, "ask").mockRestore();
    const { container, rerender, unmount } = render(<StrictMode>{view(true)}</StrictMode>);
    const iframe = container.querySelector("iframe")!;
    const target = iframe.contentWindow!;
    const post = spyOn(target, "postMessage").mockImplementation((message) => {
      queueMicrotask(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: target,
            data: { channel: "orkestrator-design", requestId: message.requestId, result: "ok" },
          }),
        );
      });
    });
    try {
      await act(async () => {
        iframe.dispatchEvent(new Event("load"));
      });
      const bridge = registered.get(frame.id)!;
      expect(bridge.closed).toBe(false);
      expect(messageListeners.size).toBe(1);
      await expect(bridge.ask({ op: "setMode", mode: "inspect" })).resolves.toBe("ok");
      rerender(<StrictMode>{view(true)}</StrictMode>);
      expect(registered.get(frame.id)).toBe(bridge);
      await expect(bridge.ask({ op: "setMode", mode: "preview" })).resolves.toBe("ok");
      expect(messageListeners.size).toBe(1);
      unmount();
      expect(bridge.closed).toBe(true);
      expect(messageListeners.size).toBe(0);
    } finally {
      post.mockRestore();
    }
  });

  test("two loads before React renders leave one bridge listening, not two", () => {
    const { container } = render(view(true));
    loadTwiceBeforeRender(container.querySelector("iframe")!);
    expect(registered.get(frame.id)).toBeInstanceOf(DesignFrameBridge);
    expect(messageListeners.size).toBe(1);
  });

  test("listeners stay bounded across culling cycles with racing loads", () => {
    const { container, rerender } = render(view(true));
    const whileLive: number[] = [];
    const afterCull: number[] = [];
    for (let cycle = 0; cycle < 10; cycle++) {
      loadTwiceBeforeRender(container.querySelector("iframe")!);
      whileLive.push(messageListeners.size);
      rerender(view(false));
      afterCull.push(messageListeners.size);
      expect(registered.get(frame.id)).toBeNull();
      rerender(view(true));
    }
    expect({ whileLive, afterCull }).toEqual({
      whileLive: Array(10).fill(1),
      afterCull: Array(10).fill(0),
    });
  });

  test("a load that lands as the frame unmounts leaves nothing listening", () => {
    const { container, unmount } = render(view(true));
    const iframe = container.querySelector("iframe")!;
    act(() => {
      iframe.dispatchEvent(new Event("load"));
      unmount();
    });
    expect(messageListeners.size).toBe(0);
  });

  test("unmount closes the registered bridge and unregisters it", () => {
    const { container, unmount } = render(view(true));
    act(() => {
      container.querySelector("iframe")!.dispatchEvent(new Event("load"));
    });
    const bridge = registered.get(frame.id)!;
    expect(bridge.closed).toBe(false);
    unmount();
    expect(bridge.closed).toBe(true);
    expect(registered.get(frame.id)).toBeNull();
    expect(messageListeners.size).toBe(0);
  });
});
