import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { EnvironmentStatusMarker, type EnvironmentMarkerState } from "./EnvironmentStatusMarker";

afterEach(cleanup);

for (const local of [true, false]) {
  for (const machine of [null, { name: "Machine A", colorToken: "teal", status: "Connected" }]) {
    test(`renders ${local ? "local" : "container"} identity with ${machine ? "machine colour" : "neutral fill"} through every activity state`, () => {
      const { rerender } = render(
        <EnvironmentStatusMarker local={local} state="inactive" machine={machine} />,
      );
      const marker = screen.getByTestId("environment-status-marker");
      const ring = screen.getByTestId("environment-status-ring");
      const center = marker.lastElementChild!;
      const shape = local ? "circle" : "square";
      expect(marker.getAttribute("data-shape")).toBe(shape);
      expect(center.classList).toContain(local ? "rounded-full" : "rounded-[1px]");
      expect(ring.classList).toContain(local ? "rounded-full" : "rounded-[4px]");
      expect(ring.classList).toContain("pointer-events-none");
      expect(ring.classList).toContain("forced-colors:hidden");
      expect(center.classList).toContain("forced-colors:bg-[CanvasText]");
      expect(center.classList).toContain(machine ? "bg-teal-500" : "bg-muted-foreground");
      if (machine) {
        expect(center.getAttribute("data-machine-color")).toBe("teal");
        expect(center.getAttribute("data-shape")).toBe(shape);
        expect(center.classList).toContain("forced-colors:border-[CanvasText]");
      } else {
        expect(screen.queryByTestId("machine-dot") === null).toBe(true);
      }
      const centerClasses = center.className;
      const states: Array<[EnvironmentMarkerState, string, boolean]> = [
        ["inactive", "opacity-0", false],
        ["idle", "opacity-0", false],
        ["working", "bg-red-500/50", true],
        ["waiting", "bg-yellow-400/50", true],
      ];
      for (const [state, color, pulsing] of states) {
        rerender(<EnvironmentStatusMarker local={local} state={state} machine={machine} />);
        expect(marker.getAttribute("data-state")).toBe(state);
        expect(ring.classList).toContain(color);
        expect(ring.classList.contains("animate-pulse")).toBe(pulsing);
        expect(marker.classList.contains("animate-pulse")).toBe(false);
        expect(marker.lastElementChild).toBe(center);
        expect(center.className).toBe(centerClasses);
        expect(center.classList.contains("animate-pulse")).toBe(false);
      }
    });
  }
}
