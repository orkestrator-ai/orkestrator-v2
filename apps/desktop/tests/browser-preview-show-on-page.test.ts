import { describe, expect, test } from "bun:test";
import { fixtureTargets } from "@orkestrator/protocol/web-annotations-fixtures";
import { createHarness, type Json } from "./browser-preview-capture-harness";

const pin = (annotationId: string, route: string, target: unknown = fixtureTargets.element) => ({
  annotationId,
  number: Number(annotationId.split("-")[1]),
  target,
  route,
});

const matched = (annotationId: string) =>
  JSON.stringify({
    revision: 0,
    results: [
      {
        annotationId,
        state: "matched",
        rule: "stable-id",
        candidateCount: 1,
        rect: { x: 1, y: 2, width: 3, height: 4 },
      },
    ],
    diagnostics: null,
  });

const missing = (annotationId: string) =>
  JSON.stringify([{ annotationId, state: "missing", rule: "none", candidateCount: 0, rect: null }]);

describe("pins across document changes", () => {
  test("a same-URL reload clears pins and asks for them again once the document is ready", async () => {
    const harness = createHarness();
    const contents = await harness.attach("http://localhost:5173/settings");
    contents.pinsResponse = () => matched("annotation-1");
    await harness.manager.showPins({
      tabId: "browser-1",
      pins: [pin("annotation-1", "/settings")],
    });
    harness.events.length = 0;

    contents.reloadDocument();
    expect(contents.scripts.at(-1)).toStartWith("/*orkestrator:pins-clear*/");
    expect(harness.events.filter((event) => event.status === "pins-invalidated")).toEqual([]);

    contents.finishLoading();
    const invalidated = harness.events.filter((event) => event.status === "pins-invalidated");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]).toMatchObject({ tabId: "browser-1", captureId: null });
    expect(invalidated[0]!.documentGeneration).toBeGreaterThan(0);
    // The renderer re-sends pins; the new document gets its own layer.
    const results = await harness.manager.showPins({
      tabId: "browser-1",
      pins: [pin("annotation-1", "/settings")],
    });
    expect(results[0]!.resolution.documentGeneration).toBe(invalidated[0]!.documentGeneration);
  });

  test("a hash-route change invalidates pins immediately", async () => {
    const harness = createHarness();
    const contents = await harness.attach("http://localhost:5173/app#/settings");
    contents.pinsResponse = () => matched("annotation-1");
    await harness.manager.showPins({
      tabId: "browser-1",
      pins: [pin("annotation-1", "/app#/settings")],
    });
    contents.navigateInPage("http://localhost:5173/app#/billing");
    expect(harness.events.at(-1)).toMatchObject({ status: "pins-invalidated" });
    // On the new hash route the old note is off-page, not queried in the DOM.
    contents.pinsConfig = null;
    const [result] = await harness.manager.showPins({
      tabId: "browser-1",
      pins: [pin("annotation-1", "/app#/settings")],
    });
    expect(result!.resolution).toMatchObject({
      state: "missing",
      rule: "route-mismatch",
      offPage: true,
    });
    expect(contents.pinsConfig).toBeNull();
  });

  test("live re-resolution results are read back and announced as pins-changed", async () => {
    const harness = createHarness({ manager: { pins: { livePollIntervalMs: 5 } } });
    const contents = await harness.attach("http://localhost:5173/settings");
    contents.pinsResponse = () =>
      JSON.stringify({
        revision: 0,
        results: JSON.parse(missing("annotation-1")),
        diagnostics: null,
      });
    const [initial] = await harness.manager.showPins({
      tabId: "browser-1",
      pins: [pin("annotation-1", "/settings")],
    });
    expect(initial!.resolution.state).toBe("missing");
    contents.pinsSnapshot = JSON.stringify({
      revision: 1,
      results: JSON.parse(matched("annotation-1")).results,
      diagnostics: {
        pins: 1,
        byState: { matched: 1 },
        byRule: { "stable-id": 1 },
        passes: 2,
        mutationBatches: 3,
        throttledBatches: 1,
        budgetExhausted: 0,
        paused: false,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.events.filter((event) => event.status === "pins-changed")).toHaveLength(1);
    const snapshot = (await harness.manager.getPinResults("browser-1"))!;
    expect(snapshot.results[0]!.resolution).toMatchObject({ state: "matched", rect: { x: 1 } });
    expect(snapshot.diagnostics).toMatchObject({ passes: 2, mutationBatches: 3 });
    harness.manager.destroyAll();
  });

  test("region notes are historical once the document or viewport width changed", async () => {
    const harness = createHarness();
    const contents = await harness.attach("http://localhost:5173/settings");
    const region = fixtureTargets.region;
    const generation = (
      await harness.manager.showPins({
        tabId: "browser-1",
        pins: [pin("annotation-1", "/settings", region)],
      })
    )[0]!.resolution.documentGeneration!;
    const results = await harness.manager.showPins({
      tabId: "browser-1",
      pins: [
        // The 800 DIP view at preview zoom 1.25 is 640 CSS pixels wide.
        {
          ...pin("annotation-1", "/settings", region),
          capture: { documentGeneration: generation, viewport: { width: 640, height: 400 } },
        },
        {
          ...pin("annotation-2", "/settings", region),
          capture: { documentGeneration: generation, viewport: { width: 390, height: 800 } },
        },
        {
          ...pin("annotation-3", "/settings", region),
          capture: { documentGeneration: generation - 1, viewport: { width: 800, height: 500 } },
        },
        pin("annotation-4", "/billing", region),
      ],
    });
    expect(results.map((entry) => [entry.resolution.state, entry.resolution.historical])).toEqual([
      ["unsupported", false],
      ["stale", true],
      ["stale", true],
      ["missing", undefined],
    ]);
    expect(contents.pinsConfig).toBeNull();
  });
});

