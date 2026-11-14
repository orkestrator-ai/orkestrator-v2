import { afterEach, expect, test } from "bun:test";
import { useDebugBuildStore } from "@/stores/debugBuildStore";
import { DEBUG_CAPTURE_UNAVAILABLE, startDebugCapture } from "./start-debug-capture";

const target = { nodeId: null, projectId: "project-1", environmentId: "env-1" };

afterEach(() => {
  useDebugBuildStore.getState().close();
});

test("captures the window before the dialog opens, then opens it with the capture", async () => {
  let openAtCapture = null as boolean | null;
  await startDebugCapture(target, async () => {
    openAtCapture = useDebugBuildStore.getState().open;
    return "AAAA";
  });
  expect(openAtCapture).toBe(false);
  const state = useDebugBuildStore.getState();
  expect(state.open).toBe(true);
  expect(state.capturing).toBe(false);
  expect(state.target).toEqual(target);
  expect(state.screenshot).toBe("AAAA");
  expect(state.captureError).toBeNull();
});

test("opens without a screenshot, saying why, when the client cannot capture or the capture fails", async () => {
  await startDebugCapture(target, null);
  expect(useDebugBuildStore.getState().screenshot).toBeNull();
  expect(useDebugBuildStore.getState().captureError).toBe(DEBUG_CAPTURE_UNAVAILABLE);
  useDebugBuildStore.getState().close();

  await startDebugCapture(target, async () => {
    throw new Error("The window capture was empty");
  });
  expect(useDebugBuildStore.getState().open).toBe(true);
  expect(useDebugBuildStore.getState().captureError).toBe("The window capture was empty");
});

test("a press while the dialog is open does nothing", async () => {
  await startDebugCapture(target, async () => "AAAA");
  let captured = false;
  await startDebugCapture({ ...target, environmentId: "env-2" }, async () => {
    captured = true;
    return "BBBB";
  });
  expect(captured).toBe(false);
  expect(useDebugBuildStore.getState().target?.environmentId).toBe("env-1");
  expect(useDebugBuildStore.getState().screenshot).toBe("AAAA");
});
