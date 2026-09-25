import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import { DesignCheckpointPreview, type DesignPreviewBridge } from "./DesignCheckpointPreview";

const frame: DesignFrame = {
  id: "frame-1",
  name: "Hero",
  x: 0,
  y: 0,
  width: 480,
  height: 300,
  html: "<main>Old hero</main>",
  revision: 3,
};

function fakeBridge(ask: (operation: unknown) => Promise<unknown> = async () => undefined) {
  const bridge = { ask: mock(ask), close: mock(() => {}) };
  const createBridge = mock((_target: Window) => bridge as unknown as DesignPreviewBridge);
  return { bridge, createBridge };
}

afterEach(() => cleanup());

describe("DesignCheckpointPreview", () => {
  test("renders a sandboxed, non-interactive frame and only sends render", async () => {
    const { bridge, createBridge } = fakeBridge();
    const { container, unmount } = render(
      <DesignCheckpointPreview
        frame={frame}
        label="Checkpoint · revision 3"
        width={240}
        createBridge={createBridge}
      />,
    );

    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.className).toContain("pointer-events-none");
    expect(iframe.getAttribute("tabindex")).toBe("-1");
    expect(iframe.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(iframe.getAttribute("title")).toContain("read-only");
    expect(iframe.style.transform).toBe("scale(0.5)");
    expect(screen.getByText("Checkpoint · revision 3")).toBeTruthy();

    fireEvent.load(iframe);
    await waitFor(() => expect(bridge.ask).toHaveBeenCalledTimes(1));
    expect(bridge.ask).toHaveBeenCalledWith({ op: "render", html: "<main>Old hero</main>" });
    await waitFor(() =>
      expect(container.querySelector("figure")?.getAttribute("data-state")).toBe("ready"),
    );

    unmount();
    expect(bridge.close).toHaveBeenCalledTimes(1);
  });

  test("explains a frame that did not exist in the version", () => {
    const { container } = render(
      <DesignCheckpointPreview frame={null} label="Current · revision 9" />,
    );
    expect(container.querySelector("iframe") === null).toBe(true);
    expect(screen.getByText("This frame did not exist in this version")).toBeTruthy();
  });

  test("reports a render failure without offering editing", async () => {
    const { createBridge } = fakeBridge(async () => {
      throw new Error("Frame runtime did not respond");
    });
    const { container } = render(
      <DesignCheckpointPreview frame={frame} label="Checkpoint" createBridge={createBridge} />,
    );
    fireEvent.load(container.querySelector("iframe")!);
    expect(await screen.findByText("This version could not be rendered")).toBeTruthy();
  });
});
