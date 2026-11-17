import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import { useDesignCanvasGestures } from "./design-canvas-gestures";

const frame = (id: string, x: number, y: number): DesignFrame => ({
  id,
  name: id,
  x,
  y,
  width: 400,
  height: 300,
  html: "<p>Frame</p>",
  revision: 1,
});
afterEach(cleanup);

describe("group translation limits", () => {
  test.each([1, -1])(
    "all members share the bounded preview and commit at limit %s",
    async (sign) => {
      const a = frame("A", sign * 99900, sign * 99800);
      const b = frame("B", sign * 99990, sign * 99995);
      const submitGeometry = mock();
      const { result } = renderHook(() =>
        useDesignCanvasGestures({
          frames: [a, b],
          committedFrames: () => [a, b],
          selectedFrames: () => ["A", "B"],
          viewport: () => ({ panX: 0, panY: 0, zoom: 1 }),
          submitGeometry,
          setPinned: mock(),
          selectFrames: mock(),
          onMarqueeSelected: mock(),
        }),
      );
      act(() => result.current.frameActions.beginFrameGesture("A", "move"));
      let primary: { x?: number; y?: number } = {};
      act(() => {
        primary = result.current.frameActions.updateFrameGesture("A", {
          dx: sign * 30,
          dy: sign * 40,
        });
      });
      await waitFor(() =>
        expect(result.current.frameGesture!.offset).toEqual({ dx: sign * 10, dy: sign * 5 }),
      );
      const offset = result.current.frameGesture!.offset;
      const previewB = { x: b.x + offset.dx, y: b.y + offset.dy };
      expect(primary).toEqual({ x: a.x + offset.dx, y: a.y + offset.dy });
      expect(previewB.x - primary.x!).toBe(b.x - a.x);
      expect(previewB.y - primary.y!).toBe(b.y - a.y);
      act(() => result.current.frameActions.endFrameGesture("A", true, "move-1"));
      expect(submitGeometry).toHaveBeenCalledWith(b, previewB, "move-1", "Move B");
      expect(result.current.frameGesture).toBeNull();
    },
  );
});
