import { afterEach, describe, expect, test } from "bun:test";
import {
  BrowserPreviewTraceSessions,
  TRACE_BOUNDS,
  type TracePreviewHandle,
} from "../electron/browser-preview-trace.ts";

const sessions: BrowserPreviewTraceSessions[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

/** A preview whose page queue the test fills; `executeJavaScript` drains it like the real recorder. */
function fakePreview(url = "http://localhost:5173/items") {
  const state = {
    url,
    generation: 1,
    installed: 0,
    installing: null as Promise<void> | null,
    queue: [] as unknown[],
    destroyed: false,
  };
  const handle = (): TracePreviewHandle => ({
    generation: state.generation,
    contents: {
      getURL: () => state.url,
      isDestroyed: () => state.destroyed,
      executeJavaScript: async (code: string) => {
        if (code.includes("window.__orkestratorTrace?.token"))
          return state.installed ? state.queue.splice(0) : null;
        await state.installing;
        state.installed += 1;
        return undefined;
      },
    },
  });
  return { state, handle };
}

function recorder(preview: ReturnType<typeof fakePreview>, now: () => number = () => Date.now()) {
  const traces = new BrowserPreviewTraceSessions({ preview: () => preview.handle(), now });
  sessions.push(traces);
  return traces;
}

describe("demonstration recorder (feature 20)", () => {
  test("records semantic steps, never values, with path-only routes", async () => {
    const preview = fakePreview();
    const traces = recorder(preview);
    await traces.start("browser-1", "Web app");
    expect(preview.state.installed).toBe(1);
    preview.state.queue.push(
      { action: "click", target: { role: "button", label: "Menu" }, route: "/items" },
      {
        action: "input",
        target: { role: "textbox", label: "Name", text: "" },
        route: "/items?token=secret#x",
        valueOmitted: true,
        value: "hunter2",
      },
      { action: "eval", target: {} },
    );
    traces.mark("browser-1", "The selection disappears");
    const result = await traces.stop("browser-1");
    expect(result.service).toEqual({ label: "Web app", origin: "http://localhost:5173" });
    expect(result.stopReason).toBe("user");
    const actions = result.steps.map((s) => s.action);
    expect(actions).toEqual(["mark", "click", "input"]);
    const input = result.steps.find((s) => s.action === "input")!;
    expect(input.route).toBe("/items");
    expect(input.valueOmitted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.steps.find((s) => s.action === "mark")).toMatchObject({
      wrongHere: true,
      userObservation: "The selection disappears",
    });
  });

  test("stopping after a new document records the navigation without installing fresh listeners", async () => {
    const preview = fakePreview();
    const traces = recorder(preview);
    await traces.start("browser-1", "Web app");
    preview.state.generation = 2;
    preview.state.url = "http://localhost:5173/items/7";
    const result = await traces.stop("browser-1");
    expect(result.steps.at(-1)).toMatchObject({
      action: "navigate",
      route: "/items/7",
      documentSegment: 1,
    });
    expect(preview.state.installed).toBe(1);
  });

  test("leaving the recorded origin stops recording and keeps earlier steps", async () => {
    const preview = fakePreview();
    const traces = recorder(preview);
    await traces.start("browser-1", "Web app");
    preview.state.queue.push({
      action: "click",
      target: { role: "link", label: "Docs" },
      route: "/items",
    });
    expect(traces.status("browser-1").recording).toBe(true);
    preview.state.url = "https://example.com/";
    const result = await traces.stop("browser-1");
    expect(result.stopReason).toBe("left-service");
    expect(result.gaps[0]?.reason).toContain("left the recorded service");
  });

  test("bounds stop recording without discarding earlier steps", async () => {
    let now = 1_000;
    const preview = fakePreview();
    const traces = recorder(preview, () => now);
    await traces.start("browser-1", "Web app");
    for (let i = 0; i < TRACE_BOUNDS.steps + 10; i += 1)
      preview.state.queue.push({ action: "click", target: { role: "button" }, route: "/" });
    const result = await traces.stop("browser-1");
    expect(result.stopReason).toBe("step-limit");
    expect(result.steps).toHaveLength(TRACE_BOUNDS.steps);
    const timed = fakePreview();
    const timedTraces = recorder(timed, () => now);
    await timedTraces.start("browser-2", "Web app");
    now += TRACE_BOUNDS.durationMs + 1;
    expect((await timedTraces.stop("browser-2")).stopReason).toBe("time-limit");
  });

  test("only http(s) previews can be recorded, and closing the preview stops it", async () => {
    const preview = fakePreview("file:///etc/passwd");
    const traces = recorder(preview);
    await expect(traces.start("browser-1", "x")).rejects.toThrow("http(s)");
    const live = fakePreview();
    const liveTraces = recorder(live);
    await liveTraces.start("browser-1", "Web app");
    liveTraces.previewClosed("browser-1");
    expect(liveTraces.status("browser-1")).toMatchObject({
      recording: false,
      stopReason: "preview-closed",
    });
  });
});

test("an overlapping start is refused and stop owns the pending installation", async () => {
  const preview = fakePreview();
  const traces = recorder(preview);
  const installation = Promise.withResolvers<void>();
  preview.state.installing = installation.promise;
  const start = traces.start("tab", "First");
  await expect(traces.start("tab", "Overlapping")).rejects.toThrow("existing recording");
  const stop = traces.stop("tab", true);
  preview.state.generation += 1;
  installation.resolve();
  await start;
  const completed = await stop;
  expect(completed.stopReason).toBe("user");
  expect(traces.status("tab").recording).toBe(false);
  expect(await traces.stop("tab")).toEqual(completed);
  expect((await traces.start("tab", "Second")).recording).toBe(true);
  expect(preview.state.installed).toBe(2);
});

test("a closed preview can be reviewed after its runtime is released", async () => {
  const preview = fakePreview();
  const retained = new Map();
  const oldRuntime = new BrowserPreviewTraceSessions({
    preview: preview.handle,
    retained: () => retained,
  });
  const windowRuntime = new BrowserPreviewTraceSessions({
    preview: () => null,
    retained: () => retained,
  });
  sessions.push(oldRuntime, windowRuntime);
  await oldRuntime.start("preview", "Fixture");
  oldRuntime.mark("preview", "Retained observation");
  oldRuntime.previewClosed("preview");
  oldRuntime.dispose();
  expect(windowRuntime.status("preview")).toMatchObject({
    recording: false,
    stopReason: "preview-closed",
    steps: 1,
  });
  expect((await windowRuntime.stop("preview")).steps[0]?.userObservation).toBe(
    "Retained observation",
  );
  expect(windowRuntime.status("preview").stopReason).toBeNull();
});
