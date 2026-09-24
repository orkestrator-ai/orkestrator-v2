/**
 * Pure open/focus/layout decisions for design canvases.
 *
 * The pane store and tab creation live elsewhere; these functions only decide
 * what should happen so the boundaries (tab capacity, split depth, an already
 * open canvas) are unit-testable without mounting a layout.
 */

export type DesignPlacement = "split" | "current";

export interface DesignTabLike {
  id: string;
  type: string;
  designCanvasData?: { canvasId: string };
}

export interface DesignLayoutFacts {
  /** Every tab in the environment, across all panes. */
  tabs: readonly DesignTabLike[];
  maxTabs: number;
  /** The current pane may be split (pane store `canAddTabInSplit`). */
  canSplit: boolean;
  /** A current pane exists to receive a tab. */
  hasCurrentPane: boolean;
}

export type DesignOpenDecision =
  | { kind: "focus"; tabId: string }
  | { kind: "create"; placement: DesignPlacement; fellBack: boolean }
  | { kind: "refuse"; reason: "tab-limit" | "no-pane"; message: string };

export function tabLimitMessage(maxTabs: number, needed = 1): string {
  const room = needed > 1 ? `${needed} free tabs` : "a free tab";
  return `This environment already has the maximum of ${maxTabs} tabs, and this needs ${room}. Close a tab you no longer need — closing a design tab never deletes the design, and you can reopen it from Open.`;
}

export const SPLIT_FALLBACK_MESSAGE =
  "The layout is at its maximum split depth, so the canvas opens as a tab in the current pane.";

export function findDesignCanvasTab(
  tabs: readonly DesignTabLike[],
  canvasId: string,
): DesignTabLike | undefined {
  return tabs.find(
    (tab) => tab.type === "design-canvas" && tab.designCanvasData?.canvasId === canvasId,
  );
}

/**
 * Decides how to show a canvas. An open canvas is always focused, even at the
 * tab limit or maximum split depth, because focusing adds nothing. A new tab
 * never bypasses the tab limit; a split falls back to the current pane.
 */
export function decideDesignOpen(
  canvasId: string,
  placement: DesignPlacement,
  facts: DesignLayoutFacts,
): DesignOpenDecision {
  const existing = findDesignCanvasTab(facts.tabs, canvasId);
  if (existing) return { kind: "focus", tabId: existing.id };
  if (facts.tabs.length >= facts.maxTabs)
    return { kind: "refuse", reason: "tab-limit", message: tabLimitMessage(facts.maxTabs) };
  if (!facts.hasCurrentPane)
    return {
      kind: "refuse",
      reason: "no-pane",
      message: "There is no pane to open the design in.",
    };
  if (placement === "split" && !facts.canSplit)
    return { kind: "create", placement: "current", fellBack: true };
  return { kind: "create", placement, fellBack: false };
}

export interface DesignOpenChoices {
  /** Tab already showing this canvas; the only action needed is focus. */
  openTabId?: string;
  canOpen: boolean;
  /** "Open beside" will actually land in the current pane. */
  besideFallsBack: boolean;
  /** Explanation when opening is blocked or degraded. */
  notice?: string;
}

/** What the library should offer for one canvas. */
export function designOpenChoices(canvasId: string, facts: DesignLayoutFacts): DesignOpenChoices {
  const decision = decideDesignOpen(canvasId, "split", facts);
  if (decision.kind === "focus")
    return { openTabId: decision.tabId, canOpen: true, besideFallsBack: false };
  if (decision.kind === "refuse")
    return { canOpen: false, besideFallsBack: false, notice: decision.message };
  return {
    canOpen: true,
    besideFallsBack: decision.fellBack,
    ...(decision.fellBack ? { notice: SPLIT_FALLBACK_MESSAGE } : {}),
  };
}

export type DesignLaunchPlan =
  | { ok: true; placement: DesignPlacement; notice?: string }
  | { ok: false; reason: "environment" | "tab-limit" | "no-pane"; message: string };

/**
 * Preflight for creating a new design: checked before any durable resource
 * exists so a refusal never leaves an orphan canvas behind.
 */
export function planDesignLaunch(options: {
  environmentReady: boolean;
  withAgent: boolean;
  facts: DesignLayoutFacts;
}): DesignLaunchPlan {
  if (!options.environmentReady)
    return {
      ok: false,
      reason: "environment",
      message: "Start this environment before creating a design workspace.",
    };
  const needed = options.withAgent ? 2 : 1;
  if (options.facts.tabs.length + needed > options.facts.maxTabs)
    return {
      ok: false,
      reason: "tab-limit",
      message: tabLimitMessage(options.facts.maxTabs, needed),
    };
  if (!options.facts.hasCurrentPane)
    return { ok: false, reason: "no-pane", message: "There is no pane to open the design in." };
  if (!options.facts.canSplit)
    return { ok: true, placement: "current", notice: SPLIT_FALLBACK_MESSAGE };
  return { ok: true, placement: "split" };
}
