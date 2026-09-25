import { describe, expect, test } from "bun:test";
import {
  decideDesignOpen,
  designOpenChoices,
  planDesignLaunch,
  SPLIT_FALLBACK_MESSAGE,
  type DesignLayoutFacts,
  type DesignTabLike,
} from "./design-open";

const MAX = 4;

function tabs(count: number, extra: DesignTabLike[] = []): DesignTabLike[] {
  return [
    ...Array.from({ length: count }, (_, index) => ({ id: `t${index}`, type: "plain" })),
    ...extra,
  ];
}

function facts(overrides: Partial<DesignLayoutFacts> = {}): DesignLayoutFacts {
  return { tabs: [], maxTabs: MAX, canSplit: true, hasCurrentPane: true, ...overrides };
}

const openCanvas: DesignTabLike = {
  id: "design-1",
  type: "design-canvas",
  designCanvasData: { canvasId: "canvas-a" },
};

describe("decideDesignOpen", () => {
  test("focuses an existing tab even at the tab limit and maximum split depth", () => {
    const decision = decideDesignOpen(
      "canvas-a",
      "split",
      facts({ tabs: tabs(MAX - 1, [openCanvas]), canSplit: false }),
    );
    expect(decision).toEqual({ kind: "focus", tabId: "design-1" });
  });

  test("does not treat another canvas's tab as a match", () => {
    const decision = decideDesignOpen("canvas-b", "current", facts({ tabs: [openCanvas] }));
    expect(decision).toEqual({ kind: "create", placement: "current", fellBack: false });
  });

  test("refuses a new tab at the tab limit, including the current pane", () => {
    for (const placement of ["split", "current"] as const) {
      const decision = decideDesignOpen("canvas-b", placement, facts({ tabs: tabs(MAX) }));
      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") {
        expect(decision.reason).toBe("tab-limit");
        expect(decision.message).toContain("never deletes the design");
      }
    }
  });

  test("falls back to the current pane when split depth prevents a split", () => {
    expect(decideDesignOpen("canvas-b", "split", facts({ canSplit: false }))).toEqual({
      kind: "create",
      placement: "current",
      fellBack: true,
    });
  });

  test("opens beside when a split is possible", () => {
    expect(decideDesignOpen("canvas-b", "split", facts())).toEqual({
      kind: "create",
      placement: "split",
      fellBack: false,
    });
  });

  test("refuses when there is no pane to receive the tab", () => {
    const decision = decideDesignOpen("canvas-b", "current", facts({ hasCurrentPane: false }));
    expect(decision.kind === "refuse" && decision.reason).toBe("no-pane");
  });
});

describe("designOpenChoices", () => {
  test("offers only focus for an open canvas", () => {
    expect(designOpenChoices("canvas-a", facts({ tabs: tabs(MAX - 1, [openCanvas]) }))).toEqual({
      openTabId: "design-1",
      canOpen: true,
      besideFallsBack: false,
    });
  });

  test("explains a split fallback and a full environment", () => {
    expect(designOpenChoices("canvas-b", facts({ canSplit: false }))).toEqual({
      canOpen: true,
      besideFallsBack: true,
      notice: SPLIT_FALLBACK_MESSAGE,
    });
    const full = designOpenChoices("canvas-b", facts({ tabs: tabs(MAX) }));
    expect(full.canOpen).toBe(false);
    expect(full.notice).toContain(`maximum of ${MAX} tabs`);
  });
});

describe("planDesignLaunch", () => {
  test("needs two free tabs with an agent and one without", () => {
    const nearlyFull = facts({ tabs: tabs(MAX - 1) });
    const withAgent = planDesignLaunch({
      environmentReady: true,
      withAgent: true,
      facts: nearlyFull,
    });
    expect(withAgent.ok).toBe(false);
    if (!withAgent.ok) {
      expect(withAgent.reason).toBe("tab-limit");
      expect(withAgent.message).toContain("2 free tabs");
    }
    expect(
      planDesignLaunch({ environmentReady: true, withAgent: false, facts: nearlyFull }),
    ).toEqual({
      ok: true,
      placement: "split",
    });
  });

  test("refuses before creating anything when the environment is not ready", () => {
    const plan = planDesignLaunch({ environmentReady: false, withAgent: false, facts: facts() });
    expect(plan.ok === false && plan.reason).toBe("environment");
  });

  test("falls back to the current pane at maximum split depth", () => {
    expect(
      planDesignLaunch({
        environmentReady: true,
        withAgent: true,
        facts: facts({ canSplit: false }),
      }),
    ).toEqual({ ok: true, placement: "current", notice: SPLIT_FALLBACK_MESSAGE });
  });
});
