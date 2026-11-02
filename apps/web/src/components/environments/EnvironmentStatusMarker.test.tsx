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
      expect(marker.classList).toContain("isolate");
      expect(center.classList).toContain("relative");
      expect(center.classList).toContain("z-10");
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
      const states: Array<[EnvironmentMarkerState, string]> = [
        ["inactive", "border-muted-foreground/40"],
        ["idle", "opacity-0"],
        ["working", "environment-working-spinner"],
        ["waiting", "bg-yellow-400/50"],
      ];
      for (const [state, look] of states) {
        const active = state === "working" || state === "waiting";
        rerender(<EnvironmentStatusMarker local={local} state={state} machine={machine} />);
        expect(marker.getAttribute("data-state")).toBe(state);
        expect(ring.classList).toContain(look);
        expect(ring.classList.contains("animate-pulse")).toBe(state === "waiting");
        expect(ring.classList.contains("environment-working-spinner")).toBe(state === "working");
        expect(ring.classList.contains("forced-colors:hidden")).toBe(!active);
        if (active) {
          expect(ring.classList).toContain("forced-colors:border-[CanvasText]");
          expect(ring.classList).toContain(
            state === "working" ? "forced-colors:border-solid" : "forced-colors:border-dashed",
          );
        }
        expect(marker.classList.contains("animate-pulse")).toBe(false);
        expect(marker.lastElementChild).toBe(center);
        expect(center.className).toBe(centerClasses);
        expect(center.classList.contains("animate-pulse")).toBe(false);
      }
    });
  }
}

test("synchronizes the actual ring on state and shape changes while retaining colour transitions", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  const loop = {
    animationName: "pulse",
    startTime: 500,
    effect: { getTiming: () => ({ iterations: Infinity }) },
  };
  const transition = { transitionProperty: "background-color", startTime: 500 };
  const targets: Element[] = [];
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: function (this: Element) {
      targets.push(this);
      return [loop, transition];
    },
  });
  try {
    const { rerender, getByTestId } = render(
      <EnvironmentStatusMarker local state="working" machine={null} />,
    );
    const ring = getByTestId("environment-status-ring");
    expect(loop.startTime).toBe(0);
    loop.startTime = 1000;
    rerender(<EnvironmentStatusMarker local state="waiting" machine={null} />);
    expect(loop.startTime).toBe(0);
    loop.startTime = 1500;
    rerender(<EnvironmentStatusMarker local={false} state="waiting" machine={null} />);
    expect(loop.startTime).toBe(0);
    expect(targets).toEqual([ring, ring, ring]);
    expect(transition.startTime).toBe(500);
  } finally {
    cleanup();
    if (descriptor) Object.defineProperty(Element.prototype, "getAnimations", descriptor);
    else delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
  }
});
