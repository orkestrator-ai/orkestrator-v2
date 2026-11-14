import { afterEach, expect, test } from "bun:test";
import { useDebugBuildStore } from "./debugBuildStore";

afterEach(() => {
  useDebugBuildStore.getState().close();
});

test("closing drops the target and the capture", () => {
  const store = useDebugBuildStore.getState();
  store.beginCapture({ nodeId: "node-2", projectId: "p", environmentId: "e" });
  expect(useDebugBuildStore.getState().capturing).toBe(true);
  expect(useDebugBuildStore.getState().open).toBe(false);
  useDebugBuildStore.getState().showDialog({ screenshot: "AAAA", captureError: null });
  expect(useDebugBuildStore.getState().open).toBe(true);
  useDebugBuildStore.getState().close();
  expect(useDebugBuildStore.getState()).toMatchObject({
    open: false,
    capturing: false,
    target: null,
    screenshot: null,
    captureError: null,
  });
});