describe("Show on page", () => {
  test("navigates to the stored hash route, waits, resolves, and scrolls the target into view", async () => {
    const harness = createHarness();
    const gateway = "https://gateway.example.invalid/__orkestrator/browser/loopback/3000";
    const contents = await harness.attach(`${gateway}/app#/home`);
    contents.pinsResponse = (queries) => matched(queries[0]!.annotationId);
    const result = await harness.manager.showOnPage({
      tabId: "browser-1",
      pin: pin("annotation-1", "/app#/settings"),
      pins: [pin("annotation-2", "/app#/settings")],
    });
    expect(result).toMatchObject({ outcome: "shown", navigated: true });
    expect(result.resolution).toMatchObject({ state: "matched", rect: { x: 1, y: 2 } });
    expect(contents.loadURL.mock.calls.at(-1)![0]).toBe(`${gateway}/app#/settings`);
    expect(contents.pinsConfig).toMatchObject({
      focusedAnnotationId: "annotation-1",
      scrollIntoView: true,
    });
    expect(contents.pinsConfig!.queries.map((query: Json) => query.annotationId)).toEqual([
      "annotation-1",
      "annotation-2",
    ]);
  });

  test("on the same route it does not navigate, and a late-rendering target is retried", async () => {
    const harness = createHarness();
    const contents = await harness.attach("http://localhost:5173/settings");
    let calls = 0;
    contents.pinsResponse = (queries) =>
      (calls += 1) < 3 ? missing(queries[0]!.annotationId) : matched(queries[0]!.annotationId);
    const loads = contents.loadURL.mock.calls.length;
    const result = await harness.manager.showOnPage({
      tabId: "browser-1",
      pin: pin("annotation-1", "/settings"),
    });
    expect(result).toMatchObject({ outcome: "shown", navigated: false });
    expect(calls).toBe(3);
    expect(contents.loadURL.mock.calls.length).toBe(loads);
  });

  test("an ambiguous target stops at once as not-found; a missing one gives up at the deadline", async () => {
    const harness = createHarness();
    const contents = await harness.attach("http://localhost:5173/settings");
    contents.pinsResponse = (queries) =>
      JSON.stringify([
        {
          annotationId: queries[0]!.annotationId,
          state: "ambiguous",
          rule: "none",
          candidateCount: 2,
          rect: null,
        },
      ]);
    expect(
      await harness.manager.showOnPage({
        tabId: "browser-1",
        pin: pin("annotation-1", "/settings"),
      }),
    ).toMatchObject({ outcome: "not-found", resolution: { state: "ambiguous" } });

    contents.pinsResponse = (queries) => missing(queries[0]!.annotationId);
    const result = await harness.manager.showOnPage({
      tabId: "browser-1",
      pin: pin("annotation-1", "/settings"),
      timeoutMs: 200,
    });
    expect(result).toMatchObject({ outcome: "not-found", resolution: { state: "missing" } });
  });

  test("a redirect away from the route (expired login) asks the user to navigate", async () => {
    const harness = createHarness();
    const contents = await harness.attach("http://localhost:5173/settings");
    contents.redirect = () => "http://localhost:5173/login";
    const result = await harness.manager.showOnPage({
      tabId: "browser-1",
      pin: pin("annotation-1", "/billing"),
    });
    expect(result).toMatchObject({ outcome: "navigation-required", navigated: true });
  });

  test("a hung navigation times out; an unaddressable route is never loaded", async () => {
    const harness = createHarness();
    const contents = await harness.attach("http://localhost:5173/settings");
    contents.hangLoads = true;
    const hung = await harness.manager.showOnPage({
      tabId: "browser-1",
      pin: pin("annotation-1", "/billing"),
      timeoutMs: 150,
    });
    expect(hung).toMatchObject({ outcome: "timeout", navigated: true });

    contents.hangLoads = false;
    const loads = contents.loadURL.mock.calls.length;
    const unsafe = await harness.manager.showOnPage({
      tabId: "browser-1",
      pin: pin("annotation-1", "//evil.example/steal"),
    });
    expect(unsafe).toMatchObject({ outcome: "navigation-required", navigated: false });
    expect(contents.loadURL.mock.calls.length).toBe(loads);
  });
});

