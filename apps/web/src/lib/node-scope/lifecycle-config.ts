/**
 * Per-host defaults of the node-scope lifecycle (report §8.2, plan item 4002).
 *
 * Every number here is a placeholder: wave 0 (plan item 0004,
 * `docs/reports/unified-federation-measurements.md`) measured the cost of the
 * separate per-node workspace documents of earlier releases (a desktop view
 * 340–410 MB in a development build, a Chromium frame 22–33 MB of JS heap,
 * WebKit 44–171 MB each), not per-scope cost, and has no
 * iPad numbers. The design keeps §8.2's values until measured ones exist, so
 * each is configurable per window (`WindowScopeOptions.lifecycle`).
 *
 * | Host    | Suspend after              | Memory source                         |
 * |---------|----------------------------|---------------------------------------|
 * | desktop | 15 min                     | measured heap, else estimate          |
 * | browser | 5 min                      | `measureUserAgentSpecificMemory`, else heap, else estimate |
 * | ios     | 2 min, and on hidden       | fixed estimate (WebKit exposes none)  |
 */

import { isWkWebViewClient } from "@/lib/client-platform";
import { DEFAULT_WINDOW_BYTE_BUDGETS, type WindowByteBudgets } from "./byte-budget";

export type LifecycleHost = "desktop" | "browser" | "ios";

/**
 * Where a memory reading comes from.
 *
 * - `measured`: `performance.measureUserAgentSpecificMemory()` where the page
 *   may call it (it needs `crossOriginIsolated`), else Chromium's
 *   `performance.memory.usedJSHeapSize`, else the estimate. A reading is the
 *   renderer's whole heap, so the budget is a whole-heap budget.
 * - `estimate`: the window's byte-budget reservations plus a fixed cost per
 *   open node scope (`scopeEstimateBytes`, `suspendedEstimateBytes`). The
 *   budget is then the node scopes' share only. iOS uses this until it is
 *   measured.
 */
export type LifecycleMemorySource = "measured" | "estimate";

export interface LifecycleConfig {
  readonly host: LifecycleHost;
  /** `NODE_SUSPEND_AFTER_MS`: a warm scope hidden this long suspends. */
  readonly suspendAfterMs: number;
  /** Suspend every managed scope when the document becomes hidden (iOS). */
  readonly suspendWhenDocumentHidden: boolean;
  /** Above this reading the pressure path runs (§8.1 "Memory pressure or budget exceeded"). */
  readonly memoryBudgetBytes: number;
  readonly memorySource: LifecycleMemorySource;
  /** Estimated cost of one warm or live node scope (light stores, streams, mounted views). */
  readonly scopeEstimateBytes: number;
  /** Estimated cost of one suspended node scope (light stores only). */
  readonly suspendedEstimateBytes: number;
  /** How often the budget is read while any managed scope is open; `null` only on demand. */
  readonly pressureCheckMs: number | null;
  /** Totals of the window's heavy-data budgets (transcripts, artifacts, images). */
  readonly byteBudgets: Readonly<Record<keyof WindowByteBudgets, number>>;
}

const MIB = 1024 * 1024;
const MINUTE = 60_000;

/**
 * §8.2's placeholders. Desktop and browser keep the byte-budget totals the
 * renderer already had (2001, 3009), so behaviour on those hosts is unchanged
 * until measured; iOS gets half of each.
 */