describe("responsive capture sets", () => {
  test("captures each width under emulation, labels and links them, and always restores the view", async () => {
    const harness = createHarness();
    const contents = await harness.attach("http://localhost:5173/settings");
    const result = await harness.manager.captureResponsiveSet({
      tabId: "browser-1",
      environmentId: "env-fixture",
      widths: [1280, 390],
    });
    expect(result.failures).toEqual([]);
    expect(contents.emulations.map((entry) => entry.viewSize.width)).toEqual([390, 1280]);
    expect(contents.emulations[1]!.scale).toBeCloseTo(800 / 1.25 / 1280);
    expect(contents.disableDeviceEmulation).toHaveBeenCalledTimes(1);
    expect(contents.emulation).toBeNull();
    expect(
      result.captures.map((descriptor) => [descriptor.targetLabel, descriptor.responsive]),
    ).toEqual([
      ["Page · 390 px", { setId: result.setId, index: 0, count: 2, viewportWidth: 390 }],
      ["Page · 1280 px", { setId: result.setId, index: 1, count: 2, viewportWidth: 1280 }],
    ]);
    const first = (await harness.manager.readPendingCapture(result.captures[0]!.captureId))!;
    expect(first.capture.geometry?.viewport.width).toBe(390);
    expect(first.capture.responsive).toEqual(result.captures[0]!.responsive);
    expect(first.capture.page.route).toBe("/settings");
  });

  test("records the resolved target at each width, or labels it not found", async () => {
    const harness = createHarness();
    const contents = await harness.attach("http://localhost:5173/settings");
    contents.responsiveProbe = (width) => ({
      viewport: { width: width!, height: 500 },
      scroll: { x: 0, y: 0 },
      devicePixelRatio: 2,
      sensitive: [],
      rect: width === 390 ? null : { x: 10, y: 20, width: 30, height: 40 },
      state: width === 390 ? "missing" : "matched",
      stable: true,
    });
    const result = await harness.manager.captureResponsiveSet({
      tabId: "browser-1",
      environmentId: "env-fixture",
      widths: [390, 1024],
      target: fixtureTargets.element,
    });
    expect(result.captures.map((descriptor) => [descriptor.mode, descriptor.targetLabel])).toEqual([
      ["page", `${fixtureTargets.element.label} (not found) · 390 px`],
      ["element", `${fixtureTargets.element.label} · 1024 px`],
    ]);
  });

  test("capacity is reserved for the whole set, and a selection in progress blocks it", async () => {
    const harness = createHarness({ perPreview: 2 });
    const contents = await harness.attach("http://localhost:5173/settings");
    const full = await harness.manager.captureResponsiveSet({
      tabId: "browser-1",
      environmentId: "env-fixture",
      widths: [390, 768, 1280],
    });
    expect(full.captures).toEqual([]);
    expect(full.failures.map((failure) => failure.code)).toEqual([
      "spool-full",
      "spool-full",
      "spool-full",
    ]);
    expect(contents.enableDeviceEmulation).not.toHaveBeenCalled();

    await harness.manager.startCapture({
      tabId: "browser-1",
      mode: "element",
      environmentId: "env-fixture",
    });
    await expect(
      harness.manager.captureResponsiveSet({
        tabId: "browser-1",
        environmentId: "env-fixture",
        widths: [390],
      }),
    ).rejects.toThrow("selection");
    await expect(
      harness.manager.captureResponsiveSet({
        tabId: "browser-1",
        environmentId: "env-fixture",
        widths: [100],
      }),
    ).rejects.toThrow("widths");
  });

  test("a navigation mid-set stops the remaining widths and still restores the view", async () => {
    const harness = createHarness();
    const contents = await harness.attach("http://localhost:5173/settings");
    let shots = 0;
    contents.onCapture = () => {
      shots += 1;
      if (shots === 1) contents.navigateInPage("http://localhost:5173/other");
    };
    const result = await harness.manager.captureResponsiveSet({
      tabId: "browser-1",
      environmentId: "env-fixture",
      widths: [390, 1280],
    });
    expect(result.captures).toEqual([]);
    expect(result.failures).toEqual([
      { viewportWidth: 390, code: "navigation" },
      { viewportWidth: 1280, code: "navigation" },
    ]);
    expect(contents.emulation).toBeNull();
  });
});