export const HOST_LIFECYCLE_DEFAULTS: Readonly<Record<LifecycleHost, LifecycleConfig>> = {
  desktop: {
    host: "desktop",
    suspendAfterMs: 15 * MINUTE,
    suspendWhenDocumentHidden: false,
    // "Unlimited within budget": a renderer heap ceiling, not a node count.
    memoryBudgetBytes: 1024 * MIB,
    memorySource: "measured",
    scopeEstimateBytes: 24 * MIB,
    suspendedEstimateBytes: 4 * MIB,
    pressureCheckMs: MINUTE,
    byteBudgets: DEFAULT_WINDOW_BYTE_BUDGETS,
  },
  browser: {
    host: "browser",
    suspendAfterMs: 5 * MINUTE,
    suspendWhenDocumentHidden: false,
    memoryBudgetBytes: 512 * MIB,
    memorySource: "measured",
    scopeEstimateBytes: 24 * MIB,
    suspendedEstimateBytes: 4 * MIB,
    pressureCheckMs: MINUTE,
    byteBudgets: DEFAULT_WINDOW_BYTE_BUDGETS,
  },
  ios: {
    host: "ios",
    suspendAfterMs: 2 * MINUTE,
    suspendWhenDocumentHidden: true,
    // The node scopes' share under the estimate: about four warm nodes.
    memoryBudgetBytes: 128 * MIB,
    memorySource: "estimate",
    scopeEstimateBytes: 24 * MIB,
    suspendedEstimateBytes: 4 * MIB,
    pressureCheckMs: 30_000,
    byteBudgets: {
      transcripts: DEFAULT_WINDOW_BYTE_BUDGETS.transcripts / 2,
      artifacts: DEFAULT_WINDOW_BYTE_BUDGETS.artifacts / 2,
      images: DEFAULT_WINDOW_BYTE_BUDGETS.images / 2,
    },
  },
};

/** Overrides of one host's defaults; `byteBudgets` merges per kind. */
export type LifecycleConfigOverrides = Partial<Omit<LifecycleConfig, "byteBudgets">> & {
  readonly byteBudgets?: Partial<Record<keyof WindowByteBudgets, number>>;
};

/** This renderer's host: the iOS app's WebView, an Electron window, else a browser. */
export function detectLifecycleHost(target: Window | undefined = globalWindow()): LifecycleHost {
  if (!target) return "browser";
  if (isWkWebViewClient(target.__orkestratorClientPlatform)) return "ios";
  if (
    target.orkestratorGateway?.desktop === true ||
    target.orkestratorDesktopHost !== undefined ||
    typeof (target.orkestrator as { node?: unknown } | undefined)?.node === "function"
  ) {
    return "desktop";
  }
  return "browser";
}

/** `host`'s defaults (the detected host when omitted) with `overrides` applied. */
export function lifecycleConfigFor(
  overrides: LifecycleConfigOverrides = {},
  host: LifecycleHost = overrides.host ?? detectLifecycleHost(),
): LifecycleConfig {
  const base = HOST_LIFECYCLE_DEFAULTS[host];
  const config: LifecycleConfig = {
    ...base,
    ...overrides,
    host,
    byteBudgets: { ...base.byteBudgets, ...overrides.byteBudgets },
  };
  for (const [name, value] of Object.entries({
    suspendAfterMs: config.suspendAfterMs,
    memoryBudgetBytes: config.memoryBudgetBytes,
    scopeEstimateBytes: config.scopeEstimateBytes,
    suspendedEstimateBytes: config.suspendedEstimateBytes,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`The node-scope lifecycle needs a non-negative ${name}.`);
    }
  }
  return config;
}

/** A renderer-wide heap reading in bytes, or `null` when this page cannot take one. */
export type HeapReader = () => Promise<number | null>;

interface MemoryPerformance {
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  memory?: { usedJSHeapSize?: number };
}

/**
 * The page's heap reader: `measureUserAgentSpecificMemory` where the page is
 * cross-origin isolated (the API refuses otherwise; 0004 found it unavailable
 * on the hosted page today), else Chromium's `performance.memory`, else none.
 */
export function pageHeapReader(target: Window | undefined = globalWindow()): HeapReader {
  return async () => {
    const performance = target?.performance as (Performance & MemoryPerformance) | undefined;
    if (!performance) return null;
    if (
      target?.crossOriginIsolated === true &&
      typeof performance.measureUserAgentSpecificMemory === "function"
    ) {
      try {
        const reading = await performance.measureUserAgentSpecificMemory();
        if (Number.isFinite(reading.bytes)) return reading.bytes;
      } catch {
        // Refused (not isolated after all, or a frame it cannot measure): fall through.
      }
    }
    const used = performance.memory?.usedJSHeapSize;
    return typeof used === "number" && Number.isFinite(used) ? used : null;
  };
}

function globalWindow(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}
